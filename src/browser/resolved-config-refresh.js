import { createConfigIO, loadConfig } from "../config/config.js";
import { resolveBrowserConfig, resolveProfile } from "./config.js";
function applyResolvedConfig(current, freshResolved) {
    current.resolved = freshResolved;
    for (const [name, runtime] of current.profiles) {
        const nextProfile = resolveProfile(freshResolved, name);
        if (nextProfile) {
            runtime.profile = nextProfile;
            continue;
        }
        if (!runtime.running) {
            current.profiles.delete(name);
        }
    }
}
export function refreshResolvedBrowserConfigFromDisk(params) {
    if (!params.refreshConfigFromDisk) {
        return;
    }
    const cfg = params.mode === "fresh" ? createConfigIO().loadConfig() : loadConfig();
    const freshResolved = resolveBrowserConfig(cfg.browser, cfg);
    applyResolvedConfig(params.current, freshResolved);
}
export function resolveBrowserProfileWithHotReload(params) {
    refreshResolvedBrowserConfigFromDisk({
        current: params.current,
        refreshConfigFromDisk: params.refreshConfigFromDisk,
        mode: "cached",
    });
    let profile = resolveProfile(params.current.resolved, params.name);
    if (profile) {
        return profile;
    }
    // Hot-reload: profile missing; retry with a fresh disk read without flushing the global cache.
    refreshResolvedBrowserConfigFromDisk({
        current: params.current,
        refreshConfigFromDisk: params.refreshConfigFromDisk,
        mode: "fresh",
    });
    profile = resolveProfile(params.current.resolved, params.name);
    return profile;
}
