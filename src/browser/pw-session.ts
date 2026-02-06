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
import { getHeadersWithAuth } from "./cdp.helpers.js";
import { getChromeWebSocketUrl } from "./chrome.js";

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

// ─────────────────────────────────────────────────────────────────────────────
// Session Context Registry - isolate browser state per agent/session
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Serializable cookie structure matching Playwright's cookie format.
 */
export type SessionCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None";
};

/**
 * Represents an isolated session context for browser operations.
 * Each session can have its own set of role refs, page states, etc.
 */
export type SessionContext = {
  /** Unique session identifier (e.g., agent ID or conversation ID) */
  sessionId: string;
  /** When this session was created */
  createdAt: number;
  /** When this session was last accessed */
  lastAccessedAt: number;
  /** Role refs cache scoped to this session (keyed by cdpUrl::targetId) */
  roleRefsByTarget: Map<string, RoleRefsCacheEntry>;
  /** Per-page state overrides for this session (keyed by cdpUrl::targetId) */
  pageStateOverrides: Map<string, Partial<PageState>>;
  /** Cookies inherited or captured for this session */
  cookies: SessionCookie[];
};

/** Default session ID for backward compatibility with non-session-aware callers */
const DEFAULT_SESSION_ID = "__default__";

/** Session contexts keyed by sessionId */
const sessionContexts = new Map<string, SessionContext>();

/** How long before a session is considered stale (30 minutes) */
const SESSION_STALE_THRESHOLD_MS = 30 * 60 * 1000;

/** Maximum number of sessions to keep in memory */
const MAX_SESSIONS = 100;

/**
 * Get or create a session context for the given session ID.
 * If sessionId is undefined/null, returns the default session for backward compatibility.
 */
export function getOrCreateSessionContext(sessionId?: string | null): SessionContext {
  const id = sessionId?.trim() || DEFAULT_SESSION_ID;
  const existing = sessionContexts.get(id);
  if (existing) {
    existing.lastAccessedAt = Date.now();
    return existing;
  }

  const context: SessionContext = {
    sessionId: id,
    createdAt: Date.now(),
    lastAccessedAt: Date.now(),
    roleRefsByTarget: new Map(),
    pageStateOverrides: new Map(),
    cookies: [],
  };
  sessionContexts.set(id, context);

  // Prevent unbounded growth by cleaning up stale sessions
  if (sessionContexts.size > MAX_SESSIONS) {
    cleanupStaleSessions();
  }

  return context;
}

/**
 * Clean up stale sessions that haven't been accessed recently.
 * Keeps the default session and any session accessed within the threshold.
 */
export function cleanupStaleSessions(): void {
  const now = Date.now();
  const toDelete: string[] = [];

  for (const [id, ctx] of sessionContexts) {
    // Never delete the default session
    if (id === DEFAULT_SESSION_ID) {
      continue;
    }
    // Delete if stale
    if (now - ctx.lastAccessedAt > SESSION_STALE_THRESHOLD_MS) {
      toDelete.push(id);
    }
  }

  for (const id of toDelete) {
    sessionContexts.delete(id);
  }

  // If still over limit after stale cleanup, remove oldest non-default sessions
  if (sessionContexts.size > MAX_SESSIONS) {
    const sorted = [...sessionContexts.entries()]
      .filter(([id]) => id !== DEFAULT_SESSION_ID)
      .sort((a, b) => a[1].lastAccessedAt - b[1].lastAccessedAt);

    const excess = sessionContexts.size - MAX_SESSIONS;
    for (let i = 0; i < excess && i < sorted.length; i++) {
      const entry = sorted[i];
      if (entry) {
        sessionContexts.delete(entry[0]);
      }
    }
  }
}

/**
 * Get all active session IDs (for debugging/monitoring).
 */
export function getActiveSessionIds(): string[] {
  return [...sessionContexts.keys()];
}

/**
 * Delete a specific session context.
 */
export function deleteSessionContext(sessionId: string): boolean {
  if (sessionId === DEFAULT_SESSION_ID) {
    return false; // Cannot delete default session
  }
  return sessionContexts.delete(sessionId);
}

/**
 * Clone a session context to a new session ID.
 * Copies role refs, page state overrides, and cookies from source to target.
 * If source doesn't exist, creates an empty session.
 */
