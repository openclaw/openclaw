import { appendFileSync } from "node:fs";
import { CDP_JSON_NEW_TIMEOUT_MS } from "./cdp-timeouts.js";
import { fetchJson, fetchOk, normalizeCdpHttpBaseForJsonEndpoints } from "./cdp.helpers.js";
import { appendCdpPath, createTargetViaCdp, normalizeCdpWsUrl } from "./cdp.js";
import { listChromeMcpTabs, openChromeMcpTab } from "./chrome-mcp.js";
import type { ResolvedBrowserProfile } from "./config.js";
import {
  assertBrowserNavigationAllowed,
  assertBrowserNavigationResultAllowed,
  InvalidBrowserNavigationUrlError,
  requiresInspectableBrowserNavigationRedirects,
  withBrowserNavigationPolicy,
} from "./navigation-guard.js";
import { getBrowserProfileCapabilities } from "./profile-capabilities.js";
import type { PwAiModule } from "./pw-ai-module.js";
import { getPwAiModule } from "./pw-ai-module.js";
import {
  MANAGED_BROWSER_PAGE_TAB_LIMIT,
  OPEN_TAB_DISCOVERY_POLL_MS,
  OPEN_TAB_DISCOVERY_WINDOW_MS,
} from "./server-context.constants.js";
import type {
  BrowserServerState,
  BrowserTab,
  ProfileRuntimeState,
} from "./server-context.types.js";

type TabOpsDeps = {
  profile: ResolvedBrowserProfile;
  state: () => BrowserServerState;
  getProfileState: () => ProfileRuntimeState;
};

type ProfileTabOps = {
  listTabs: () => Promise<BrowserTab[]>;
  openTab: (url: string, timeoutMs?: number) => Promise<BrowserTab>;
};

/**
 * Normalize a CDP WebSocket URL to use the correct base URL.
 */
function normalizeWsUrl(raw: string | undefined, cdpBaseUrl: string): string | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    return normalizeCdpWsUrl(raw, cdpBaseUrl);
  } catch {
    return raw;
  }
}

type CdpTarget = {
  id?: string;
  title?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
  type?: string;
};

type ComparableUrlParts = {
  exact: string;
  origin: string;
  pathname: string;
};

function traceOpenTabStage(stage: string): void {
  const stageLogPath = process.env.OPENCLAW_STAGE_LOG?.trim();
  if (!stageLogPath) {
    return;
  }
  try {
    appendFileSync(stageLogPath, `${new Date().toISOString()} ${stage}\n`);
  } catch {
    // Best-effort tracing only.
  }
}

function normalizeComparableUrl(raw: string | undefined): ComparableUrlParts | null {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const url = new URL(trimmed);
    url.hash = "";
    return {
      exact: url.toString(),
      origin: url.origin,
      pathname: url.pathname || "/",
    };
  } catch {
    return {
      exact: trimmed,
      origin: "",
      pathname: trimmed,
    };
  }
}

export function reconcileOpenedTabCandidate(params: {
  createdTargetId: string;
  requestedUrl?: string;
  createdUrl?: string;
  tabs: BrowserTab[];
}): BrowserTab | null {
  const pageTabs = params.tabs.filter((tab) => (tab.type ?? "page") === "page");
  const created = pageTabs.find((tab) => tab.targetId === params.createdTargetId);
  if (created) {
    return created;
  }

  const candidateUrls = [params.createdUrl, params.requestedUrl]
    .map((value) => normalizeComparableUrl(value))
    .filter((value): value is ComparableUrlParts => value !== null);

  for (const comparable of candidateUrls) {
    const exactMatches = pageTabs.filter((tab) => {
      const normalized = normalizeComparableUrl(tab.url);
      return normalized?.exact === comparable.exact;
    });
    if (exactMatches.length === 1) {
      return exactMatches[0] ?? null;
    }
  }

  for (const comparable of candidateUrls) {
    if (!comparable.origin) {
      continue;
    }
    const originPathMatches = pageTabs.filter((tab) => {
      const normalized = normalizeComparableUrl(tab.url);
      return (
        normalized?.origin === comparable.origin && normalized?.pathname === comparable.pathname
      );
    });
    if (originPathMatches.length === 1) {
      return originPathMatches[0] ?? null;
    }
  }

  if (pageTabs.length === 1) {
    return pageTabs[0] ?? null;
  }

  return null;
}

