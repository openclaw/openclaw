import type { ResolvedBrowserProfile } from "./config.js";
import type { PwAiModule } from "./pw-ai-module.js";
import type { BrowserTab, ProfileRuntimeState } from "./server-context.types.js";
import { fetchOk } from "./cdp.helpers.js";
import { appendCdpPath } from "./cdp.js";
import { getPwAiModule } from "./pw-ai-module.js";
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

  return {
    ensureTabAvailable,
    focusTab,
    closeTab,
  };
}