export function cloneSessionContext(
  sourceSessionId: string | null | undefined,
  targetSessionId: string,
): SessionContext {
  const targetId = targetSessionId.trim();
  if (!targetId || targetId === DEFAULT_SESSION_ID) {
    throw new Error("Cannot clone to default session or empty ID");
  }

  const source = getOrCreateSessionContext(sourceSessionId);
  const target: SessionContext = {
    sessionId: targetId,
    createdAt: Date.now(),
    lastAccessedAt: Date.now(),
    // Deep clone the maps
    roleRefsByTarget: new Map(source.roleRefsByTarget),
    pageStateOverrides: new Map(source.pageStateOverrides),
    // Clone cookies array
    cookies: source.cookies.map((c) => ({ ...c })),
  };

  sessionContexts.set(targetId, target);

  // Cleanup if over limit
  if (sessionContexts.size > MAX_SESSIONS) {
    cleanupStaleSessions();
  }

  return target;
}

/**
 * Capture cookies from the browser's default context and store them in a session.
 * This allows new sessions to inherit login state from the browser.
 */
export async function captureCookiesFromBrowser(opts: {
  cdpUrl: string;
  sessionId?: string;
  urls?: string[];
}): Promise<SessionCookie[]> {
  const { browser } = await connectBrowser(opts.cdpUrl);
  const contexts = browser.contexts();
  if (!contexts.length) {
    return [];
  }

  // Get cookies from the first (default) context
  const context = contexts[0];
  const cookies = await context.cookies(opts.urls);

  // Convert to SessionCookie format
  const sessionCookies: SessionCookie[] = cookies.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    expires: c.expires,
    httpOnly: c.httpOnly,
    secure: c.secure,
    sameSite: c.sameSite,
  }));

  // Store in session context
  const sessionCtx = getOrCreateSessionContext(opts.sessionId);
  sessionCtx.cookies = sessionCookies;

  return sessionCookies;
}

/**
 * Apply stored cookies from a session context to the browser.
 * Call this before navigating to restore login state.
 */
export async function applyCookiesToBrowser(opts: {
  cdpUrl: string;
  sessionId?: string;
}): Promise<number> {
  const sessionCtx = getOrCreateSessionContext(opts.sessionId);
  if (!sessionCtx.cookies.length) {
    return 0;
  }

  const { browser } = await connectBrowser(opts.cdpUrl);
  const contexts = browser.contexts();
  if (!contexts.length) {
    return 0;
  }

  const context = contexts[0];
  await context.addCookies(sessionCtx.cookies);

  return sessionCtx.cookies.length;
}

/**
 * Inherit cookies from the default session to a target session.
 * This enables new agent sessions to inherit login state.
 */
export function inheritCookiesFromDefault(targetSessionId: string): SessionCookie[] {
  const targetId = targetSessionId.trim();
  if (!targetId || targetId === DEFAULT_SESSION_ID) {
    return [];
  }

  const defaultSession = getOrCreateSessionContext(null);
  const targetSession = getOrCreateSessionContext(targetId);

  // Clone cookies from default to target
  targetSession.cookies = defaultSession.cookies.map((c) => ({ ...c }));

  return targetSession.cookies;
}

/**
 * Copy cookies from one session to another.
 */
export function copyCookiesBetweenSessions(
  sourceSessionId: string | null | undefined,
  targetSessionId: string,
): SessionCookie[] {
  const targetId = targetSessionId.trim();
  if (!targetId) {
    return [];
  }

  const sourceSession = getOrCreateSessionContext(sourceSessionId);
  const targetSession = getOrCreateSessionContext(targetId);

  // Clone cookies from source to target
  targetSession.cookies = sourceSession.cookies.map((c) => ({ ...c }));

  return targetSession.cookies;
}

/**
 * Get the stored cookies for a session (without applying them).
 */
export function getSessionCookies(sessionId?: string | null): SessionCookie[] {
  const session = getOrCreateSessionContext(sessionId);
  return session.cookies;
}

/**
 * Set cookies directly on a session context.
 */
export function setSessionCookies(
  sessionId: string | null | undefined,
  cookies: SessionCookie[],
): void {
  const session = getOrCreateSessionContext(sessionId);
  session.cookies = cookies.map((c) => ({ ...c }));
}

// ─────────────────────────────────────────────────────────────────────────────

type ContextState = {
  traceActive: boolean;
};

const pageStates = new WeakMap<Page, PageState>();
const contextStates = new WeakMap<BrowserContext, ContextState>();
const observedContexts = new WeakSet<BrowserContext>();
const observedPages = new WeakSet<Page>();

