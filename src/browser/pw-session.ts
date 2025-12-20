import type {
  Browser,
  BrowserContext,
  ConsoleMessage,
  Page,
} from "playwright-core";
import { chromium } from "playwright-core";

export type BrowserConsoleMessage = {
  type: string;
  text: string;
  timestamp: string;
  location?: { url?: string; lineNumber?: number; columnNumber?: number };
};

export type BrowserNetworkRequest = {
  requestId?: string;
  url: string;
  method: string;
  status?: number;
  resourceType?: string;
  timestamp?: string;
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
  endpoint: string;
};

type PageState = {
  console: BrowserConsoleMessage[];
};

const pageStates = new WeakMap<Page, PageState>();
const observedContexts = new WeakSet<BrowserContext>();
const observedPages = new WeakSet<Page>();

const MAX_CONSOLE_MESSAGES = 500;

let cached: ConnectedBrowser | null = null;
let connecting: Promise<ConnectedBrowser> | null = null;

function endpointForCdpPort(cdpPort: number) {
  return `http://127.0.0.1:${cdpPort}`;
}

export function ensurePageState(page: Page): PageState {
  const existing = pageStates.get(page);
  if (existing) return existing;

  const state: PageState = {
    console: [],
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

async function connectBrowser(endpoint: string): Promise<ConnectedBrowser> {
  if (cached?.endpoint === endpoint) return cached;
  if (connecting) return await connecting;

  connecting = chromium
    .connectOverCDP(endpoint, { timeout: 5000 })
    .then((browser) => {
      const connected: ConnectedBrowser = { browser, endpoint };
      cached = connected;
      observeBrowser(browser);
      browser.on("disconnected", () => {
        if (cached?.browser === browser) cached = null;
      });
      return connected;
    })
    .finally(() => {
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
  cdpPort: number;
  targetId?: string;
}): Promise<Page> {
  const endpoint = endpointForCdpPort(opts.cdpPort);
  const { browser } = await connectBrowser(endpoint);
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
  return page.locator(`aria-ref=${ref}`);
}

export async function closePlaywrightBrowserConnection(): Promise<void> {
  const cur = cached;
  cached = null;
  if (!cur) return;
  await cur.browser.close().catch(() => {});
}