export function createProfileTabOps({
  profile,
  state,
  getProfileState,
}: TabOpsDeps): ProfileTabOps {
  const cdpHttpBase = normalizeCdpHttpBaseForJsonEndpoints(profile.cdpUrl);
  const capabilities = getBrowserProfileCapabilities(profile);

  const listTabs = async (): Promise<BrowserTab[]> => {
    if (capabilities.usesChromeMcp) {
      return await listChromeMcpTabs(profile.name, profile.userDataDir);
    }

    if (capabilities.usesPersistentPlaywright) {
      const mod = await getPwAiModule({ mode: "strict" });
      const listPagesViaPlaywright = (mod as Partial<PwAiModule> | null)?.listPagesViaPlaywright;
      if (typeof listPagesViaPlaywright === "function") {
        const pages = await listPagesViaPlaywright({ cdpUrl: profile.cdpUrl });
        return pages.map((p) => ({
          targetId: p.targetId,
          title: p.title,
          url: p.url,
          type: p.type,
        }));
      }
    }

    const raw = await fetchJson<
      Array<{
        id?: string;
        title?: string;
        url?: string;
        webSocketDebuggerUrl?: string;
        type?: string;
      }>
    >(appendCdpPath(cdpHttpBase, "/json/list"));
    return raw
      .map((t) => ({
        targetId: t.id ?? "",
        title: t.title ?? "",
        url: t.url ?? "",
        wsUrl: normalizeWsUrl(t.webSocketDebuggerUrl, profile.cdpUrl),
        type: t.type,
      }))
      .filter((t) => Boolean(t.targetId));
  };

  const enforceManagedTabLimit = async (keepTargetId: string): Promise<void> => {
    const profileState = getProfileState();
    if (
      !capabilities.supportsManagedTabLimit ||
      state().resolved.attachOnly ||
      !profileState.running
    ) {
      return;
    }

    const pageTabs = await listTabs()
      .then((tabs) => tabs.filter((tab) => (tab.type ?? "page") === "page"))
      .catch(() => [] as BrowserTab[]);
    if (pageTabs.length <= MANAGED_BROWSER_PAGE_TAB_LIMIT) {
      return;
    }

    const candidates = pageTabs.filter((tab) => tab.targetId !== keepTargetId);
    const excessCount = pageTabs.length - MANAGED_BROWSER_PAGE_TAB_LIMIT;
    for (const tab of candidates.slice(0, excessCount)) {
      void fetchOk(appendCdpPath(cdpHttpBase, `/json/close/${tab.targetId}`)).catch(() => {
        // best-effort cleanup only
      });
    }
  };

  const triggerManagedTabLimit = (keepTargetId: string): void => {
    void enforceManagedTabLimit(keepTargetId).catch(() => {
      // best-effort cleanup only
    });
  };

  const awaitOpenedTabResolution = async (params: {
    createdTargetId: string;
    requestedUrl: string;
    createdUrl?: string;
  }): Promise<BrowserTab | null> => {
    const deadline = Date.now() + OPEN_TAB_DISCOVERY_WINDOW_MS;
    while (Date.now() < deadline) {
      const tabs = await listTabs().catch(() => [] as BrowserTab[]);
      const resolved = reconcileOpenedTabCandidate({
        createdTargetId: params.createdTargetId,
        requestedUrl: params.requestedUrl,
        createdUrl: params.createdUrl,
        tabs,
      });
      if (resolved) {
        traceOpenTabStage(
          `browser-open-tab-resolved profile=${profile.name} createdTargetId=${params.createdTargetId} resolvedTargetId=${resolved.targetId}`,
        );
        return resolved;
      }
      await new Promise((r) => setTimeout(r, OPEN_TAB_DISCOVERY_POLL_MS));
    }
    traceOpenTabStage(
      `browser-open-tab-unresolved profile=${profile.name} createdTargetId=${params.createdTargetId}`,
    );
    return null;
  };

  const openTab = async (url: string, timeoutMs?: number): Promise<BrowserTab> => {
    const ssrfPolicyOpts = withBrowserNavigationPolicy(state().resolved.ssrfPolicy);

    if (capabilities.usesChromeMcp) {
      await assertBrowserNavigationAllowed({ url, ...ssrfPolicyOpts });
      const page =
        typeof timeoutMs === "number"
          ? await openChromeMcpTab(profile.name, url, profile.userDataDir, { timeoutMs })
          : await openChromeMcpTab(profile.name, url, profile.userDataDir);
      const profileState = getProfileState();
      profileState.lastTargetId = page.targetId;
      await assertBrowserNavigationResultAllowed({ url: page.url, ...ssrfPolicyOpts });
      return page;
    }

    if (capabilities.usesPersistentPlaywright) {
      const mod = await getPwAiModule({ mode: "strict" });
      const createPageViaPlaywright = (mod as Partial<PwAiModule> | null)?.createPageViaPlaywright;
      if (typeof createPageViaPlaywright === "function") {
        const page = await createPageViaPlaywright({
          cdpUrl: profile.cdpUrl,
          url,
          timeoutMs,
          ...ssrfPolicyOpts,
        });
        const profileState = getProfileState();
        profileState.lastTargetId = page.targetId;
        triggerManagedTabLimit(page.targetId);
        return {
          targetId: page.targetId,
          title: page.title,
          url: page.url,
          type: page.type,
        };
      }
    }

    if (requiresInspectableBrowserNavigationRedirects(state().resolved.ssrfPolicy)) {
      throw new InvalidBrowserNavigationUrlError(
        "Navigation blocked: strict browser SSRF policy requires Playwright-backed redirect-hop inspection",
      );
    }

    const createdViaCdp = await createTargetViaCdp({
      cdpUrl: profile.cdpUrl,
      url,
      ...ssrfPolicyOpts,
    })
      .then((r) => r.targetId)
      .catch(() => null);

    if (createdViaCdp) {
      traceOpenTabStage(
        `browser-open-tab-created profile=${profile.name} createdTargetId=${createdViaCdp} requestedUrl=${url}`,
      );
      const resolved = await awaitOpenedTabResolution({
        createdTargetId: createdViaCdp,
        requestedUrl: url,
      });
      if (resolved) {
        const profileState = getProfileState();
        profileState.lastTargetId = resolved.targetId;
        await assertBrowserNavigationResultAllowed({ url: resolved.url, ...ssrfPolicyOpts });
        triggerManagedTabLimit(resolved.targetId);
        return resolved;
      }
      const profileState = getProfileState();
      profileState.lastTargetId = createdViaCdp;
      triggerManagedTabLimit(createdViaCdp);
      return { targetId: createdViaCdp, title: "", url, type: "page" };
    }

    const encoded = encodeURIComponent(url);
    const endpointUrl = new URL(appendCdpPath(cdpHttpBase, "/json/new"));
    await assertBrowserNavigationAllowed({ url, ...ssrfPolicyOpts });
    const endpoint = endpointUrl.search
      ? (() => {
          endpointUrl.searchParams.set("url", url);
          return endpointUrl.toString();
        })()
      : `${endpointUrl.toString()}?${encoded}`;
    const created = await fetchJson<CdpTarget>(endpoint, CDP_JSON_NEW_TIMEOUT_MS, {
      method: "PUT",
    }).catch(async (err) => {
      if (String(err).includes("HTTP 405")) {
        return await fetchJson<CdpTarget>(endpoint, CDP_JSON_NEW_TIMEOUT_MS);
      }
      throw err;
    });

    if (!created.id) {
      throw new Error("Failed to open tab (missing id)");
    }
    const resolvedUrl = created.url ?? url;
    traceOpenTabStage(
      `browser-open-tab-created profile=${profile.name} createdTargetId=${created.id} requestedUrl=${url} createdUrl=${resolvedUrl}`,
    );
    const reconciled = await awaitOpenedTabResolution({
      createdTargetId: created.id,
      requestedUrl: url,
      createdUrl: resolvedUrl,
    });
    const finalTab =
      reconciled ??
      ({
        targetId: created.id,
        title: created.title ?? "",
        url: resolvedUrl,
        wsUrl: normalizeWsUrl(created.webSocketDebuggerUrl, profile.cdpUrl),
        type: created.type,
      } satisfies BrowserTab);
    const profileState = getProfileState();
    profileState.lastTargetId = finalTab.targetId;
    await assertBrowserNavigationResultAllowed({ url: finalTab.url, ...ssrfPolicyOpts });
    triggerManagedTabLimit(finalTab.targetId);
    return finalTab;
  };

  return {
    listTabs,
    openTab,
  };
}
