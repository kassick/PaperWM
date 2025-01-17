/*
  Application functionality, like global new window actions etc.
 */
const ExtensionUtils = imports.misc.extensionUtils;
const Extension = ExtensionUtils.getCurrentExtension();
const ExtensionModule = Extension.imports.extension;
const Kludges = Extension.imports.kludges;
const Tiling = Extension.imports.tiling;
const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const Shell = imports.gi.Shell;

let Tracker = Shell.WindowTracker.get_default();
let CouldNotLaunch = Symbol();

// Lookup table for custom handlers, keys being the app id
var customHandlers, customSpawnHandlers;
function enable() {
    customHandlers = { 'org.gnome.Terminal.desktop': newGnomeTerminal };
    customSpawnHandlers = {
        'com.gexperts.Tilix.desktop': mkCommandLineSpawner('tilix --working-directory %d'),
    };

    function spawnWithFallback(fallback, ...args) {
        try {
            return trySpawnWindow(...args);
        } catch (e) {
            return fallback();
        }
    }

    let overrideWithFallback = Kludges.overrideWithFallback;

    overrideWithFallback(
        Shell.App, "open_new_window",
        (fallback, app, workspaceId) => {
            return spawnWithFallback(fallback, app, global.workspace_manager.get_workspace_by_index(workspaceId));
        }
    );

    overrideWithFallback(
        Shell.App, "launch_action",
        (fallback, app, name, ...args) => {
            if (name === 'new-window')
                return spawnWithFallback(fallback, app);
            else {
                return fallback();
            }
        }
    );

    overrideWithFallback(
        Gio.DesktopAppInfo, "launch",
        (fallback, appInfo) => {
            return spawnWithFallback(fallback, appInfo.get_id());
        }
    );

    overrideWithFallback(
        Gio.DesktopAppInfo, "launch_action",
        (fallback, appInfo, name, ...args) => {
            if (name === 'new-window')
                return spawnWithFallback(fallback, appInfo.get_id());
            else {
                return fallback();
            }
        }
    );
}

function disable() {
    customHandlers = null;
    customSpawnHandlers = null;
}

function launchFromWorkspaceDir(app, workspace = null) {
    if (typeof  app === 'string') {
        app = new Shell.App({ app_info: Gio.DesktopAppInfo.new(app) });
    }
    let dir = getWorkspaceDirectory(workspace);
    let cmd = app.app_info.get_commandline();
    if (!cmd || dir == '') {
        throw CouldNotLaunch;
    }

    /* Note: One would think working directory could be specified in the AppLaunchContext
       The dbus spec https://specifications.freedesktop.org/desktop-entry-spec/1.1/ar01s07.html
       indicates otherwise (for dbus activated actions). Can affect arbitrary environment
       variables of exec activated actions, but no environment variable determine working
       directory of new processes. */
    // TODO: substitute correct values according to https://specifications.freedesktop.org/desktop-entry-spec/desktop-entry-spec-latest.html#exec-variables
    cmd = cmd.replace(/%./g, "");
    let [success, cmdArgs] = GLib.shell_parse_argv(cmd);
    if (!success) {
        console.error("launchFromWorkspaceDir:", "Could not parse command line", cmd);
        throw CouldNotLaunch;
    }
    GLib.spawn_async(dir, cmdArgs, GLib.get_environ(), GLib.SpawnFlags.SEARCH_PATH, null);
}

function newGnomeTerminal(metaWindow, app) {
    /* Note: this action activation is _not_ bound to the window - instead it
       relies on the window being active when called.

       If the new window doesn't start in the same directory it's probably
       because 'vte.sh' haven't been sourced by the shell in this terminal */
    app.action_group.activate_action(
        "win.new-terminal", new GLib.Variant("(ss)", ["window", "current"]));
}

function duplicateWindow(metaWindow) {
    metaWindow = metaWindow || global.display.focus_window;
    let app = Tracker.get_window_app(metaWindow);

    let handler = customHandlers[app.id];
    if (handler) {
        let space = Tiling.spaces.spaceOfWindow(metaWindow);
        return handler(metaWindow, app, space);
    }

    let workspaceId = metaWindow.get_workspace().workspace_index;

    let original = Kludges.getSavedProp(Shell.App.prototype, "open_new_window");
    original.call(app, workspaceId);
    return true;
}

function trySpawnWindow(app, workspace) {
    if (typeof  app === 'string') {
        app = new Shell.App({ app_info: Gio.DesktopAppInfo.new(app) });
    }
    let handler = customSpawnHandlers[app.id];
    if (handler) {
        let space = Tiling.spaces.selectedSpace;
        return handler(app, space);
    } else {
        launchFromWorkspaceDir(app, workspace);
    }
}

function spawnWindow(app, workspace) {
    if (typeof  app === 'string') {
        app = new Shell.App({ app_info: Gio.DesktopAppInfo.new(app) });
    }
    try {
        return trySpawnWindow(app, workspace);
    } catch (e) {
        // Let the overide take care any fallback
        return app.open_new_window(-1);
    }
}

function getWorkspaceDirectory(workspace = null) {
    let space  = workspace ? Tiling.spaces.get(workspace) : Tiling.spaces.selectedSpace;

    let dir = space.settings.get_string("directory");
    if (dir[0] === "~") {
        dir = GLib.getenv("HOME") + dir.slice(1);
    }
    return dir;
}

function expandCommandline(commandline, workspace) {
    let dir = getWorkspaceDirectory(workspace);

    commandline = commandline.replace(/%d/g, () => GLib.shell_quote(dir));

    return commandline;
}

function mkCommandLineSpawner(commandlineTemplate, spawnInWorkspaceDir = false) {
    return (app, space) => {
        let workspace = space.workspace;
        let commandline = expandCommandline(commandlineTemplate, workspace);
        let workingDir = spawnInWorkspaceDir ? getWorkspaceDirectory(workspace) : null;
        let [success, cmdArgs] = GLib.shell_parse_argv(commandline);
        if (success) {
            success = GLib.spawn_async(workingDir, cmdArgs, GLib.get_environ(), GLib.SpawnFlags.SEARCH_PATH, null);
        }
        if (!success) {
            ExtensionModule.notify(
                `Failed to run custom spawn handler for ${app.id}`,
                `Attempted to run '${commandline}'`);
        }
    };
}
