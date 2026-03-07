import type { ResolvedBrowserProfile } from "./config.js";
import type {
  BrowserServerState,
  BrowserRouteContext,
  BrowserTab,
  ContextOptions,
  ProfileContext,
  ProfileRuntimeState,
  ProfileStatus,
  TabMeta,
} from "./server-context.types.js";
import { SsrFBlockedError } from "../infra/net/ssrf.js";
import { isChromeReachable, resolveOpenClawUserDataDir } from "./chrome.js";
import { resolveProfile } from "./config.js";
import { InvalidBrowserNavigationUrlError } from "./navigation-guard.js";
import {
  refreshResolvedBrowserConfigFromDisk,
  resolveBrowserProfileWithHotReload,
} from "./resolved-config-refresh.js";
import { createProfileAvailability } from "./server-context.availability.js";
import { createProfileResetOps } from "./server-context.reset.js";
import { createProfileSelectionOps } from "./server-context.selection.js";
import { createProfileTabOps } from "./server-context.tab-ops.js";
import {
  getTabRegistry as getTabRegistryFromState,
  startIdleTabSweep,
  stopIdleTabSweep,
  touchTab as touchTabInRegistry,
} from "./server-context.tab-registry.js";

export type {
  BrowserRouteContext,
  BrowserServerState,
  BrowserTab,
  ProfileContext,
  ProfileRuntimeState,
  ProfileStatus,
  TabMeta,
} from "./server-context.types.js";

export function listKnownProfileNames(state: BrowserServerState): string[] {
  const names = new Set(Object.keys(state.resolved.profiles));
  for (const name of state.profiles.keys()) {
    names.add(name);
  }
  return [...names];
}

/**
 * Create a profile-scoped context for browser operations.
 */
function createProfileContext(
  opts: ContextOptions,
  profile: ResolvedBrowserProfile,
): ProfileContext {
  const state = () => {
    const current = opts.getState();
    if (!current) {
      throw new Error("Browser server not started");
    }
    return current;
  };

  const getProfileState = (): ProfileRuntimeState => {
    const current = state();
    let profileState = current.profiles.get(profile.name);
    if (!profileState) {
      profileState = { profile, running: null, lastTargetId: null };
      current.profiles.set(profile.name, profileState);
    }
    return profileState;
  };

  const setProfileRunning = (running: ProfileRuntimeState["running"]) => {
    const profileState = getProfileState();
    profileState.running = running;
  };

  const { listTabs, openTab } = createProfileTabOps({
    profile,
    state,
    getProfileState,
  });

  const { ensureBrowserAvailable, isHttpReachable, isReachable, stopRunningBrowser } =
    createProfileAvailability({
      opts,
      profile,
      state,
      getProfileState,
      setProfileRunning,
    });

  const { ensureTabAvailable, focusTab, closeTab, closeTabsByOwner } = createProfileSelectionOps({
    profile,
    getProfileState,
    ensureBrowserAvailable,
    listTabs,
    openTab,
  });

  const { resetProfile: resetProfileInner } = createProfileResetOps({
    profile,
    getProfileState,
    stopRunningBrowser: async () => {
      stopIdleTabSweep(getProfileState());
      return stopRunningBrowser();
    },
    isHttpReachable,
    resolveOpenClawUserDataDir,
  });
  const resetProfile: typeof resetProfileInner = async () => {
    stopIdleTabSweep(getProfileState());
    return resetProfileInner();
  };

  const getTabRegistry = (): Map<string, TabMeta> => getTabRegistryFromState(getProfileState());

  const touchTab = (targetId: string, accessedBy?: string): void =>
    touchTabInRegistry(getProfileState(), targetId, accessedBy);

  // Start idle-tab sweep (no-op on repeated calls for the same profile).
  startIdleTabSweep(getProfileState(), closeTab);

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
    closeTabsByOwner,
    stopRunningBrowser,
    resetProfile,
    getTabRegistry,
    touchTab,
  };
}

export function createBrowserRouteContext(opts: ContextOptions): BrowserRouteContext {
  const refreshConfigFromDisk = opts.refreshConfigFromDisk === true;

  const state = () => {
    const current = opts.getState();
    if (!current) {
      throw new Error("Browser server not started");
    }
    return current;
  };

  const forProfile = (profileName?: string): ProfileContext => {
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

  const listProfiles = async (): Promise<ProfileStatus[]> => {
    const current = state();
    refreshResolvedBrowserConfigFromDisk({
      current,
      refreshConfigFromDisk,
      mode: "cached",
    });
    const result: ProfileStatus[] = [];

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
        } catch {
          // Browser might not be responsive
        }
      } else {
        // Check if something is listening on the port
        try {
          const reachable = await isChromeReachable(profile.cdpUrl, 200);
          if (reachable) {
            running = true;
            const ctx = createProfileContext(opts, profile);
            const tabs = await ctx.listTabs().catch(() => []);
            tabCount = tabs.filter((t) => t.type === "page").length;
          }
        } catch {
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

  const mapTabError = (err: unknown) => {
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
    openTab: (url, ownerId) => getDefaultContext().openTab(url, ownerId),
    focusTab: (targetId) => getDefaultContext().focusTab(targetId),
    closeTab: (targetId) => getDefaultContext().closeTab(targetId),
    closeTabsByOwner: (ownerId) => getDefaultContext().closeTabsByOwner(ownerId),
    stopRunningBrowser: () => getDefaultContext().stopRunningBrowser(),
    resetProfile: () => getDefaultContext().resetProfile(),
    getTabRegistry: () => getDefaultContext().getTabRegistry(),
    touchTab: (targetId, accessedBy) => getDefaultContext().touchTab(targetId, accessedBy),
    mapTabError,
  };
}
