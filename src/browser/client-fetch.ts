import { formatCliCommand } from "../cli/command-format.js";
import { loadConfig } from "../config/config.js";
import { isLoopbackHost } from "../gateway/net.js";
import { getBridgeAuthForPort } from "./bridge-auth-registry.js";
import { resolveBrowserControlAuth } from "./control-auth.js";
import {
  createBrowserControlContext,
  startBrowserControlServiceFromConfig,
} from "./control-service.js";
import { createBrowserRouteDispatcher } from "./routes/dispatcher.js";

// Application-level error from the browser control service (service is reachable
// but returned an error response). Must NOT be wrapped with "Can't reach ..." messaging.
class BrowserServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserServiceError";
  }
}

type LoopbackBrowserAuthDeps = {
  loadConfig: typeof loadConfig;
  resolveBrowserControlAuth: typeof resolveBrowserControlAuth;
  getBridgeAuthForPort: typeof getBridgeAuthForPort;
};

function isAbsoluteHttp(url: string): boolean {
  return /^https?:\/\//i.test(url.trim());
}

function isLoopbackHttpUrl(url: string): boolean {
  try {
    return isLoopbackHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

function withLoopbackBrowserAuthImpl(
  url: string,
  init: (RequestInit & { timeoutMs?: number }) | undefined,
  deps: LoopbackBrowserAuthDeps,
): RequestInit & { timeoutMs?: number } {
  const headers = new Headers(init?.headers ?? {});
  if (headers.has("authorization") || headers.has("x-openclaw-password")) {
    return { ...init, headers };
  }
  if (!isLoopbackHttpUrl(url)) {
    return { ...init, headers };
  }

  try {
    const cfg = deps.loadConfig();
    const auth = deps.resolveBrowserControlAuth(cfg);
    if (auth.token) {
      headers.set("Authorization", `Bearer ${auth.token}`);
      return { ...init, headers };
    }
    if (auth.password) {
      headers.set("x-openclaw-password", auth.password);
      return { ...init, headers };
    }
  } catch {
    // ignore config/auth lookup failures and continue without auth headers
  }

  // Sandbox bridge servers can run with per-process ephemeral auth on dynamic ports.
  // Fall back to the in-memory registry if config auth is not available.
  try {
    const parsed = new URL(url);
    const port =
      parsed.port && Number.parseInt(parsed.port, 10) > 0
        ? Number.parseInt(parsed.port, 10)
        : parsed.protocol === "https:"
          ? 443
          : 80;
    const bridgeAuth = deps.getBridgeAuthForPort(port);
    if (bridgeAuth?.token) {
      headers.set("Authorization", `Bearer ${bridgeAuth.token}`);
    } else if (bridgeAuth?.password) {
      headers.set("x-openclaw-password", bridgeAuth.password);
    }
  } catch {
    // ignore
  }

  return { ...init, headers };
}

function withLoopbackBrowserAuth(
  url: string,
  init: (RequestInit & { timeoutMs?: number }) | undefined,
): RequestInit & { timeoutMs?: number } {
  return withLoopbackBrowserAuthImpl(url, init, {
    loadConfig,
    resolveBrowserControlAuth,
    getBridgeAuthForPort,
  });
}

function enhanceBrowserFetchError(url: string, err: unknown, timeoutMs: number): Error {
  const isLocal = !isAbsoluteHttp(url);
  // Human-facing hint for logs/diagnostics.
  const operatorHint = isLocal
    ? `Restart the OpenClaw gateway (OpenClaw.app menubar, or \`${formatCliCommand("openclaw gateway")}\`).`
    : "If this is a sandboxed session, ensure the sandbox browser is running.";
  // Model-facing suffix: explicitly tell the LLM NOT to retry.
  // Without this, models see "try again" and enter an infinite tool-call loop.
  const modelHint =
    "Do NOT retry the browser tool — it will keep failing. " +
    "Use an alternative approach or inform the user that the browser is currently unavailable.";
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
      `Can't reach the OpenClaw browser control service (timed out after ${timeoutMs}ms). ${operatorHint} ${modelHint}`,
    );
  }
  return new Error(
    `Can't reach the OpenClaw browser control service. ${operatorHint} ${modelHint} (${msg})`,
  );
}

async function fetchHttpJson<T>(
  url: string,
  init: RequestInit & { timeoutMs?: number },
): Promise<T> {
  const timeoutMs = init.timeoutMs ?? 5000;
  const ctrl = new AbortController();
  const upstreamSignal = init.signal;
  let upstreamAbortListener: (() => void) | undefined;
  if (upstreamSignal) {
    if (upstreamSignal.aborted) {
      ctrl.abort(upstreamSignal.reason);
    } else {
      upstreamAbortListener = () => ctrl.abort(upstreamSignal.reason);
      upstreamSignal.addEventListener("abort", upstreamAbortListener, { once: true });
    }
  }

  const t = setTimeout(() => ctrl.abort(new Error("timed out")), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new BrowserServiceError(text || `HTTP ${res.status}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(t);
    if (upstreamSignal && upstreamAbortListener) {
      upstreamSignal.removeEventListener("abort", upstreamAbortListener);
    }
  }
}

export async function fetchBrowserJson<T>(
  url: string,
  init?: RequestInit & { timeoutMs?: number },
): Promise<T> {
  const timeoutMs = init?.timeoutMs ?? 5000;
  try {
    if (isAbsoluteHttp(url)) {
      const httpInit = withLoopbackBrowserAuth(url, init);
      return await fetchHttpJson<T>(url, { ...httpInit, timeoutMs });
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

    const abortCtrl = new AbortController();
    const upstreamSignal = init?.signal;
    let upstreamAbortListener: (() => void) | undefined;
    if (upstreamSignal) {
      if (upstreamSignal.aborted) {
        abortCtrl.abort(upstreamSignal.reason);
      } else {
        upstreamAbortListener = () => abortCtrl.abort(upstreamSignal.reason);
        upstreamSignal.addEventListener("abort", upstreamAbortListener, { once: true });
      }
    }

    let abortListener: (() => void) | undefined;
    const abortPromise: Promise<never> = abortCtrl.signal.aborted
      ? Promise.reject(abortCtrl.signal.reason ?? new Error("aborted"))
      : new Promise((_, reject) => {
          abortListener = () => reject(abortCtrl.signal.reason ?? new Error("aborted"));
          abortCtrl.signal.addEventListener("abort", abortListener, { once: true });
        });

    let timer: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs) {
      timer = setTimeout(() => abortCtrl.abort(new Error("timed out")), timeoutMs);
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
      signal: abortCtrl.signal,
    });

    const result = await Promise.race([dispatchPromise, abortPromise]).finally(() => {
      if (timer) {
        clearTimeout(timer);
      }
      if (abortListener) {
        abortCtrl.signal.removeEventListener("abort", abortListener);
      }
      if (upstreamSignal && upstreamAbortListener) {
        upstreamSignal.removeEventListener("abort", upstreamAbortListener);
      }
    });

    if (result.status >= 400) {
      const message =
        result.body && typeof result.body === "object" && "error" in result.body
          ? String((result.body as { error?: unknown }).error)
          : `HTTP ${result.status}`;
      throw new BrowserServiceError(message);
    }
    return result.body as T;
  } catch (err) {
    if (err instanceof BrowserServiceError) {
      throw err;
    }
    throw enhanceBrowserFetchError(url, err, timeoutMs);
  }
}

export const __test = {
  withLoopbackBrowserAuth: withLoopbackBrowserAuthImpl,
};
