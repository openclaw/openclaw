import type {
  Browser,
  BrowserContext,
  ConsoleMessage,
  Page,
  Request,
  Response,
} from "playwright-core";
import { chromium } from "playwright-core";
import { formatErrorMessage } from "../infra/errors.js";
import type { SsrFPolicy } from "../infra/net/ssrf.js";
import { withNoProxyForCdpUrl } from "./cdp-proxy-bypass.js";
import {
  appendCdpPath,
  fetchJson,
  getHeadersWithAuth,
  normalizeCdpHttpBaseForJsonEndpoints,
  withCdpSocket,
} from "./cdp.helpers.js";
import { normalizeCdpWsUrl } from "./cdp.js";
import { getChromeWebSocketUrl } from "./chrome.js";
import { BrowserTabNotFoundError } from "./errors.js";
import { getChromeExtensionRelayAuthHeaders } from "./extension-relay.js";
import {
  assertBrowserNavigationAllowed,
  assertBrowserNavigationRedirectChainAllowed,
  assertBrowserNavigationResultAllowed,
  withBrowserNavigationPolicy,
} from "./navigation-guard.js";
import { isExtensionRelayCdpEndpoint, withPageScopedCdpClient } from "./pw-session.page-cdp.js";

export type BrowserConsoleMessage = {
  type: string;
  text: string;
  timestamp: string;
  location?: { url?: string; lineNumber?: number; columnNumber?: number };
};

export type BrowserPageError = {
  message: string;
  name?: string;
  stack?: string;
  timestamp: string;
};

export type BrowserNetworkRequest = {
  id: string;
  timestamp: string;
  method: string;
  url: string;
  resourceType?: string;
  status?: number;
  ok?: boolean;
  failureText?: string;
};

type SnapshotForAIResult = { full: string; incremental?: string };
type SnapshotForAIOptions = { timeout?: number; track?: string };

export type WithSnapshotForAI = {
  _snapshotForAI?: (options?: SnapshotForAIOptions) => Promise<SnapshotForAIResult>;
};

type TargetInfoResponse = {
  targetInfo?: {
    targetId?: string;
  };
};

type ConnectedBrowser = {
  browser: Browser;
  cdpUrl: string;
  onDisconnected?: () => void;
};

type PageState = {
  console: BrowserConsoleMessage[];
  errors: BrowserPageError[];
  requests: BrowserNetworkRequest[];
  requestIds: WeakMap<Request, string>;
  nextRequestId: number;
  armIdUpload: number;
  armIdDialog: number;
  armIdDownload: number;
  /**
   * Role-based refs from the last role snapshot (e.g. e1/e2).
   * Mode "role" refs are generated from ariaSnapshot and resolved via getByRole.
   * Mode "aria" refs are Playwright aria-ref ids and resolved via `aria-ref=...`.
   */
  roleRefs?: Record<string, { role: string; name?: string; nth?: number }>;
  roleRefsMode?: "role" | "aria";
  roleRefsFrameSelector?: string;
};

type RoleRefs = NonNullable<PageState["roleRefs"]>;
type RoleRefsCacheEntry = {
  refs: RoleRefs;
  frameSelector?: string;
  mode?: NonNullable<PageState["roleRefsMode"]>;
};

type ContextState = {
  traceActive: boolean;
};

const pageStates = new WeakMap<Page, PageState>();
const contextStates = new WeakMap<BrowserContext, ContextState>();
const observedContexts = new WeakSet<BrowserContext>();
const observedPages = new WeakSet<Page>();
const neutralizedExtensionRelayPages = new WeakSet<Page>();
const inFlightExtensionRelayPageNeutralizations = new WeakMap<Page, Promise<void>>();
const extensionRelayPageNeutralizationCooldownUntil = new WeakMap<Page, number>();

// Best-effort cache to make role refs stable even if Playwright returns a different Page object
// for the same CDP target across requests.
const roleRefsByTarget = new Map<string, RoleRefsCacheEntry>();
const MAX_ROLE_REFS_CACHE = 50;

const MAX_CONSOLE_MESSAGES = 500;
const MAX_PAGE_ERRORS = 200;
const MAX_NETWORK_REQUESTS = 500;
const EXTENSION_RELAY_PAGE_NEUTRALIZE_TIMEOUT_MS = 1_000;
const EXTENSION_RELAY_PAGE_NEUTRALIZE_RETRY_COOLDOWN_MS = 5_000;

