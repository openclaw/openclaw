import { createSubsystemLogger } from "../logging/subsystem.js";
import { fetchOk, normalizeCdpHttpBaseForJsonEndpoints } from "./cdp.helpers.js";
import { appendCdpPath } from "./cdp.js";
import { closeChromeMcpTab, focusChromeMcpTab } from "./chrome-mcp.js";
import type { ResolvedBrowserProfile } from "./config.js";
import { BrowserTabNotFoundError, BrowserTargetAmbiguousError } from "./errors.js";
import { getChromeExtensionRelayAuthHeaders } from "./extension-relay.js";
import { getBrowserProfileCapabilities } from "./profile-capabilities.js";
import type { PwAiModule } from "./pw-ai-module.js";
import { getPwAiModule } from "./pw-ai-module.js";
import type { BrowserTab, ProfileRuntimeState } from "./server-context.types.js";
import { resolveTargetIdFromTabs } from "./target-id.js";

const log = createSubsystemLogger("browser").child("selection");

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
  const cdpHttpBase = normalizeCdpHttpBaseForJsonEndpoints(profile.cdpUrl);
  const capabilities = getBrowserProfileCapabilities(profile);

  const ensureTabAvailable = async (targetId?: string): Promise<BrowserTab> => {
    log.info(`ensureTabAvailable entry`, { targetId: targetId ?? "none" });
    await ensureBrowserAvailable();
    const profileState = getProfileState();
    let tabs1 = await listTabs();
    log.info(`ensureTabAvailable initial listTabs`, { tabCount: tabs1.length });
    if (tabs1.length === 0) {
      if (capabilities.requiresAttachedTab) {
        // [lilac-start] ask extension to attach a tab instead of throwing
        await fetch(appendCdpPath(profile.cdpUrl, "/extension/request-tab-attach"), {
          method: "POST",
          headers: getChromeExtensionRelayAuthHeaders(profile.cdpUrl),
        }).catch(() => {});
        const tabDeadline = Date.now() + 10_000;
        while (Date.now() < tabDeadline) {
          const polled = await listTabs().catch(() => [] as BrowserTab[]);
          if (polled.length > 0) {
            tabs1 = polled;
            break;
          }
          await new Promise((r) => setTimeout(r, 300));
        }
        if (tabs1.length === 0) {
          throw new BrowserTabNotFoundError(
            `tab not found (no attached Chrome tabs for profile "${profile.name}"). ` +
              "Click the OpenClaw Browser Relay toolbar icon on the tab you want to control (badge ON).",
          );
        }
        // [lilac-end]
      } else {
        await openTab("about:blank");
      }
    }

    const tabs = await listTabs();
    log.info(`ensureTabAvailable second listTabs`, { tabCount: tabs.length });
    const candidates = capabilities.supportsPerTabWs ? tabs.filter((t) => Boolean(t.wsUrl)) : tabs;
    log.info(`ensureTabAvailable candidates filtered`, {
      candidateCount: candidates.length,
      candidateTargetIds: candidates.map((t) => t.targetId),
      driver: profile.driver,
      cdpIsLoopback: profile.cdpIsLoopback,
    });

    const resolveById = (raw: string) => {
      log.info(`resolveById called`, { inputTargetId: raw });
      const resolved = resolveTargetIdFromTabs(raw, candidates);
      if (!resolved.ok) {
        if (resolved.reason === "ambiguous") {
          log.warn(`resolveById ambiguous match`, { inputTargetId: raw });
          return "AMBIGUOUS" as const;
        }
        log.warn(`resolveById not found`, { inputTargetId: raw, reason: resolved.reason });
        return null;
      }
      const tab = candidates.find((t) => t.targetId === resolved.targetId) ?? null;
      log.info(`resolveById resolved`, {
        inputTargetId: raw,
        resolvedTargetId: resolved.targetId,
        tabFound: tab !== null,
      });
      return tab;
    };

    const pickDefault = () => {
      const last = profileState.lastTargetId?.trim() || "";
      log.info(`pickDefault called`, { lastTargetId: last || "none" });
      const lastResolved = last ? resolveById(last) : null;
      if (lastResolved && lastResolved !== "AMBIGUOUS") {
        log.info(`pickDefault using lastTargetId`, { resolvedTargetId: lastResolved.targetId });
        return lastResolved;
      }
      // Prefer a real page tab first (avoid service workers/background targets).
      const page = candidates.find((t) => (t.type ?? "page") === "page");
      const fallback = page ?? candidates.at(0) ?? null;
      log.info(`pickDefault fallback`, {
        usedPageType: page !== undefined,
        chosenTargetId: fallback?.targetId ?? "none",
      });
      return fallback;
    };

    let chosen = targetId ? resolveById(targetId) : pickDefault();
    if (
      !chosen &&
      (profile.driver === "extension" || !profile.cdpIsLoopback) &&
      candidates.length === 1
    ) {
      // If an agent passes a stale/foreign targetId but only one candidate remains,
      // recover by using that tab instead of failing hard.
      log.info(`stale targetId recovery: single candidate fallback`, {
        requestedTargetId: targetId ?? "none",
        fallbackTargetId: candidates[0]?.targetId ?? "none",
      });
      chosen = candidates[0] ?? null;
    } else if (!chosen && candidates.length !== 1) {
      log.warn(`stale targetId recovery NOT possible`, {
        requestedTargetId: targetId ?? "none",
        candidateCount: candidates.length,
        candidateTargetIds: candidates.map((t) => t.targetId),
        driver: profile.driver,
        cdpIsLoopback: profile.cdpIsLoopback,
      });
    }

    if (chosen === "AMBIGUOUS") {
      log.error(`ensureTabAvailable throwing: ambiguous target id prefix`, {
        requestedTargetId: targetId ?? "none",
      });
      throw new BrowserTargetAmbiguousError();
    }
    if (!chosen) {
      log.error(`ensureTabAvailable throwing: tab not found`, {
        requestedTargetId: targetId ?? "none",
        lastTargetId: profileState.lastTargetId ?? "none",
        candidateCount: candidates.length,
        candidateTargetIds: candidates.map((t) => t.targetId),
      });
      throw new BrowserTabNotFoundError();
    }
    log.info(`ensureTabAvailable chosen tab`, {
      chosenTargetId: chosen.targetId,
      chosenUrl: chosen.url,
    });
    profileState.lastTargetId = chosen.targetId;
    log.info(`lastTargetId updated`, { lastTargetId: chosen.targetId });
    return chosen;
  };

  const resolveTargetIdOrThrow = async (targetId: string): Promise<string> => {
    log.info(`resolveTargetIdOrThrow called`, { targetId });
    const tabs = await listTabs();
    const resolved = resolveTargetIdFromTabs(targetId, tabs);
    if (!resolved.ok) {
      if (resolved.reason === "ambiguous") {
        log.error(`resolveTargetIdOrThrow: ambiguous`, { targetId });
        throw new BrowserTargetAmbiguousError();
      }
      log.error(`resolveTargetIdOrThrow: tab not found`, {
        targetId,
        tabCount: tabs.length,
        tabTargetIds: tabs.map((t) => t.targetId),
      });
      throw new BrowserTabNotFoundError();
    }
    log.info(`resolveTargetIdOrThrow resolved`, {
      inputTargetId: targetId,
      resolvedTargetId: resolved.targetId,
    });
    return resolved.targetId;
  };

  const focusTab = async (targetId: string): Promise<void> => {
    log.info(`focusTab entry`, { targetId });
    const resolvedTargetId = await resolveTargetIdOrThrow(targetId);

    if (capabilities.usesChromeMcp) {
      await focusChromeMcpTab(profile.name, resolvedTargetId);
      const profileState = getProfileState();
      profileState.lastTargetId = resolvedTargetId;
      return;
    }

    if (capabilities.usesPersistentPlaywright) {
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
        log.info(`focusTab lastTargetId updated (playwright)`, { lastTargetId: resolvedTargetId });
        return;
      }
    }

    await fetchOk(appendCdpPath(cdpHttpBase, `/json/activate/${resolvedTargetId}`));
    const profileState = getProfileState();
    profileState.lastTargetId = resolvedTargetId;
    log.info(`focusTab lastTargetId updated (cdp)`, { lastTargetId: resolvedTargetId });
  };

  const closeTab = async (targetId: string): Promise<void> => {
    log.info(`closeTab entry`, { targetId });
    const resolvedTargetId = await resolveTargetIdOrThrow(targetId);

    if (capabilities.usesChromeMcp) {
      await closeChromeMcpTab(profile.name, resolvedTargetId);
      return;
    }

    // For remote profiles, use Playwright's persistent connection to close tabs
    if (capabilities.usesPersistentPlaywright) {
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

    await fetchOk(appendCdpPath(cdpHttpBase, `/json/close/${resolvedTargetId}`));
  };

  return {
    ensureTabAvailable,
    focusTab,
    closeTab,
  };
}
