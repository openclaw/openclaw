import type { CDPSession, Page } from "playwright-core";
import {
  appendCdpPath,
  fetchJson,
  normalizeCdpHttpBaseForJsonEndpoints,
  withCdpSocket,
} from "./cdp.helpers.js";
import { getChromeWebSocketUrl } from "./chrome.js";

const OPENCLAW_EXTENSION_RELAY_BROWSER = "OpenClaw/extension-relay";
const EXTENSION_RELAY_PROBE_FAILURE_TTL_MS = 5_000;
const EXTENSION_RELAY_PROBE_FAILURE_MAX_TTL_MS = 30_000;

type PageCdpSend = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

type ExtensionRelayProbeCacheEntry = {
  isRelay: boolean;
  expiresAt?: number;
  failureCount?: number;
};

const extensionRelayByCdpUrl = new Map<string, ExtensionRelayProbeCacheEntry>();

function normalizeCdpUrl(raw: string) {
  return raw.replace(/\/$/, "");
}

function getCachedRelayProbeResult(normalized: string): boolean | undefined {
  const cached = extensionRelayByCdpUrl.get(normalized);
  if (!cached) {
    return undefined;
  }
  if (cached.expiresAt !== undefined && cached.expiresAt <= Date.now()) {
    extensionRelayByCdpUrl.delete(normalized);
    return undefined;
  }
  return cached.isRelay;
}

function getCachedRelayProbeFailureCount(normalized: string): number {
  const cached = extensionRelayByCdpUrl.get(normalized);
  if (!cached || cached.isRelay || cached.expiresAt === undefined) {
    return 0;
  }
  return cached.failureCount ?? 0;
}

function getRelayProbeFailureTtlMs(failureCount: number): number {
  return Math.min(
    EXTENSION_RELAY_PROBE_FAILURE_TTL_MS * 2 ** Math.max(0, failureCount - 1),
    EXTENSION_RELAY_PROBE_FAILURE_MAX_TTL_MS,
  );
}

export async function isExtensionRelayCdpEndpoint(cdpUrl: string): Promise<boolean> {
  const normalized = normalizeCdpUrl(cdpUrl);
  const previousFailureCount = getCachedRelayProbeFailureCount(normalized);
  const cached = getCachedRelayProbeResult(normalized);
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
    extensionRelayByCdpUrl.set(normalized, { isRelay });
    return isRelay;
  } catch {
    const failureCount = previousFailureCount + 1;
    extensionRelayByCdpUrl.set(normalized, {
      isRelay: false,
      expiresAt: Date.now() + getRelayProbeFailureTtlMs(failureCount),
      failureCount,
    });
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
