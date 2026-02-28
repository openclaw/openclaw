import type { ResolvedBrowserConfig } from "./config.js";
import { resolveProfile } from "./config.js";
import { ensureChromeExtensionRelayServer } from "./extension-relay.js";
import {
  type BrowserServerState,
  createBrowserRouteContext,
  listKnownProfileNames,
} from "./server-context.js";

/**
 * Close browser tabs that have been idle longer than `resolved.tabIdleTimeoutMs`.
 * Only affects tabs that were opened through the server (tracked in openedTabs).
 * Errors closing individual tabs are silently ignored.
 */
export async function closeIdleTrackedTabs(params: {
  getState: () => BrowserServerState | null;
  onWarn: (message: string) => void;
}): Promise<void> {
  const current = params.getState();
  if (!current) {
    return;
  }
  const { tabIdleTimeoutMs } = current.resolved;
  if (tabIdleTimeoutMs <= 0) {
    return;
  }
  const ctx = createBrowserRouteContext({ getState: params.getState });
  const now = Date.now();
  for (const [name, profileState] of current.profiles) {
    const openedTabs = profileState.openedTabs;
    if (!openedTabs || openedTabs.size === 0) {
      continue;
    }
    const idleIds = [...openedTabs.entries()]
      .filter(([, info]) => now - info.lastAccessedAt >= tabIdleTimeoutMs)
      .map(([id]) => id);
    for (const targetId of idleIds) {
      try {
        await ctx.forProfile(name).closeTab(targetId);
      } catch {
        // Tab may already be gone; remove stale tracking entry
        openedTabs.delete(targetId);
      }
    }
  }
}

export async function ensureExtensionRelayForProfiles(params: {
  resolved: ResolvedBrowserConfig;
  onWarn: (message: string) => void;
}) {
  for (const name of Object.keys(params.resolved.profiles)) {
    const profile = resolveProfile(params.resolved, name);
    if (!profile || profile.driver !== "extension") {
      continue;
    }
    await ensureChromeExtensionRelayServer({ cdpUrl: profile.cdpUrl }).catch((err) => {
      params.onWarn(`Chrome extension relay init failed for profile "${name}": ${String(err)}`);
    });
  }
}

export async function stopKnownBrowserProfiles(params: {
  getState: () => BrowserServerState | null;
  onWarn: (message: string) => void;
}) {
  const current = params.getState();
  if (!current) {
    return;
  }
  const ctx = createBrowserRouteContext({
    getState: params.getState,
    refreshConfigFromDisk: true,
  });
  try {
    for (const name of listKnownProfileNames(current)) {
      try {
        await ctx.forProfile(name).stopRunningBrowser();
      } catch {
        // ignore
      }
    }
  } catch (err) {
    params.onWarn(`openclaw browser stop failed: ${String(err)}`);
  }
}