const cachedByCdpUrl = new Map<string, ConnectedBrowser>();
const connectingByCdpUrl = new Map<string, Promise<ConnectedBrowser>>();
const connectGenerationByCdpUrl = new Map<string, number>();
const activeConnectCountByCdpUrl = new Map<string, number>();

function normalizeCdpUrl(raw: string) {
  return raw.replace(/\/$/, "");
}

function getConnectGeneration(normalized: string): number {
  return connectGenerationByCdpUrl.get(normalized) ?? 0;
}

function bumpConnectGeneration(normalized: string): number {
  const next = getConnectGeneration(normalized) + 1;
  connectGenerationByCdpUrl.set(normalized, next);
  return next;
}

function hasConnectGenerationChanged(normalized: string, generation: number): boolean {
  return getConnectGeneration(normalized) !== generation;
}

function getActiveConnectCount(normalized: string): number {
  return activeConnectCountByCdpUrl.get(normalized) ?? 0;
}

function beginActiveConnect(normalized: string): void {
  activeConnectCountByCdpUrl.set(normalized, getActiveConnectCount(normalized) + 1);
}

function endActiveConnect(normalized: string): void {
  const next = getActiveConnectCount(normalized) - 1;
  if (next > 0) {
    activeConnectCountByCdpUrl.set(normalized, next);
    return;
  }
  activeConnectCountByCdpUrl.delete(normalized);
}

function pruneConnectGenerationIfIdle(normalized: string): void {
  if (
    cachedByCdpUrl.has(normalized) ||
    connectingByCdpUrl.has(normalized) ||
    getActiveConnectCount(normalized) > 0
  ) {
    return;
  }
  connectGenerationByCdpUrl.delete(normalized);
}

