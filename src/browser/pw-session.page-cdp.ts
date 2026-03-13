import type { CDPSession, Page } from "playwright-core";
import {
  appendCdpPath,
  fetchJson,
  normalizeCdpHttpBaseForJsonEndpoints,
  withCdpSocket,
} from "./cdp.helpers.js";
import { getChromeWebSocketUrl } from "./chrome.js";

const OPENCLAW_EXTENSION_RELAY_BROWSER = "OpenClaw/extension-relay";

type PageCdpSend = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

const extensionRelayByCdpUrl = new Map<string, boolean>();

function normalizeCdpUrl(raw: string) {
  return raw.replace(/\/$/, "");
}

export async function isExtensionRelayCdpEndpoint(cdpUrl: string): Promise<boolean> {
  const normalized = normalizeCdpUrl(cdpUrl);
  const cached = extensionRelayByCdpUrl.get(normalized);
  if (cached !== undefined) {
    return cached;
  }

  try {
    const cdpHttpBase = normalizeCdpHttpBaseForJsonEndpoints(normalized);
    const version = await fetchJson<{ Browser?: string }>(
      appendCdpPath(cdpHttpBase, "/json/version"),
      2000,
    );
    const isRelay = String(version?.Browser ?? "").trim() === OPENCLAW_EXTENSION_RELAY_BROWSER;
    extensionRelayByCdpUrl.set(normalized, isRelay);
    return isRelay;
  } catch {
    extensionRelayByCdpUrl.set(normalized, false);
    return false;
  }
}

async function withPlaywrightPageCdpSession<T>(
  page: Page,
  fn: (session: CDPSession) => Promise<T>,
): Promise<T> {
  const session = await page.context().newCDPSession(page);
  try {
    return await fn(session);
  } finally {
    await session.detach().catch(() => {});
  }
}

export async function withPageScopedCdpClient<T>(opts: {
  cdpUrl: string;
  page: Page;
  targetId?: string;
  fn: (send: PageCdpSend) => Promise<T>;
}): Promise<T> {
  const targetId = opts.targetId?.trim();
  if (targetId && (await isExtensionRelayCdpEndpoint(opts.cdpUrl))) {
    const wsUrl = await getChromeWebSocketUrl(opts.cdpUrl, 2000);
    if (!wsUrl) {
      throw new Error("CDP websocket unavailable");
    }
    return await withCdpSocket(wsUrl, async (send) => {
      return await opts.fn((method, params) => send(method, { ...params, targetId }));
    });
  }

  return await withPlaywrightPageCdpSession(opts.page, async (session) => {
    return await opts.fn((method, params) =>
      (
        session.send as unknown as (
          method: string,
          params?: Record<string, unknown>,
        ) => Promise<unknown>
      )(method, params),
    );
  });
}
