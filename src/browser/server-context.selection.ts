import { fetchOk } from "./cdp.helpers.js";
import { appendCdpPath } from "./cdp.js";
import type { ResolvedBrowserProfile } from "./config.js";
import type { PwAiModule } from "./pw-ai-module.js";
import { getPwAiModule } from "./pw-ai-module.js";
import type { BrowserTab, ProfileRuntimeState } from "./server-context.types.js";
import { resolveTargetIdFromTabs } from "./target-id.js";

type SelectionDeps = {
  profile: ResolvedBrowserProfile;
  getProfileState: () => ProfileRuntimeState;
  ensureBrowserAvailable: () => Promise<void>;
  listTabs: () => Promise<BrowserTab[]>;
  openTab: (url: string) => Promise<BrowserTab>;
};

type SelectionOps = {
  ensureTabAvailable: (targetId?: string) => Promise<BrowserTab>;
  focusTab: (targetId: string) => Promise<void>;
  closeTab: (targetId: string) => Promise<void>;
};

export function createProfileSelectionOps({
  profile,
  getProfileState,
  ensureBrowserAvailable,
  listTabs,
  openTab,
}: SelectionDeps): SelectionOps {
  const ensureTabAvailable = async (targetId?: string): Promise<BrowserTab> => {
    await ensureBrowserAvailable();
    const profileState = getProfileState();
    const tabs1 = await listTabs();
    if (tabs1.length === 0) {
      if (profile.driver === "extension") {
        throw new Error(
          `tab not found (no attached Chrome tabs for profile "${profile.name}").\n\n` +
            "Possible causes:\n" +
            "1. No tab attached - Click the OpenClaw Browser Relay toolbar icon on the tab you want to control (badge should show ON)\n" +
            "2. Relay service not started - Run: openclaw browser status\n" +
            "3. Wrong port configured - Extension should use port 18792 (WebSocket), not 18789 (HTTP Gateway)\n\n" +
            "For help, see: https://github.com/openclaw/openclaw/issues/32532",
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

    const { tab, focus } = resolveTargetIdFromTabs(candidates, targetId, profileState);

    if (focus) {
      await focusTab(tab.targetId);
    }

    return tab;
  };

  const focusTab = async (targetId: string): Promise<void> => {
    if (profile.driver === "playwright") {
      const pw = await getPwAiModule();
      await pw.focusTab(targetId);
      return;
    }

    // For extension/CDP profiles, use the CDP activate method
    await fetchOk(
      appendCdpPath(profile.cdpUrl, "/json/activate/" + targetId),
      { method: "GET" },
      `activate tab ${targetId}`,
    );
  };

  const closeTab = async (targetId: string): Promise<void> => {
    if (profile.driver === "playwright") {
      const pw = await getPwAiModule();
      await pw.closeTab(targetId);
      return;
    }

    // For extension/CDP profiles, use the CDP close method
    await fetchOk(
      appendCdpPath(profile.cdpUrl, "/json/close/" + targetId),
      { method: "GET" },
      `close tab ${targetId}`,
    );
  };

  return {
    ensureTabAvailable,
    focusTab,
    closeTab,
  };
}