// Best-effort cache to make role refs stable even if Playwright returns a different Page object
// for the same CDP target across requests.
const roleRefsByTarget = new Map<string, RoleRefsCacheEntry>();
const MAX_ROLE_REFS_CACHE = 50;

const MAX_CONSOLE_MESSAGES = 500;
const MAX_PAGE_ERRORS = 200;
const MAX_NETWORK_REQUESTS = 500;

let cached: ConnectedBrowser | null = null;
let connecting: Promise<ConnectedBrowser> | null = null;

function normalizeCdpUrl(raw: string) {
  return raw.replace(/\/$/, "");
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
  sessionId?: string;
}): void {
  const targetId = opts.targetId.trim();
  if (!targetId) {
    return;
  }
  const key = roleRefsKey(opts.cdpUrl, targetId);
  const entry: RoleRefsCacheEntry = {
    refs: opts.refs,
    ...(opts.frameSelector ? { frameSelector: opts.frameSelector } : {}),
    ...(opts.mode ? { mode: opts.mode } : {}),
  };

  // Store in session-scoped cache
  const sessionCtx = getOrCreateSessionContext(opts.sessionId);
  sessionCtx.roleRefsByTarget.set(key, entry);
  while (sessionCtx.roleRefsByTarget.size > MAX_ROLE_REFS_CACHE) {
    const first = sessionCtx.roleRefsByTarget.keys().next();
    if (first.done) {
      break;
    }
    sessionCtx.roleRefsByTarget.delete(first.value);
  }

  // Also store in global cache for backward compatibility with callers
  // that don't pass sessionId (will be deprecated in future)
  roleRefsByTarget.set(key, entry);
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
  sessionId?: string;
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
    sessionId: opts.sessionId,
  });
}

