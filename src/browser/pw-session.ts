import type {
  Browser,
  BrowserContext,
  ConsoleMessage,
  Page,
} from "playwright-core";
import { chromium } from "playwright-core";
import { formatErrorMessage } from "../infra/errors.js";
import { getChromeWebSocketUrl } from "./chrome.js";

export type BrowserConsoleMessage = {
  type: string;
  text: string;
  timestamp: string;
  location?: { url?: string; lineNumber?: number; columnNumber?: number };
};

type SnapshotForAIResult = { full: string; incremental?: string };
type SnapshotForAIOptions = { timeout?: number; track?: string };

export type WithSnapshotForAI = {
  _snapshotForAI?: (
    options?: SnapshotForAIOptions,
  ) => Promise<SnapshotForAIResult>;
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
  armIdUpload: number;
  armIdDialog: number;
  /**
   * Role-based refs from the last role snapshot (e.g. e1/e2).
   * These refs are NOT Playwright's `aria-ref` values.
   */
  roleRefs?: Record<string, { role: string; name?: string; nth?: number }>;
};

const pageStates = new WeakMap<Page, PageState>();
const observedContexts = new WeakSet<BrowserContext>();
const observedPages = new WeakSet<Page>();

const MAX_CONSOLE_MESSAGES = 500;

let cached: ConnectedBrowser | null = null;
let connecting: Promise<ConnectedBrowser> | null = null;

function normalizeCdpUrl(raw: string) {
  return raw.replace(/\/$/, "");
}

export function ensurePageState(page: Page): PageState {
  const existing = pageStates.get(page);
  if (existing) return existing;

  const state: PageState = {
    console: [],
    armIdUpload: 0,
    armIdDialog: 0,
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
      if (state.console.length > MAX_CONSOLE_MESSAGES) state.console.shift();
    });
    page.on("close", () => {
      pageStates.delete(page);
      observedPages.delete(page);
    });
  }

  return state;
}

function observeContext(context: BrowserContext) {
  if (observedContexts.has(context)) return;
  observedContexts.add(context);

  for (const page of context.pages()) ensurePageState(page);
  context.on("page", (page) => ensurePageState(page));
}

function observeBrowser(browser: Browser) {
  for (const context of browser.contexts()) observeContext(context);
}

async function connectBrowser(cdpUrl: string): Promise<ConnectedBrowser> {
  const normalized = normalizeCdpUrl(cdpUrl);
  if (cached?.cdpUrl === normalized) return cached;
  if (connecting) return await connecting;

  const connectWithRetry = async (): Promise<ConnectedBrowser> => {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const timeout = 5000 + attempt * 2000;
        const wsUrl = await getChromeWebSocketUrl(normalized, timeout).catch(
          () => null,
        );
        const endpoint = wsUrl ?? normalized;
        const browser = await chromium.connectOverCDP(endpoint, { timeout });
        const connected: ConnectedBrowser = { browser, cdpUrl: normalized };
        cached = connected;
        observeBrowser(browser);
        browser.on("disconnected", () => {
          if (cached?.browser === browser) cached = null;
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
    const message = lastErr
      ? formatErrorMessage(lastErr)
      : "CDP connect failed";
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
    const info = (await session.send(
      "Target.getTargetInfo",
    )) as TargetInfoResponse;
    const targetId = String(info?.targetInfo?.targetId ?? "").trim();
    return targetId || null;
  } finally {
    await session.detach().catch(() => {});
  }
}

async function findPageByTargetId(
  browser: Browser,
  targetId: string,
): Promise<Page | null> {
  const pages = await getAllPages(browser);
  for (const page of pages) {
    const tid = await pageTargetId(page).catch(() => null);
    if (tid && tid === targetId) return page;
  }
  return null;
}

export async function getPageForTargetId(opts: {
  cdpUrl: string;
  targetId?: string;
}): Promise<Page> {
  const { browser } = await connectBrowser(opts.cdpUrl);
  const pages = await getAllPages(browser);
  if (!pages.length)
    throw new Error("No pages available in the connected browser.");
  const first = pages[0];
  if (!opts.targetId) return first;
  const found = await findPageByTargetId(browser, opts.targetId);
  if (!found) throw new Error("tab not found");
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
    const info = state?.roleRefs?.[normalized];
    if (!info) {
      throw new Error(
        `Unknown ref "${normalized}". Run a new snapshot and use a ref from that snapshot.`,
      );
    }
    const locator = info.name
      ? page.getByRole(info.role as never, { name: info.name, exact: true })
      : page.getByRole(info.role as never);
    return info.nth !== undefined ? locator.nth(info.nth) : locator;
  }

  return page.locator(`aria-ref=${normalized}`);
}

export async function closePlaywrightBrowserConnection(): Promise<void> {
  const cur = cached;
  cached = null;
  if (!cur) return;
  await cur.browser.close().catch(() => {});
}