async function withTimeout<T>(work: Promise<T>, ms: number, timeoutMessage: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(timeoutMessage)), ms);
  });
  try {
    return await Promise.race([work, timeoutPromise]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function findNetworkRequestById(state: PageState, id: string): BrowserNetworkRequest | undefined {
  for (let i = state.requests.length - 1; i >= 0; i -= 1) {
    const candidate = state.requests[i];
    if (candidate && candidate.id === id) {
      return candidate;
    }
  }
  return undefined;
}

function roleRefsKey(cdpUrl: string, targetId: string) {
  return `${normalizeCdpUrl(cdpUrl)}::${targetId}`;
}

export function rememberRoleRefsForTarget(opts: {
  cdpUrl: string;
  targetId: string;
  refs: RoleRefs;
  frameSelector?: string;
  mode?: NonNullable<PageState["roleRefsMode"]>;
}): void {
  const targetId = opts.targetId.trim();
  if (!targetId) {
    return;
  }
  roleRefsByTarget.set(roleRefsKey(opts.cdpUrl, targetId), {
    refs: opts.refs,
    ...(opts.frameSelector ? { frameSelector: opts.frameSelector } : {}),
    ...(opts.mode ? { mode: opts.mode } : {}),
  });
  while (roleRefsByTarget.size > MAX_ROLE_REFS_CACHE) {
    const first = roleRefsByTarget.keys().next();
    if (first.done) {
      break;
    }
    roleRefsByTarget.delete(first.value);
  }
}

export function storeRoleRefsForTarget(opts: {
  page: Page;
  cdpUrl: string;
  targetId?: string;
  refs: RoleRefs;
  frameSelector?: string;
  mode: NonNullable<PageState["roleRefsMode"]>;
}): void {
  const state = ensurePageState(opts.page);
  state.roleRefs = opts.refs;
  state.roleRefsFrameSelector = opts.frameSelector;
  state.roleRefsMode = opts.mode;
  if (!opts.targetId?.trim()) {
    return;
  }
  rememberRoleRefsForTarget({
    cdpUrl: opts.cdpUrl,
    targetId: opts.targetId,
    refs: opts.refs,
    frameSelector: opts.frameSelector,
    mode: opts.mode,
  });
}

export function restoreRoleRefsForTarget(opts: {
  cdpUrl: string;
  targetId?: string;
  page: Page;
}): void {
  const targetId = opts.targetId?.trim() || "";
  if (!targetId) {
    return;
  }
  const cached = roleRefsByTarget.get(roleRefsKey(opts.cdpUrl, targetId));
  if (!cached) {
    return;
  }
  const state = ensurePageState(opts.page);
  if (state.roleRefs) {
    return;
  }
  state.roleRefs = cached.refs;
  state.roleRefsFrameSelector = cached.frameSelector;
  state.roleRefsMode = cached.mode;
}

export function ensurePageState(page: Page): PageState {
  const existing = pageStates.get(page);
  if (existing) {
    return existing;
  }

  const state: PageState = {
    console: [],
    errors: [],
    requests: [],
    requestIds: new WeakMap(),
    nextRequestId: 0,
    armIdUpload: 0,
    armIdDialog: 0,
    armIdDownload: 0,
  };
  pageStates.set(page, state);

  if (!observedPages.has(page)) {
    observedPages.add(page);
    page.on("console", (msg: ConsoleMessage) => {
      const entry: BrowserConsoleMessage = {
        type: msg.type(),
        text: msg.text(),
        timestamp: new Date().toISOString(),
        location: msg.location(),
      };
      state.console.push(entry);
      if (state.console.length > MAX_CONSOLE_MESSAGES) {
        state.console.shift();
      }
    });
    page.on("pageerror", (err: Error) => {
      state.errors.push({
        message: err?.message ? String(err.message) : String(err),
        name: err?.name ? String(err.name) : undefined,
        stack: err?.stack ? String(err.stack) : undefined,
        timestamp: new Date().toISOString(),
      });
      if (state.errors.length > MAX_PAGE_ERRORS) {
        state.errors.shift();
      }
    });
    page.on("request", (req: Request) => {
      state.nextRequestId += 1;
      const id = `r${state.nextRequestId}`;
      state.requestIds.set(req, id);
      state.requests.push({
        id,
        timestamp: new Date().toISOString(),
        method: req.method(),
        url: req.url(),
        resourceType: req.resourceType(),
      });
      if (state.requests.length > MAX_NETWORK_REQUESTS) {
        state.requests.shift();
      }
    });
    page.on("response", (resp: Response) => {
      const req = resp.request();
      const id = state.requestIds.get(req);
      if (!id) {
        return;
      }
      const rec = findNetworkRequestById(state, id);
      if (!rec) {
        return;
      }
      rec.status = resp.status();
      rec.ok = resp.ok();
    });
    page.on("requestfailed", (req: Request) => {
      const id = state.requestIds.get(req);
      if (!id) {
        return;
      }
      const rec = findNetworkRequestById(state, id);
      if (!rec) {
        return;
      }
      rec.failureText = req.failure()?.errorText;
      rec.ok = false;
    });
    page.on("close", () => {
      pageStates.delete(page);
      observedPages.delete(page);
    });
  }

  return state;
}

function observeContext(context: BrowserContext) {
  if (observedContexts.has(context)) {
    return;
  }
  observedContexts.add(context);
  ensureContextState(context);

  for (const page of context.pages()) {
    ensurePageState(page);
  }
  context.on("page", (page) => ensurePageState(page));
}

export function ensureContextState(context: BrowserContext): ContextState {
  const existing = contextStates.get(context);
  if (existing) {
    return existing;
  }
  const state: ContextState = { traceActive: false };
  contextStates.set(context, state);
  return state;
}

function observeBrowser(browser: Browser) {
  for (const context of browser.contexts()) {
    observeContext(context);
  }
}

function hasKnownExtensionRelayAuthHint(cdpUrl: string): boolean {
  return Object.keys(getChromeExtensionRelayAuthHeaders(cdpUrl)).length > 0;
}

function isExtensionRelayPageNeutralizationCoolingDown(page: Page): boolean {
  const cooldownUntil = extensionRelayPageNeutralizationCooldownUntil.get(page);
  if (cooldownUntil === undefined) {
    return false;
  }
  if (cooldownUntil <= Date.now()) {
    extensionRelayPageNeutralizationCooldownUntil.delete(page);
    return false;
  }
  return true;
}

async function neutralizeExtensionRelayPageMedia(page: Page, timeoutMs?: number): Promise<void> {
  if (neutralizedExtensionRelayPages.has(page)) {
    return;
  }
  if (isExtensionRelayPageNeutralizationCoolingDown(page)) {
    return;
  }
  if (inFlightExtensionRelayPageNeutralizations.has(page)) {
    return;
  }
  const work = Promise.resolve().then(async () => {
    await page.emulateMedia({ colorScheme: null });
  });
  inFlightExtensionRelayPageNeutralizations.set(page, work);
  void work
    .then(() => {
      neutralizedExtensionRelayPages.add(page);
      extensionRelayPageNeutralizationCooldownUntil.delete(page);
    })
    .catch(() => {
      // Best-effort only; timeout callers may already have moved on.
    })
    .finally(() => {
      if (inFlightExtensionRelayPageNeutralizations.get(page) === work) {
        inFlightExtensionRelayPageNeutralizations.delete(page);
      }
    });
  try {
    if (typeof timeoutMs === "number" && timeoutMs > 0) {
      await withTimeout(work, timeoutMs, "Extension relay neutralization timed out");
    } else {
      await work;
    }
  } catch (error) {
    if (error instanceof Error && error.message === "Extension relay neutralization timed out") {
      extensionRelayPageNeutralizationCooldownUntil.set(
        page,
        Date.now() + EXTENSION_RELAY_PAGE_NEUTRALIZE_RETRY_COOLDOWN_MS,
      );
    }
    // Best-effort only. If the page is mid-navigation or the target is gone,
    // the next request can retry.
  }
}

async function maybeNeutralizeExtensionRelayPages(params: {
  cdpUrl: string;
  pages: Page[];
  timeoutMs?: number;
}): Promise<void> {
  const isExtensionRelay =
    hasKnownExtensionRelayAuthHint(params.cdpUrl) ||
    (await isExtensionRelayCdpEndpoint(params.cdpUrl).catch(() => false));
  if (!isExtensionRelay) {
    return;
  }
  await Promise.allSettled(
    params.pages.map((page) => neutralizeExtensionRelayPageMedia(page, params.timeoutMs)),
  );
}

async function connectBrowser(cdpUrl: string): Promise<ConnectedBrowser> {
  const normalized = normalizeCdpUrl(cdpUrl);
  const cached = cachedByCdpUrl.get(normalized);
  if (cached) {
    return cached;
  }
  const connecting = connectingByCdpUrl.get(normalized);
  if (connecting) {
    return await connecting;
  }
  const generation = getConnectGeneration(normalized);

  const connectWithRetry = async (): Promise<ConnectedBrowser> => {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (hasConnectGenerationChanged(normalized, generation)) {
        throw new Error("CDP browser connection closed during setup");
      }
      try {
        const timeout = 5000 + attempt * 2000;
        const wsUrl = await getChromeWebSocketUrl(normalized, timeout).catch(() => null);
        const endpoint = wsUrl ?? normalized;
        const headers = getHeadersWithAuth(endpoint);
        // Bypass proxy for loopback CDP connections (#31219)
        const browser = await withNoProxyForCdpUrl(endpoint, () =>
          chromium.connectOverCDP(endpoint, { timeout, headers }),
        );
        if (hasConnectGenerationChanged(normalized, generation)) {
          void browser.close().catch(() => {});
          throw new Error("CDP browser connection closed during setup");
        }
        let disconnectedBeforeCache = false;
        const onDisconnected = () => {
          disconnectedBeforeCache = true;
          const current = cachedByCdpUrl.get(normalized);
          if (current?.browser === browser) {
            cachedByCdpUrl.delete(normalized);
          }
          pruneConnectGenerationIfIdle(normalized);
        };
        const connected: ConnectedBrowser = { browser, cdpUrl: normalized, onDisconnected };
        browser.on("disconnected", onDisconnected);
        observeBrowser(browser);
        // Keep callers on connectingByCdpUrl until initial relay neutralization finishes so
        // they do not observe a partially initialized cached browser connection.
        await maybeNeutralizeExtensionRelayPages({
          cdpUrl: normalized,
          pages: await getAllPages(browser),
          timeoutMs: EXTENSION_RELAY_PAGE_NEUTRALIZE_TIMEOUT_MS,
        });
        if (disconnectedBeforeCache) {
          if (typeof browser.off === "function") {
            browser.off("disconnected", onDisconnected);
          }
          throw new Error("CDP browser disconnected during initial setup");
        }
        if (hasConnectGenerationChanged(normalized, generation)) {
          if (typeof browser.off === "function") {
            browser.off("disconnected", onDisconnected);
          }
          void browser.close().catch(() => {});
          throw new Error("CDP browser connection closed during setup");
        }
        cachedByCdpUrl.set(normalized, connected);
        return connected;
      } catch (err) {
        lastErr = err;
        if (hasConnectGenerationChanged(normalized, generation)) {
          break;
        }
        // Don't retry rate-limit errors; retrying worsens the 429.
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg.includes("rate limit")) {
          break;
        }
        const delay = 250 + attempt * 250;
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    if (lastErr instanceof Error) {
      throw lastErr;
    }
    const message = lastErr ? formatErrorMessage(lastErr) : "CDP connect failed";
    throw new Error(message);
  };

  beginActiveConnect(normalized);
  const pending = connectWithRetry().finally(() => {
    connectingByCdpUrl.delete(normalized);
    endActiveConnect(normalized);
    pruneConnectGenerationIfIdle(normalized);
  });
  connectingByCdpUrl.set(normalized, pending);

  return await pending;
}

async function getAllPages(browser: Browser): Promise<Page[]> {
  const contexts = browser.contexts();
  const pages = contexts.flatMap((c) => c.pages());
  return pages;
}

async function pageTargetId(page: Page): Promise<string | null> {
  const session = await page.context().newCDPSession(page);
  try {
    const info = (await session.send("Target.getTargetInfo")) as TargetInfoResponse;
    const targetId = String(info?.targetInfo?.targetId ?? "").trim();
    return targetId || null;
  } finally {
    await session.detach().catch(() => {});
  }
}

function matchPageByTargetList(
  pages: Page[],
  targets: Array<{ id: string; url: string; title?: string }>,
  targetId: string,
): Page | null {
  const target = targets.find((entry) => entry.id === targetId);
  if (!target) {
    return null;
  }

  const urlMatch = pages.filter((page) => page.url() === target.url);
  if (urlMatch.length === 1) {
    return urlMatch[0] ?? null;
  }
  if (urlMatch.length > 1) {
    const sameUrlTargets = targets.filter((entry) => entry.url === target.url);
    if (sameUrlTargets.length === urlMatch.length) {
      const idx = sameUrlTargets.findIndex((entry) => entry.id === targetId);
      if (idx >= 0 && idx < urlMatch.length) {
        return urlMatch[idx] ?? null;
      }
    }
  }
  return null;
}

async function findPageByTargetIdViaTargetList(
  pages: Page[],
  targetId: string,
  cdpUrl: string,
): Promise<Page | null> {
  const cdpHttpBase = normalizeCdpHttpBaseForJsonEndpoints(cdpUrl);
  const targets = await fetchJson<
    Array<{
      id: string;
      url: string;
      title?: string;
    }>
  >(appendCdpPath(cdpHttpBase, "/json/list"), 2000);
  return matchPageByTargetList(pages, targets, targetId);
}

async function findPageByTargetId(
  browser: Browser,
  targetId: string,
  cdpUrl?: string,
): Promise<Page | null> {
  const pages = await getAllPages(browser);
  const isExtensionRelay = cdpUrl
    ? await isExtensionRelayCdpEndpoint(cdpUrl).catch(() => false)
    : false;
  if (cdpUrl && isExtensionRelay) {
    try {
      const matched = await findPageByTargetIdViaTargetList(pages, targetId, cdpUrl);
      if (matched) {
        return matched;
      }
    } catch {
      // Ignore fetch errors and fall through to best-effort single-page fallback.
    }
    return pages.length === 1 ? (pages[0] ?? null) : null;
  }

  let resolvedViaCdp = false;
  for (const page of pages) {
    let tid: string | null = null;
    try {
      tid = await pageTargetId(page);
      resolvedViaCdp = true;
    } catch {
      tid = null;
    }
    if (tid && tid === targetId) {
      return page;
    }
  }
  if (cdpUrl) {
    try {
      return await findPageByTargetIdViaTargetList(pages, targetId, cdpUrl);
    } catch {
      // Ignore fetch errors and fall through to return null.
    }
  }
  if (!resolvedViaCdp && pages.length === 1) {
    return pages[0] ?? null;
  }
  return null;
}

async function resolvePageByTargetIdOrThrow(opts: {
  cdpUrl: string;
  targetId: string;
}): Promise<Page> {
  const { browser } = await connectBrowser(opts.cdpUrl);
  const page = await findPageByTargetId(browser, opts.targetId, opts.cdpUrl);
  if (!page) {
    throw new BrowserTabNotFoundError();
  }
  return page;
}

export async function getPageForTargetId(opts: {
  cdpUrl: string;
  targetId?: string;
}): Promise<Page> {
  const { browser } = await connectBrowser(opts.cdpUrl);
  const pages = await getAllPages(browser);
  if (!pages.length) {
    throw new Error("No pages available in the connected browser.");
  }
  const first = pages[0];
  if (!opts.targetId) {
    await maybeNeutralizeExtensionRelayPages({
      cdpUrl: opts.cdpUrl,
      pages: [first],
      timeoutMs: EXTENSION_RELAY_PAGE_NEUTRALIZE_TIMEOUT_MS,
    });
    return first;
  }
  const found = await findPageByTargetId(browser, opts.targetId, opts.cdpUrl);
  if (!found) {
    // Extension relays can block CDP attachment APIs (e.g. Target.attachToBrowserTarget),
    // which prevents us from resolving a page's targetId via newCDPSession(). If Playwright
    // only exposes a single Page, use it as a best-effort fallback.
    if (pages.length === 1) {
      await maybeNeutralizeExtensionRelayPages({
        cdpUrl: opts.cdpUrl,
        pages: [first],
        timeoutMs: EXTENSION_RELAY_PAGE_NEUTRALIZE_TIMEOUT_MS,
      });
      return first;
    }
    throw new BrowserTabNotFoundError();
  }
  await maybeNeutralizeExtensionRelayPages({
    cdpUrl: opts.cdpUrl,
    pages: [found],
    timeoutMs: EXTENSION_RELAY_PAGE_NEUTRALIZE_TIMEOUT_MS,
  });
  return found;
}

export function refLocator(page: Page, ref: string) {
  const normalized = ref.startsWith("@")
    ? ref.slice(1)
    : ref.startsWith("ref=")
      ? ref.slice(4)
      : ref;

  if (/^e\d+$/.test(normalized)) {
    const state = pageStates.get(page);
    if (state?.roleRefsMode === "aria") {
      const scope = state.roleRefsFrameSelector
        ? page.frameLocator(state.roleRefsFrameSelector)
        : page;
      return scope.locator(`aria-ref=${normalized}`);
    }
    const info = state?.roleRefs?.[normalized];
    if (!info) {
      throw new Error(
        `Unknown ref "${normalized}". Run a new snapshot and use a ref from that snapshot.`,
      );
    }
    const scope = state?.roleRefsFrameSelector
      ? page.frameLocator(state.roleRefsFrameSelector)
      : page;
    const locAny = scope as unknown as {
      getByRole: (
        role: never,
        opts?: { name?: string; exact?: boolean },
      ) => ReturnType<Page["getByRole"]>;
    };
    const locator = info.name
      ? locAny.getByRole(info.role as never, { name: info.name, exact: true })
      : locAny.getByRole(info.role as never);
    return info.nth !== undefined ? locator.nth(info.nth) : locator;
  }

  return page.locator(`aria-ref=${normalized}`);
}

export async function closePlaywrightBrowserConnection(opts?: { cdpUrl?: string }): Promise<void> {
  const normalized = opts?.cdpUrl ? normalizeCdpUrl(opts.cdpUrl) : null;

  if (normalized) {
    const hasCached = cachedByCdpUrl.has(normalized);
    const hasConnecting = connectingByCdpUrl.has(normalized);
    const hasActiveSetup = getActiveConnectCount(normalized) > 0;
    if (hasCached || hasConnecting || hasActiveSetup) {
      bumpConnectGeneration(normalized);
    }
    const cur = cachedByCdpUrl.get(normalized);
    cachedByCdpUrl.delete(normalized);
    connectingByCdpUrl.delete(normalized);
    if (!cur) {
      if (!hasActiveSetup) {
        pruneConnectGenerationIfIdle(normalized);
      }
      return;
    }
    if (cur.onDisconnected && typeof cur.browser.off === "function") {
      cur.browser.off("disconnected", cur.onDisconnected);
    }
    await cur.browser.close().catch(() => {});
    pruneConnectGenerationIfIdle(normalized);
    return;
  }

  const generationsToBump = new Set([
    ...cachedByCdpUrl.keys(),
    ...connectingByCdpUrl.keys(),
    ...activeConnectCountByCdpUrl.keys(),
  ]);
  for (const key of generationsToBump) {
    bumpConnectGeneration(key);
  }
  const connections = Array.from(cachedByCdpUrl.values());
  cachedByCdpUrl.clear();
  connectingByCdpUrl.clear();
  for (const cur of connections) {
    if (cur.onDisconnected && typeof cur.browser.off === "function") {
      cur.browser.off("disconnected", cur.onDisconnected);
    }
    await cur.browser.close().catch(() => {});
  }
  for (const key of Array.from(connectGenerationByCdpUrl.keys())) {
    pruneConnectGenerationIfIdle(key);
  }
}

function cdpSocketNeedsAttach(wsUrl: string): boolean {
  try {
    const pathname = new URL(wsUrl).pathname;
    return (
      pathname === "/cdp" || pathname.endsWith("/cdp") || pathname.includes("/devtools/browser/")
    );
  } catch {
    return false;
  }
}

async function tryTerminateExecutionViaCdp(opts: {
  cdpUrl: string;
  targetId: string;
}): Promise<void> {
  const cdpHttpBase = normalizeCdpHttpBaseForJsonEndpoints(opts.cdpUrl);
  const listUrl = appendCdpPath(cdpHttpBase, "/json/list");

  const pages = await fetchJson<
    Array<{
      id?: string;
      webSocketDebuggerUrl?: string;
    }>
  >(listUrl, 2000).catch(() => null);
  if (!pages || pages.length === 0) {
    return;
  }

  const target = pages.find((p) => String(p.id ?? "").trim() === opts.targetId);
  const wsUrlRaw = String(target?.webSocketDebuggerUrl ?? "").trim();
  if (!wsUrlRaw) {
    return;
  }
  const wsUrl = normalizeCdpWsUrl(wsUrlRaw, cdpHttpBase);
  const needsAttach = cdpSocketNeedsAttach(wsUrl);

  const runWithTimeout = async <T>(work: Promise<T>, ms: number): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("CDP command timed out")), ms);
    });
    try {
      return await Promise.race([work, timeoutPromise]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  };

  await withCdpSocket(
    wsUrl,
    async (send) => {
      let sessionId: string | undefined;
      try {
        if (needsAttach) {
          const attached = (await runWithTimeout(
            send("Target.attachToTarget", { targetId: opts.targetId, flatten: true }),
            1500,
          )) as { sessionId?: unknown };
          if (typeof attached?.sessionId === "string" && attached.sessionId.trim()) {
            sessionId = attached.sessionId;
          }
        }
        await runWithTimeout(send("Runtime.terminateExecution", undefined, sessionId), 1500);
        if (sessionId) {
          // Best-effort cleanup; not required for termination to take effect.
          void send("Target.detachFromTarget", { sessionId }).catch(() => {});
        }
      } catch {
        // Best-effort; ignore
      }
    },
    { handshakeTimeoutMs: 2000 },
  ).catch(() => {});
}

