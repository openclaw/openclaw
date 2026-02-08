import { formatCliCommand } from "../cli/command-format.js";
import {
  createBrowserControlContext,
  startBrowserControlServiceFromConfig,
} from "./control-service.js";
import { createBrowserRouteDispatcher } from "./routes/dispatcher.js";

function isAbsoluteHttp(url: string): boolean {
  return /^https?:\/\//i.test(url.trim());
}

// ---------------------------------------------------------------------------
// Bridge auth-token registry – tokens are keyed by bridge base URL so that
// fetchBrowserJson can transparently attach Bearer authentication to every
// outgoing HTTP request targeting a token-protected bridge server.
// ---------------------------------------------------------------------------
const _bridgeAuthTokens = new Map<string, string>();

export function registerBridgeAuthToken(baseUrl: string, token: string): void {
  _bridgeAuthTokens.set(baseUrl.replace(/\/$/, ""), token);
}

export function unregisterBridgeAuthToken(baseUrl: string): void {
  _bridgeAuthTokens.delete(baseUrl.replace(/\/$/, ""));
}

function lookupBridgeAuthToken(url: string): string | undefined {
  const normalized = url.replace(/\/$/, "");
  for (const [base, token] of _bridgeAuthTokens) {
    if (
      normalized === base ||
      normalized.startsWith(base + "/") ||
      normalized.startsWith(base + "?")
    ) {
      return token;
    }
  }
  return undefined;
}

function enhanceBrowserFetchError(url: string, err: unknown, timeoutMs: number): Error {
  const hint = isAbsoluteHttp(url)
    ? "If this is a sandboxed session, ensure the sandbox browser is running and try again."
    : `Start (or restart) the OpenClaw gateway (OpenClaw.app menubar, or \`${formatCliCommand("openclaw gateway")}\`) and try again.`;
  const msg = String(err);
  const msgLower = msg.toLowerCase();
  const looksLikeTimeout =
    msgLower.includes("timed out") ||
    msgLower.includes("timeout") ||
    msgLower.includes("aborted") ||
    msgLower.includes("abort") ||
    msgLower.includes("aborterror");
  if (looksLikeTimeout) {
    return new Error(
      `Can't reach the OpenClaw browser control service (timed out after ${timeoutMs}ms). ${hint}`,
    );
  }
  return new Error(`Can't reach the OpenClaw browser control service. ${hint} (${msg})`);
}

async function fetchHttpJson<T>(
  url: string,
  init: RequestInit & { timeoutMs?: number },
): Promise<T> {
  const timeoutMs = init.timeoutMs ?? 5000;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(text || `HTTP ${res.status}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

export async function fetchBrowserJson<T>(
  url: string,
  init?: RequestInit & { timeoutMs?: number },
): Promise<T> {
  const timeoutMs = init?.timeoutMs ?? 5000;
  try {
    if (isAbsoluteHttp(url)) {
      const authToken = lookupBridgeAuthToken(url);
      const authHeaders: Record<string, string> = authToken
        ? { Authorization: `Bearer ${authToken}` }
        : {};
      const mergedHeaders = {
        ...authHeaders,
        ...(init?.headers as Record<string, string> | undefined),
      };
      return await fetchHttpJson<T>(url, { ...init, headers: mergedHeaders, timeoutMs });
    }
    const started = await startBrowserControlServiceFromConfig();
    if (!started) {
      throw new Error("browser control disabled");
    }
    const dispatcher = createBrowserRouteDispatcher(createBrowserControlContext());
    const parsed = new URL(url, "http://localhost");
    const query: Record<string, unknown> = {};
    for (const [key, value] of parsed.searchParams.entries()) {
      query[key] = value;
    }
    let body = init?.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        // keep as string
      }
    }
    const dispatchPromise = dispatcher.dispatch({
      method:
        init?.method?.toUpperCase() === "DELETE"
          ? "DELETE"
          : init?.method?.toUpperCase() === "POST"
            ? "POST"
            : "GET",
      path: parsed.pathname,
      query,
      body,
    });

    const result = await (timeoutMs
      ? Promise.race([
          dispatchPromise,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("timed out")), timeoutMs),
          ),
        ])
      : dispatchPromise);

    if (result.status >= 400) {
      const message =
        result.body && typeof result.body === "object" && "error" in result.body
          ? String((result.body as { error?: unknown }).error)
          : `HTTP ${result.status}`;
      throw new Error(message);
    }
    return result.body as T;
  } catch (err) {
    throw enhanceBrowserFetchError(url, err, timeoutMs);
  }
}
