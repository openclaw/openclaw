import { fetchJson, fetchOk, normalizeCdpHttpBaseForJsonEndpoints } from "./cdp.helpers.js";
import { appendCdpPath } from "./cdp.js";
import type { ResolvedBrowserProfile } from "./config.js";
import { BrowserTabNotFoundError, BrowserTargetAmbiguousError } from "./errors.js";
import { getBrowserProfileCapabilities } from "./profile-capabilities.js";
import type { PwAiModule } from "./pw-ai-module.js";
import { getPwAiModule } from "./pw-ai-module.js";
import type { BrowserTab, ProfileRuntimeState } from "./server-context.types.js";
import { resolveTargetIdFromTabs } from "./target-id.js";

const EXTENSION_TARGET_RESOLVE_RETRY_WINDOW_MS = 1200;
const EXTENSION_TARGET_RESOLVE_RETRY_STEP_MS = 150;

type ResolveResult = { kind: "ok"; targetId: string } | { kind: "ambiguous" } | null;

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

  const selectionLog = (
    event: string,
    data: Record<string, unknown>,
    level: "info" | "warn" = "info",
  ) => {
    const payload = {
      ts: new Date().toISOString(),
      profile: profile.name,
      event,
      ...data,
    };
    if (level === "warn") {
      console.warn("[browser-selection]", payload);
      return;
    }
    console.info("[browser-selection]", payload);
  };

  const buildCandidates = (tabs: BrowserTab[]) =>
    capabilities.supportsPerTabWs ? tabs.filter((tab) => Boolean(tab.wsUrl)) : tabs;

  const resolveByIdLocal = (raw: string, candidates: BrowserTab[]) => {
    const resolved = resolveTargetIdFromTabs(raw, candidates);
    if (!resolved.ok) {
      if (resolved.reason === "ambiguous") {
        return "AMBIGUOUS" as const;
      }
      return null;
    }
    return candidates.find((tab) => tab.targetId === resolved.targetId) ?? null;
  };

  const resolveTargetAliasViaRelay = async (raw: string): Promise<string | null> => {
    if (!capabilities.requiresAttachedTab) {
      return null;
    }
    const requested = raw.trim();
    if (!requested) {
      return null;
    }
    const encoded = encodeURIComponent(requested);
    const resolveUrl = appendCdpPath(cdpHttpBase, `/json/resolve/${encoded}`);
    const payload = await fetchJson<{ targetId?: unknown }>(resolveUrl, 1000).catch(() => null);
    const resolved = typeof payload?.targetId === "string" ? payload.targetId.trim() : "";
    if (!resolved) {
      selectionLog("target.alias.lookup", { requested, result: "miss" });
      return null;
    }
    if (resolved !== requested) {
      selectionLog("target.alias.lookup", { requested, resolved, result: "hit" });
    }
    return resolved;
  };

  const resolveTargetIdWithRelayAlias = async (
    rawTargetId: string,
    tabs: BrowserTab[],
  ): Promise<ResolveResult> => {
    const requested = rawTargetId.trim();
    if (!requested) {
      return null;
    }

    let currentTabs = tabs;
    let currentCandidates = buildCandidates(currentTabs);

    const resolveRequested = () => resolveByIdLocal(requested, currentCandidates);
    const resolveAlias = async () => {
      const alias = await resolveTargetAliasViaRelay(requested);
      if (!alias || alias === requested) {
        return null;
      }
      const resolvedAlias = resolveByIdLocal(alias, currentCandidates);
      if (resolvedAlias || resolvedAlias === "AMBIGUOUS") {
        return resolvedAlias;
      }
      const refreshedTabs = await listTabs().catch(() => currentTabs);
      if (refreshedTabs.length > 0) {
        currentTabs = refreshedTabs;
        currentCandidates = buildCandidates(currentTabs);
      }
      return resolveByIdLocal(alias, currentCandidates);
    };

    const initial = resolveRequested();
    if (initial === "AMBIGUOUS") {
      return { kind: "ambiguous" };
    }
    if (initial) {
      return { kind: "ok", targetId: initial.targetId };
    }

    const initialAlias = await resolveAlias();
    if (initialAlias === "AMBIGUOUS") {
      return { kind: "ambiguous" };
    }
    if (initialAlias) {
      return { kind: "ok", targetId: initialAlias.targetId };
    }

    if (!capabilities.requiresAttachedTab) {
      return null;
    }

    if (currentCandidates.length > 0) {
      // When we still have visible candidates but the requested target does not resolve,
      // this is likely a genuinely invalid/stale id, not a transient relay flap.
      return null;
    }

    const deadline = Date.now() + EXTENSION_TARGET_RESOLVE_RETRY_WINDOW_MS;
    selectionLog("target.resolve.retry.start", {
      requested,
      retryWindowMs: EXTENSION_TARGET_RESOLVE_RETRY_WINDOW_MS,
      retryStepMs: EXTENSION_TARGET_RESOLVE_RETRY_STEP_MS,
    });
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, EXTENSION_TARGET_RESOLVE_RETRY_STEP_MS));
      const refreshedTabs = await listTabs().catch(() => currentTabs);
      if (refreshedTabs.length === 0) {
        continue;
      }
      currentTabs = refreshedTabs;
      currentCandidates = buildCandidates(currentTabs);

      const next = resolveRequested();
      if (next === "AMBIGUOUS") {
        return { kind: "ambiguous" };
      }
      if (next) {
        selectionLog("target.resolve.retry.hit", { requested, resolved: next.targetId });
        return { kind: "ok", targetId: next.targetId };
      }

      const aliased = await resolveAlias();
      if (aliased === "AMBIGUOUS") {
        return { kind: "ambiguous" };
      }
      if (aliased) {
        selectionLog("target.resolve.retry.alias-hit", { requested, resolved: aliased.targetId });
        return { kind: "ok", targetId: aliased.targetId };
      }
    }

    selectionLog(
      "target.resolve.retry.exhausted",
      {
        requested,
        classification: "tab-not-found-after-bounded-retry",
      },
      "warn",
    );
    return null;
  };

  const ensureTabAvailable = async (targetId?: string): Promise<BrowserTab> => {
    await ensureBrowserAvailable();
    const profileState = getProfileState();
    let tabs = await listTabs();
    if (tabs.length === 0) {
      if (capabilities.requiresAttachedTab) {
        // Chrome extension relay can briefly drop its WebSocket connection (MV3 service worker
        // lifecycle, relay restart). If we previously had a target selected, wait briefly for
        // the extension to reconnect and re-announce its attached tabs before failing.
        if (profileState.lastTargetId?.trim()) {
          const deadlineAt = Date.now() + 3_000;
          while (tabs.length === 0 && Date.now() < deadlineAt) {
            await new Promise((resolve) => setTimeout(resolve, 200));
            tabs = await listTabs();
          }
        }
        if (tabs.length === 0) {
          throw new BrowserTabNotFoundError(
            `tab not found (no attached Chrome tabs for profile "${profile.name}"). ` +
              "Click the OpenClaw Browser Relay toolbar icon on the tab you want to control (badge ON).",
          );
        }
      } else {
        await openTab("about:blank");
      }
    }

    // Extension profile tabs can flap briefly during redirect/session transitions.
    // Keep the first non-empty read instead of immediately replacing it with another read.
    if (!capabilities.requiresAttachedTab) {
      tabs = await listTabs();
    }
    let candidates = buildCandidates(tabs);

    const pickDefault = () => {
      const last = profileState.lastTargetId?.trim() || "";
      const lastResolved = last ? resolveByIdLocal(last, candidates) : null;
      if (lastResolved && lastResolved !== "AMBIGUOUS") {
        return lastResolved;
      }
      // Prefer a real page tab first (avoid service workers/background targets).
      const page = candidates.find((t) => (t.type ?? "page") === "page");
      return page ?? candidates.at(0) ?? null;
    };

    const resolvedTarget = targetId
      ? await resolveTargetIdWithRelayAlias(targetId, tabs)
      : (() => {
          const chosen = pickDefault();
          if (!chosen) {
            return null;
          }
          return { kind: "ok", targetId: chosen.targetId } as const;
        })();

    if (resolvedTarget?.kind === "ambiguous") {
      throw new BrowserTargetAmbiguousError();
    }
    if (!resolvedTarget || resolvedTarget.kind !== "ok") {
      if (targetId?.trim()) {
        selectionLog(
          "target.resolve.fail",
          {
            requested: targetId.trim(),
            classification: "tab-not-found-while-requested-target-missing",
          },
          "warn",
        );
      }
      throw new BrowserTabNotFoundError();
    }
    const chosen = candidates.find((tab) => tab.targetId === resolvedTarget.targetId);
    if (!chosen) {
      // Last chance refresh in case a retry resolved an alias on a just-refreshed target set.
      const refreshedTabs = await listTabs().catch(() => tabs);
      candidates = buildCandidates(refreshedTabs);
      const refreshedChosen = candidates.find((tab) => tab.targetId === resolvedTarget.targetId);
      if (!refreshedChosen) {
        throw new BrowserTabNotFoundError();
      }
      profileState.lastTargetId = refreshedChosen.targetId;
      return refreshedChosen;
    }
    profileState.lastTargetId = chosen.targetId;
    return chosen;
  };

  const resolveTargetIdOrThrow = async (targetId: string): Promise<string> => {
    const tabs = await listTabs();
    const resolved = await resolveTargetIdWithRelayAlias(targetId, tabs);
    if (resolved?.kind === "ambiguous") {
      throw new BrowserTargetAmbiguousError();
    }
    if (!resolved || resolved.kind !== "ok") {
      selectionLog(
        "target.resolve.fail",
        {
          requested: targetId.trim(),
          classification: "tab-not-found-in-focus-or-close",
        },
        "warn",
      );
      throw new BrowserTabNotFoundError();
    }
    return resolved.targetId;
  };

  const focusTab = async (targetId: string): Promise<void> => {
    const resolvedTargetId = await resolveTargetIdOrThrow(targetId);

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
        return;
      }
    }

    await fetchOk(appendCdpPath(cdpHttpBase, `/json/activate/${resolvedTargetId}`));
    const profileState = getProfileState();
    profileState.lastTargetId = resolvedTargetId;
  };

  const closeTab = async (targetId: string): Promise<void> => {
    const resolvedTargetId = await resolveTargetIdOrThrow(targetId);

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
