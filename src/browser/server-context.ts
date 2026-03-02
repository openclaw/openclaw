import fs from "node:fs";
import { SsrFBlockedError } from "../infra/net/ssrf.js";
import { fetchOk } from "./cdp.helpers.js";
import { appendCdpPath } from "./cdp.js";
import { isChromeReachable, resolveOpenClawUserDataDir } from "./chrome.js";
import type { ResolvedBrowserProfile } from "./config.js";
import { resolveProfile } from "./config.js";
import { stopChromeExtensionRelayServer } from "./extension-relay.js";
import { InvalidBrowserNavigationUrlError } from "./navigation-guard.js";
import type { PwAiModule } from "./pw-ai-module.js";
import { getPwAiModule } from "./pw-ai-module.js";
import {
  refreshResolvedBrowserConfigFromDisk,
  resolveBrowserProfileWithHotReload,
} from "./resolved-config-refresh.js";
import { createProfileAvailability } from "./server-context.availability.js";
import { createProfileTabOps } from "./server-context.tab-ops.js";
import type {
  BrowserServerState,
  BrowserRouteContext,
  BrowserTab,
  ContextOptions,
  ProfileContext,
  ProfileRuntimeState,
  ProfileStatus,
} from "./server-context.types.js";
import { resolveTargetIdFromTabs } from "./target-id.js";
import { movePathToTrash } from "./trash.js";

export type {
  BrowserRouteContext,
  BrowserServerState,
  BrowserTab,
  ProfileContext,
  ProfileRuntimeState,
  ProfileStatus,
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

  const ensureTabAvailable = async (targetId?: string): Promise<BrowserTab> => {
    await ensureBrowserAvailable();
    const profileState = getProfileState();
    const tabs1 = await listTabs();
    if (tabs1.length === 0) {
      if (profile.driver === "extension") {
        throw new Error(
          `tab not found (no attached Chrome tabs for profile "${profile.name}"). ` +
            "Click the OpenClaw Browser Relay toolbar icon on the tab you want to control (badge ON).",
        );
      }
      await openTab("about:blank");
    }

    const tabs = await listTabs();
    // For remote profiles using Playwright's persistent connection, we don't need wsUrl
    // because we access pages directly through Playwright, not via individual WebSocket URLs.
    const candidates =
      profile.driver === "extension" || !profile.cdpIsLoopback
        ? tabs
        : tabs.filter((t) => Boolean(t.wsUrl));

    const resolveById = (raw: string) => {
      const resolved = resolveTargetIdFromTabs(raw, candidates);
      if (!resolved.ok) {
        if (resolved.reason === "ambiguous") {
          return "AMBIGUOUS" as const;
        }
        return null;
      }
      return candidates.find((t) => t.targetId === resolved.targetId) ?? null;
    };

    const pickDefault = () => {
      const last = profileState.lastTargetId?.trim() || "";
      const lastResolved = last ? resolveById(last) : null;
      if (lastResolved && lastResolved !== "AMBIGUOUS") {
        return lastResolved;
      }
      // Prefer a real page tab first (avoid service workers/background targets).
      const page = candidates.find((t) => (t.type ?? "page") === "page");
      return page ?? candidates.at(0) ?? null;
    };

    let chosen = targetId ? resolveById(targetId) : pickDefault();
    if (
      !chosen &&
      (profile.driver === "extension" || !profile.cdpIsLoopback) &&
      candidates.length === 1
    ) {
      // If an agent passes a stale/foreign targetId but only one candidate remains,
      // recover by using that tab instead of failing hard.
      chosen = candidates[0] ?? null;
    }

    if (chosen === "AMBIGUOUS") {
      throw new Error("ambiguous target id prefix");
    }
    if (!chosen) {
      throw new Error("tab not found");
    }
    profileState.lastTargetId = chosen.targetId;
    return chosen;
  };

  const resolveTargetIdOrThrow = async (targetId: string): Promise<string> => {
    const tabs = await listTabs();
    const resolved = resolveTargetIdFromTabs(targetId, tabs);
    if (!resolved.ok) {
      if (resolved.reason === "ambiguous") {
        throw new Error("ambiguous target id prefix");
      }
      throw new Error("tab not found");
    }
    return resolved.targetId;
  };

  const focusTab = async (targetId: string): Promise<void> => {
    const resolvedTargetId = await resolveTargetIdOrThrow(targetId);

    if (!profile.cdpIsLoopback) {
      const mod = await getPwAiModule({ mode: "strict" });
      const focusPageByTargetIdViaPlaywright = (mod as Partial<PwAiModule> | null)
        ?.focusPageByTargetIdViaPlaywright;
      if (typeof focusPageByTargetIdViaPlaywright === "function") {
        await focusPageByTargetIdViaPlaywright({
          cdpUrl: profile.cdpUrl,
          targetId: resolvedTargetId,
        });
        const profileState = getProfileState();
        profileState.lastTargetId = resolvedTargetId;
        return;
      }
    }

    await fetchOk(appendCdpPath(profile.cdpUrl, `/json/activate/${resolvedTargetId}`));
    const profileState = getProfileState();
    profileState.lastTargetId = resolvedTargetId;
  };

  const closeTab = async (targetId: string): Promise<void> => {
    const resolvedTargetId = await resolveTargetIdOrThrow(targetId);

    // For remote profiles, use Playwright's persistent connection to close tabs
    if (!profile.cdpIsLoopback) {
      const mod = await getPwAiModule({ mode: "strict" });
      const closePageByTargetIdViaPlaywright = (mod as Partial<PwAiModule> | null)
        ?.closePageByTargetIdViaPlaywright;
      if (typeof closePageByTargetIdViaPlaywright === "function") {
        await closePageByTargetIdViaPlaywright({
          cdpUrl: profile.cdpUrl,
          targetId: resolvedTargetId,
        });
        return;
      }
    }

    await fetchOk(appendCdpPath(profile.cdpUrl, `/json/close/${resolvedTargetId}`));
  };

  const resetProfile = async () => {
    if (profile.driver === "extension") {
      await stopChromeExtensionRelayServer({ cdpUrl: profile.cdpUrl }).catch(() => {});
      return { moved: false, from: profile.cdpUrl };
    }
    if (!profile.cdpIsLoopback) {
      throw new Error(
        `reset-profile is only supported for local profiles (profile "${profile.name}" is remote).`,
      );
    }
    const userDataDir = resolveOpenClawUserDataDir(profile.name);
    const profileState = getProfileState();

    const httpReachable = await isHttpReachable(300);
    if (httpReachable && !profileState.running) {
      // Port in use but not by us - kill it
      try {
        const mod = await import("./pw-ai.js");
        await mod.closePlaywrightBrowserConnection();
      } catch {
        // ignore
      }
    }

    if (profileState.running) {
      await stopRunningBrowser();
    }

    try {
      const mod = await import("./pw-ai.js");
      await mod.closePlaywrightBrowserConnection();
    } catch {
      // ignore
    }

    if (!fs.existsSync(userDataDir)) {
      return { moved: false, from: userDataDir };
    }

    const moved = await movePathToTrash(userDataDir);
    return { moved: true, from: userDataDir, to: moved };
  };

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
    openTab: (url) => getDefaultContext().openTab(url),
    focusTab: (targetId) => getDefaultContext().focusTab(targetId),
    closeTab: (targetId) => getDefaultContext().closeTab(targetId),
    stopRunningBrowser: () => getDefaultContext().stopRunningBrowser(),
    resetProfile: () => getDefaultContext().resetProfile(),
    mapTabError,
  };
}
