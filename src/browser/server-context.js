import { SsrFBlockedError } from "../infra/net/ssrf.js";
import { isChromeReachable, resolveOpenClawUserDataDir } from "./chrome.js";
import { resolveProfile } from "./config.js";
import { InvalidBrowserNavigationUrlError } from "./navigation-guard.js";
import { refreshResolvedBrowserConfigFromDisk, resolveBrowserProfileWithHotReload, } from "./resolved-config-refresh.js";
import { createProfileAvailability } from "./server-context.availability.js";
import { createProfileResetOps } from "./server-context.reset.js";
import { createProfileSelectionOps } from "./server-context.selection.js";
import { createProfileTabOps } from "./server-context.tab-ops.js";
export function listKnownProfileNames(state) {
    const names = new Set(Object.keys(state.resolved.profiles));
    for (const name of state.profiles.keys()) {
        names.add(name);
    }
    return [...names];
}
/**
 * Create a profile-scoped context for browser operations.
 */
function createProfileContext(opts, profile) {
    const state = () => {
        const current = opts.getState();
        if (!current) {
            throw new Error("Browser server not started");
        }
        return current;
    };
    const getProfileState = () => {
        const current = state();
        let profileState = current.profiles.get(profile.name);
        if (!profileState) {
            profileState = { profile, running: null, lastTargetId: null };
            current.profiles.set(profile.name, profileState);
        }
        return profileState;
    };
    const setProfileRunning = (running) => {
        const profileState = getProfileState();
        profileState.running = running;
    };
    const { listTabs, openTab } = createProfileTabOps({
        profile,
        state,
        getProfileState,
    });
    const { ensureBrowserAvailable, isHttpReachable, isReachable, stopRunningBrowser } = createProfileAvailability({
        opts,
        profile,
        state,
        getProfileState,
        setProfileRunning,
    });
    const { ensureTabAvailable, focusTab, closeTab } = createProfileSelectionOps({
        profile,
        getProfileState,
        ensureBrowserAvailable,
        listTabs,
        openTab,
    });
    const { resetProfile } = createProfileResetOps({
        profile,
        getProfileState,
        stopRunningBrowser,
        isHttpReachable,
        resolveOpenClawUserDataDir,
    });
    return {
        profile,
        ensureBrowserAvailable,
        ensureTabAvailable,
        isHttpReachable,
        isReachable,
        listTabs,
        openTab,
        focusTab,
        closeTab,
        stopRunningBrowser,
        resetProfile,
    };
}
export function createBrowserRouteContext(opts) {
    const refreshConfigFromDisk = opts.refreshConfigFromDisk === true;
    const state = () => {
        const current = opts.getState();
        if (!current) {
            throw new Error("Browser server not started");
        }
        return current;
    };
    const forProfile = (profileName) => {
        const current = state();
        const name = profileName ?? current.resolved.defaultProfile;
        const profile = resolveBrowserProfileWithHotReload({
            current,
            refreshConfigFromDisk,
            name,
        });
        if (!profile) {
            const available = Object.keys(current.resolved.profiles).join(", ");
            throw new Error(`Profile "${name}" not found. Available profiles: ${available || "(none)"}`);
        }
        return createProfileContext(opts, profile);
    };
    const listProfiles = async () => {
        const current = state();
        refreshResolvedBrowserConfigFromDisk({
            current,
            refreshConfigFromDisk,
            mode: "cached",
        });
        const result = [];
        for (const name of Object.keys(current.resolved.profiles)) {
            const profileState = current.profiles.get(name);
            const profile = resolveProfile(current.resolved, name);
            if (!profile) {
                continue;
            }
            let tabCount = 0;
            let running = false;
            if (profileState?.running) {
                running = true;
                try {
                    const ctx = createProfileContext(opts, profile);
                    const tabs = await ctx.listTabs();
                    tabCount = tabs.filter((t) => t.type === "page").length;
                }
                catch {
                    // Browser might not be responsive
                }
            }
            else {
                // Check if something is listening on the port
                try {
                    const reachable = await isChromeReachable(profile.cdpUrl, 200);
                    if (reachable) {
                        running = true;
                        const ctx = createProfileContext(opts, profile);
                        const tabs = await ctx.listTabs().catch(() => []);
                        tabCount = tabs.filter((t) => t.type === "page").length;
                    }
                }
                catch {
                    // Not reachable
                }
            }
            result.push({
                name,
                cdpPort: profile.cdpPort,
                cdpUrl: profile.cdpUrl,
                color: profile.color,
                running,
                tabCount,
                isDefault: name === current.resolved.defaultProfile,
                isRemote: !profile.cdpIsLoopback,
            });
        }
        return result;
    };
    // Create default profile context for backward compatibility
    const getDefaultContext = () => forProfile();
    const mapTabError = (err) => {
        if (err instanceof SsrFBlockedError) {
            return { status: 400, message: err.message };
        }
        if (err instanceof InvalidBrowserNavigationUrlError) {
            return { status: 400, message: err.message };
        }
        const msg = String(err);
        if (msg.includes("ambiguous target id prefix")) {
            return { status: 409, message: "ambiguous target id prefix" };
        }
        if (msg.includes("tab not found")) {
            return { status: 404, message: msg };
        }
        if (msg.includes("not found")) {
            return { status: 404, message: msg };
        }
        return null;
    };
    return {
        state,
        forProfile,
        listProfiles,
        // Legacy methods delegate to default profile
        ensureBrowserAvailable: () => getDefaultContext().ensureBrowserAvailable(),
        ensureTabAvailable: (targetId) => getDefaultContext().ensureTabAvailable(targetId),
        isHttpReachable: (timeoutMs) => getDefaultContext().isHttpReachable(timeoutMs),
        isReachable: (timeoutMs) => getDefaultContext().isReachable(timeoutMs),
        listTabs: () => getDefaultContext().listTabs(),
        openTab: (url) => getDefaultContext().openTab(url),
        focusTab: (targetId) => getDefaultContext().focusTab(targetId),
        closeTab: (targetId) => getDefaultContext().closeTab(targetId),
        stopRunningBrowser: () => getDefaultContext().stopRunningBrowser(),
        resetProfile: () => getDefaultContext().resetProfile(),
        mapTabError,
    };
}
