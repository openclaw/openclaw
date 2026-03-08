import type { GatewayRpcOpts } from "./gateway-rpc.js";
import { callGatewayFromCli } from "./gateway-rpc.js";

export type BrowserParentOpts = GatewayRpcOpts & {
  json?: boolean;
  browserProfile?: string;
  timeoutSource?: string;
};

type BrowserRequestParams = {
  method: "GET" | "POST" | "DELETE";
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
};

function normalizeQuery(query: BrowserRequestParams["query"]): Record<string, string> | undefined {
  if (!query) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) {
      continue;
    }
    out[key] = String(value);
  }
  return Object.keys(out).length ? out : undefined;
}

function normalizeTimeoutMs(timeoutMs: number | undefined): number | undefined {
  return typeof timeoutMs === "number" && Number.isFinite(timeoutMs)
    ? Math.max(1, Math.floor(timeoutMs))
    : undefined;
}

function parseParentTimeoutMs(opts: BrowserParentOpts): number | undefined {
  if (opts.timeoutSource === "default") {
    return undefined;
  }
  return typeof opts.timeout === "string"
    ? normalizeTimeoutMs(Number.parseInt(opts.timeout, 10))
    : undefined;
}

export function resolveBrowserRequestTimeoutMs(
  opts: BrowserParentOpts,
  params?: { explicitMs?: number; fallbackMs?: number },
): number | undefined {
  return (
    normalizeTimeoutMs(params?.explicitMs) ??
    parseParentTimeoutMs(opts) ??
    normalizeTimeoutMs(params?.fallbackMs)
  );
}

export async function callBrowserRequest<T>(
  opts: BrowserParentOpts,
  params: BrowserRequestParams,
  extra?: { timeoutMs?: number; progress?: boolean },
): Promise<T> {
  const resolvedTimeout = resolveBrowserRequestTimeoutMs(opts, {
    explicitMs: extra?.timeoutMs,
  });
  const timeout = typeof resolvedTimeout === "number" ? String(resolvedTimeout) : opts.timeout;
  const payload = await callGatewayFromCli(
    "browser.request",
    { ...opts, timeout },
    {
      method: params.method,
      path: params.path,
      query: normalizeQuery(params.query),
      body: params.body,
      timeoutMs: resolvedTimeout,
    },
    { progress: extra?.progress },
  );
  if (payload === undefined) {
    throw new Error("Unexpected browser.request response");
  }
  return payload as T;
}

export async function callBrowserResize(
  opts: BrowserParentOpts,
  params: { profile?: string; width: number; height: number; targetId?: string },
  extra?: { timeoutMs?: number },
): Promise<unknown> {
  return callBrowserRequest(
    opts,
    {
      method: "POST",
      path: "/act",
      query: params.profile ? { profile: params.profile } : undefined,
      body: {
        kind: "resize",
        width: params.width,
        height: params.height,
        targetId: params.targetId?.trim() || undefined,
      },
    },
    extra,
  );
}