export function restoreRoleRefsForTarget(opts: {
  cdpUrl: string;
  targetId?: string;
  page: Page;
  sessionId?: string;
}): void {
  const targetId = opts.targetId?.trim() || "";
  if (!targetId) {
    return;
  }
  const key = roleRefsKey(opts.cdpUrl, targetId);

  // Try session-scoped cache first
  const sessionCtx = getOrCreateSessionContext(opts.sessionId);
  let cachedEntry = sessionCtx.roleRefsByTarget.get(key);

  // Fall back to global cache for backward compatibility
  if (!cachedEntry) {
    cachedEntry = roleRefsByTarget.get(key);
  }

  if (!cachedEntry) {
    return;
  }
  const state = ensurePageState(opts.page);
  if (state.roleRefs) {
    return;
  }
  state.roleRefs = cachedEntry.refs;
  state.roleRefsFrameSelector = cachedEntry.frameSelector;
  state.roleRefsMode = cachedEntry.mode;
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
      let rec: BrowserNetworkRequest | undefined;
      for (let i = state.requests.length - 1; i >= 0; i -= 1) {
        const candidate = state.requests[i];
        if (candidate && candidate.id === id) {
          rec = candidate;
          break;
        }
      }
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
      let rec: BrowserNetworkRequest | undefined;
      for (let i = state.requests.length - 1; i >= 0; i -= 1) {
        const candidate = state.requests[i];
        if (candidate && candidate.id === id) {
          rec = candidate;
          break;
        }
      }
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

async function connectBrowser(cdpUrl: string): Promise<ConnectedBrowser> {
  const normalized = normalizeCdpUrl(cdpUrl);
  if (cached?.cdpUrl === normalized) {
    return cached;
  }
  if (connecting) {
    return await connecting;
  }

  const connectWithRetry = async (): Promise<ConnectedBrowser> => {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const timeout = 5000 + attempt * 2000;
        const wsUrl = await getChromeWebSocketUrl(normalized, timeout).catch(() => null);
        const endpoint = wsUrl ?? normalized;
        const headers = getHeadersWithAuth(endpoint);
        const browser = await chromium.connectOverCDP(endpoint, { timeout, headers });
        const connected: ConnectedBrowser = { browser, cdpUrl: normalized };
        cached = connected;
        observeBrowser(browser);
        browser.on("disconnected", () => {
          if (cached?.browser === browser) {
            cached = null;
          }
        });
        return connected;
      } catch (err) {
        lastErr = err;
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

  connecting = connectWithRetry().finally(() => {
    connecting = null;
  });

  return await connecting;
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

async function findPageByTargetId(
  browser: Browser,
  targetId: string,
  cdpUrl?: string,
): Promise<Page | null> {
  const pages = await getAllPages(browser);
  // First, try the standard CDP session approach
  for (const page of pages) {
    const tid = await pageTargetId(page).catch(() => null);
    if (tid && tid === targetId) {
      return page;
    }
  }
  // If CDP sessions fail (e.g., extension relay blocks Target.attachToBrowserTarget),
  // fall back to URL-based matching using the /json/list endpoint
  if (cdpUrl) {
    try {
      const baseUrl = cdpUrl
        .replace(/\/+$/, "")
        .replace(/^ws:/, "http:")
        .replace(/\/cdp$/, "");
      const listUrl = `${baseUrl}/json/list`;
      const response = await fetch(listUrl, { headers: getHeadersWithAuth(listUrl) });
      if (response.ok) {
        const targets = (await response.json()) as Array<{
          id: string;
          url: string;
          title?: string;
        }>;
        const target = targets.find((t) => t.id === targetId);
        if (target) {
          // Try to find a page with matching URL
          const urlMatch = pages.filter((p) => p.url() === target.url);
          if (urlMatch.length === 1) {
            return urlMatch[0];
          }
          // If multiple URL matches, use index-based matching as fallback
          // This works when Playwright and the relay enumerate tabs in the same order
          if (urlMatch.length > 1) {
            const sameUrlTargets = targets.filter((t) => t.url === target.url);
            if (sameUrlTargets.length === urlMatch.length) {
              const idx = sameUrlTargets.findIndex((t) => t.id === targetId);
              if (idx >= 0 && idx < urlMatch.length) {
                return urlMatch[idx];
              }
            }
          }
        }
      }
    } catch {
      // Ignore fetch errors and fall through to return null
    }
  }
  return null;
}

export async function getPageForTargetId(opts: {
  cdpUrl: string;
  targetId?: string;
  sessionId?: string;
}): Promise<Page> {
  const { browser } = await connectBrowser(opts.cdpUrl);
  const pages = await getAllPages(browser);
  if (!pages.length) {
    throw new Error("No pages available in the connected browser.");
  }
  const first = pages[0];
  if (!opts.targetId) {
    // Restore role refs from session-scoped cache if available
    restoreRoleRefsForTarget({
      cdpUrl: opts.cdpUrl,
      page: first,
      sessionId: opts.sessionId,
    });
    return first;
  }
  const found = await findPageByTargetId(browser, opts.targetId, opts.cdpUrl);
  if (!found) {
    // Extension relays can block CDP attachment APIs (e.g. Target.attachToBrowserTarget),
    // which prevents us from resolving a page's targetId via newCDPSession(). If Playwright
    // only exposes a single Page, use it as a best-effort fallback.
    if (pages.length === 1) {
      restoreRoleRefsForTarget({
        cdpUrl: opts.cdpUrl,
        page: first,
        sessionId: opts.sessionId,
      });
      return first;
    }
    throw new Error("tab not found");
  }
  // Restore role refs from session-scoped cache
  restoreRoleRefsForTarget({
    cdpUrl: opts.cdpUrl,
    targetId: opts.targetId,
    page: found,
    sessionId: opts.sessionId,
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

export async function closePlaywrightBrowserConnection(): Promise<void> {
  const cur = cached;
  cached = null;
  if (!cur) {
    return;
  }
  await cur.browser.close().catch(() => {});
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
export async function createPageViaPlaywright(opts: { cdpUrl: string; url: string }): Promise<{
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
    await page.goto(targetUrl, { timeout: 30_000 }).catch(() => {
      // Navigation might fail for some URLs, but page is still created
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
  const { browser } = await connectBrowser(opts.cdpUrl);
  const page = await findPageByTargetId(browser, opts.targetId, opts.cdpUrl);
  if (!page) {
    throw new Error("tab not found");
  }
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
  const { browser } = await connectBrowser(opts.cdpUrl);
  const page = await findPageByTargetId(browser, opts.targetId, opts.cdpUrl);
  if (!page) {
    throw new Error("tab not found");
  }
  try {
    await page.bringToFront();
  } catch (err) {
    const session = await page.context().newCDPSession(page);
    try {
      await session.send("Page.bringToFront");
      return;
    } catch {
      throw err;
    } finally {
      await session.detach().catch(() => {});
    }
  }
}