/**
 * Best-effort cancellation for stuck page operations.
 *
 * Playwright serializes CDP commands per page; a long-running or stuck operation (notably evaluate)
 * can block all subsequent commands. We cannot safely "cancel" an individual command, and we do
 * not want to close the actual Chromium tab. Instead, we disconnect Playwright's CDP connection
 * so in-flight commands fail fast and the next request reconnects transparently.
 *
 * IMPORTANT: We CANNOT call Connection.close() because Playwright shares a single Connection
 * across all objects (BrowserType, Browser, etc.). Closing it corrupts the entire Playwright
 * instance, preventing reconnection.
 *
 * Instead we:
 * 1. Null out `cached` so the next call triggers a fresh connectOverCDP
 * 2. Fire-and-forget browser.close() — it may hang but won't block us
 * 3. The next connectBrowser() creates a completely new CDP WebSocket connection
 *
 * The old browser.close() eventually resolves when the in-browser evaluate timeout fires,
 * or the old connection gets GC'd. Either way, it doesn't affect the fresh connection.
 */
export async function forceDisconnectPlaywrightForTarget(opts: {
  cdpUrl: string;
  targetId?: string;
  reason?: string;
}): Promise<void> {
  const normalized = normalizeCdpUrl(opts.cdpUrl);
  const cur = cachedByCdpUrl.get(normalized);
  if (!cur) {
    return;
  }
  cachedByCdpUrl.delete(normalized);
  // Also clear the per-url in-flight connect so the next call does a fresh connectOverCDP
  // rather than awaiting a stale promise.
  connectingByCdpUrl.delete(normalized);
  // Remove the "disconnected" listener to prevent the old browser's teardown
  // from racing with a fresh connection and nulling the new cached entry.
  if (cur.onDisconnected && typeof cur.browser.off === "function") {
    cur.browser.off("disconnected", cur.onDisconnected);
  }

  // Best-effort: kill any stuck JS to unblock the target's execution context before we
  // disconnect Playwright's CDP connection.
  const targetId = opts.targetId?.trim() || "";
  if (targetId) {
    await tryTerminateExecutionViaCdp({ cdpUrl: normalized, targetId }).catch(() => {});
  }

  // Fire-and-forget: don't await because browser.close() may hang on the stuck CDP pipe.
  cur.browser.close().catch(() => {});
}

/**
 * List all pages/tabs from the persistent Playwright connection.
 * Used for remote profiles where HTTP-based /json/list is ephemeral.
 */
export async function listPagesViaPlaywright(opts: { cdpUrl: string }): Promise<
  Array<{
    targetId: string;
    title: string;
    url: string;
    type: string;
  }>
> {
  const { browser } = await connectBrowser(opts.cdpUrl);
  const pages = await getAllPages(browser);
  const results: Array<{
    targetId: string;
    title: string;
    url: string;
    type: string;
  }> = [];

  for (const page of pages) {
    const tid = await pageTargetId(page).catch(() => null);
    if (tid) {
      results.push({
        targetId: tid,
        title: await page.title().catch(() => ""),
        url: page.url(),
        type: "page",
      });
    }
  }
  return results;
}

/**
 * Create a new page/tab using the persistent Playwright connection.
 * Used for remote profiles where HTTP-based /json/new is ephemeral.
 * Returns the new page's targetId and metadata.
 */
export async function createPageViaPlaywright(opts: {
  cdpUrl: string;
  url: string;
  ssrfPolicy?: SsrFPolicy;
}): Promise<{
  targetId: string;
  title: string;
  url: string;
  type: string;
}> {
  const { browser } = await connectBrowser(opts.cdpUrl);
  const context = browser.contexts()[0] ?? (await browser.newContext());
  ensureContextState(context);

  const page = await context.newPage();
  ensurePageState(page);

  // Navigate to the URL
  const targetUrl = opts.url.trim() || "about:blank";
  if (targetUrl !== "about:blank") {
    const navigationPolicy = withBrowserNavigationPolicy(opts.ssrfPolicy);
    await assertBrowserNavigationAllowed({
      url: targetUrl,
      ...navigationPolicy,
    });
    const response = await page.goto(targetUrl, { timeout: 30_000 }).catch(() => {
      // Navigation might fail for some URLs, but page is still created
      return null;
    });
    await assertBrowserNavigationRedirectChainAllowed({
      request: response?.request(),
      ...navigationPolicy,
    });
    await assertBrowserNavigationResultAllowed({
      url: page.url(),
      ...navigationPolicy,
    });
  }

  // Get the targetId for this page
  const tid = await pageTargetId(page).catch(() => null);
  if (!tid) {
    throw new Error("Failed to get targetId for new page");
  }

  return {
    targetId: tid,
    title: await page.title().catch(() => ""),
    url: page.url(),
    type: "page",
  };
}

/**
 * Close a page/tab by targetId using the persistent Playwright connection.
 * Used for remote profiles where HTTP-based /json/close is ephemeral.
 */
export async function closePageByTargetIdViaPlaywright(opts: {
  cdpUrl: string;
  targetId: string;
}): Promise<void> {
  const page = await resolvePageByTargetIdOrThrow(opts);
  await page.close();
}

/**
 * Focus a page/tab by targetId using the persistent Playwright connection.
 * Used for remote profiles where HTTP-based /json/activate can be ephemeral.
 */
export async function focusPageByTargetIdViaPlaywright(opts: {
  cdpUrl: string;
  targetId: string;
}): Promise<void> {
  const page = await resolvePageByTargetIdOrThrow(opts);
  try {
    await page.bringToFront();
  } catch (err) {
    try {
      await withPageScopedCdpClient({
        cdpUrl: opts.cdpUrl,
        page,
        targetId: opts.targetId,
        fn: async (send) => {
          await send("Page.bringToFront");
        },
      });
      return;
    } catch {
      throw err;
    }
  }
}
