import { EnvHttpProxyAgent, type Dispatcher } from "undici";
import { logWarn } from "../../logger.js";
import { bindAbortRelay } from "../../utils/fetch-timeout.js";
import { hasProxyEnvConfigured } from "./proxy-env.js";
import {
  closeDispatcher,
  createPinnedDispatcher,
  PINNED_AUTO_SELECT_FAMILY_FALLBACK_TIMEOUT_MS,
  resolvePinnedHostnameWithPolicy,
  type LookupFn,
  SsrFBlockedError,
  type SsrFPolicy,
} from "./ssrf.js";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export const GUARDED_FETCH_MODE = {
  STRICT: "strict",
  TRUSTED_ENV_PROXY: "trusted_env_proxy",
} as const;

export type GuardedFetchMode = (typeof GUARDED_FETCH_MODE)[keyof typeof GUARDED_FETCH_MODE];

export type GuardedFetchOptions = {
  url: string;
  fetchImpl?: FetchLike;
  init?: RequestInit;
  maxRedirects?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  policy?: SsrFPolicy;
  lookupFn?: LookupFn;
  mode?: GuardedFetchMode;
  pinDns?: boolean;
  /** @deprecated use `mode: "trusted_env_proxy"` for trusted/operator-controlled URLs. */
  proxy?: "env";
  /**
   * @deprecated use `mode: "trusted_env_proxy"` instead.
   */
  dangerouslyAllowEnvProxyWithoutPinnedDns?: boolean;
  auditContext?: string;
};

export type GuardedFetchResult = {
  response: Response;
  finalUrl: string;
  release: () => Promise<void>;
};

type GuardedFetchPresetOptions = Omit<
  GuardedFetchOptions,
  "mode" | "proxy" | "dangerouslyAllowEnvProxyWithoutPinnedDns"
>;

const DEFAULT_MAX_REDIRECTS = 3;
const CROSS_ORIGIN_REDIRECT_SENSITIVE_HEADERS = [
  "authorization",
  "proxy-authorization",
  "cookie",
  "cookie2",
];
const RETRYABLE_METHODS_FOR_FAMILY_TIMEOUT = new Set(["GET", "HEAD"]);
const RETRYABLE_FAMILY_ERROR_CODES = new Set(["ETIMEDOUT", "ENETUNREACH", "EHOSTUNREACH"]);

export function withStrictGuardedFetchMode(params: GuardedFetchPresetOptions): GuardedFetchOptions {
  return { ...params, mode: GUARDED_FETCH_MODE.STRICT };
}

export function withTrustedEnvProxyGuardedFetchMode(
  params: GuardedFetchPresetOptions,
): GuardedFetchOptions {
  return { ...params, mode: GUARDED_FETCH_MODE.TRUSTED_ENV_PROXY };
}

function resolveGuardedFetchMode(params: GuardedFetchOptions): GuardedFetchMode {
  if (params.mode) {
    return params.mode;
  }
  if (params.proxy === "env" && params.dangerouslyAllowEnvProxyWithoutPinnedDns === true) {
    return GUARDED_FETCH_MODE.TRUSTED_ENV_PROXY;
  }
  return GUARDED_FETCH_MODE.STRICT;
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function stripSensitiveHeadersForCrossOriginRedirect(init?: RequestInit): RequestInit | undefined {
  if (!init?.headers) {
    return init;
  }
  const headers = new Headers(init.headers);
  for (const header of CROSS_ORIGIN_REDIRECT_SENSITIVE_HEADERS) {
    headers.delete(header);
  }
  return { ...init, headers };
}

function resolveRequestMethod(init?: RequestInit): string {
  if (typeof init?.method !== "string") {
    return "GET";
  }
  const normalized = init.method.trim().toUpperCase();
  return normalized.length > 0 ? normalized : "GET";
}

function hasDualStackAddresses(addresses: readonly string[]): boolean {
  let sawIpv4 = false;
  let sawIpv6 = false;
  for (const address of addresses) {
    if (address.includes(":")) {
      sawIpv6 = true;
    } else {
      sawIpv4 = true;
    }
    if (sawIpv4 && sawIpv6) {
      return true;
    }
  }
  return false;
}

function readErrnoCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const maybeWithCode = error as { code?: unknown; cause?: unknown };
  if (typeof maybeWithCode.code === "string") {
    return maybeWithCode.code;
  }
  if (maybeWithCode.cause && maybeWithCode.cause !== error) {
    return readErrnoCode(maybeWithCode.cause);
  }
  return undefined;
}

function isRetryableFamilyTimeoutError(error: unknown): boolean {
  const code = readErrnoCode(error);
  return typeof code === "string" && RETRYABLE_FAMILY_ERROR_CODES.has(code);
}

function buildAbortSignal(params: { timeoutMs?: number; signal?: AbortSignal }): {
  signal?: AbortSignal;
  cleanup: () => void;
} {
  const { timeoutMs, signal } = params;
  if (!timeoutMs && !signal) {
    return { signal: undefined, cleanup: () => {} };
  }

  if (!timeoutMs) {
    return { signal, cleanup: () => {} };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(controller.abort.bind(controller), timeoutMs);
  const onAbort = bindAbortRelay(controller);
  if (signal) {
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  const cleanup = () => {
    clearTimeout(timeoutId);
    if (signal) {
      signal.removeEventListener("abort", onAbort);
    }
  };

  return { signal: controller.signal, cleanup };
}

export async function fetchWithSsrFGuard(params: GuardedFetchOptions): Promise<GuardedFetchResult> {
  const fetcher: FetchLike | undefined = params.fetchImpl ?? globalThis.fetch;
  if (!fetcher) {
    throw new Error("fetch is not available");
  }

  const maxRedirects =
    typeof params.maxRedirects === "number" && Number.isFinite(params.maxRedirects)
      ? Math.max(0, Math.floor(params.maxRedirects))
      : DEFAULT_MAX_REDIRECTS;
  const mode = resolveGuardedFetchMode(params);

  const { signal, cleanup } = buildAbortSignal({
    timeoutMs: params.timeoutMs,
    signal: params.signal,
  });

  let released = false;
  const release = async (dispatcher?: Dispatcher | null) => {
    if (released) {
      return;
    }
    released = true;
    cleanup();
    await closeDispatcher(dispatcher ?? undefined);
  };

  const visited = new Set<string>();
  let currentUrl = params.url;
  let currentInit = params.init ? { ...params.init } : undefined;
  let redirectCount = 0;

  while (true) {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(currentUrl);
    } catch {
      await release();
      throw new Error("Invalid URL: must be http or https");
    }
    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      await release();
      throw new Error("Invalid URL: must be http or https");
    }

    let dispatcher: Dispatcher | null = null;
    try {
      const pinned = await resolvePinnedHostnameWithPolicy(parsedUrl.hostname, {
        lookupFn: params.lookupFn,
        policy: params.policy,
      });
      const canUseTrustedEnvProxy =
        mode === GUARDED_FETCH_MODE.TRUSTED_ENV_PROXY && hasProxyEnvConfigured();
      const requestMethod = resolveRequestMethod(currentInit);
      const baseInit: RequestInit = {
        ...(currentInit ? { ...currentInit } : {}),
        redirect: "manual",
        ...(signal ? { signal } : {}),
      };
      const runFetchAttempt = async (
        autoSelectFamilyAttemptTimeoutMs?: number,
      ): Promise<{ response: Response; dispatcher: Dispatcher | null }> => {
        const attemptDispatcher = canUseTrustedEnvProxy
          ? new EnvHttpProxyAgent()
          : params.pinDns === false
            ? null
            : typeof autoSelectFamilyAttemptTimeoutMs === "number"
              ? createPinnedDispatcher(pinned, {
                  autoSelectFamilyAttemptTimeoutMs,
                })
              : createPinnedDispatcher(pinned);
        const init: RequestInit & { dispatcher?: Dispatcher } = {
          ...baseInit,
          ...(attemptDispatcher ? { dispatcher: attemptDispatcher } : {}),
        };
        try {
          const response = await fetcher(parsedUrl.toString(), init);
          return { response, dispatcher: attemptDispatcher };
        } catch (attemptError) {
          await closeDispatcher(attemptDispatcher);
          throw attemptError;
        }
      };

      let response: Response;
      try {
        const primaryAttempt = await runFetchAttempt();
        response = primaryAttempt.response;
        dispatcher = primaryAttempt.dispatcher;
      } catch (primaryError) {
        const shouldRetryWithRelaxedFamilyTimeout =
          params.pinDns !== false &&
          RETRYABLE_METHODS_FOR_FAMILY_TIMEOUT.has(requestMethod) &&
          hasDualStackAddresses(pinned.addresses) &&
          isRetryableFamilyTimeoutError(primaryError);
        if (!shouldRetryWithRelaxedFamilyTimeout) {
          throw primaryError;
        }
        const retryAttempt = await runFetchAttempt(PINNED_AUTO_SELECT_FAMILY_FALLBACK_TIMEOUT_MS);
        response = retryAttempt.response;
        dispatcher = retryAttempt.dispatcher;
      }

      if (isRedirectStatus(response.status)) {
        const location = response.headers.get("location");
        if (!location) {
          await release(dispatcher);
          throw new Error(`Redirect missing location header (${response.status})`);
        }
        redirectCount += 1;
        if (redirectCount > maxRedirects) {
          await release(dispatcher);
          throw new Error(`Too many redirects (limit: ${maxRedirects})`);
        }
        const nextParsedUrl = new URL(location, parsedUrl);
        const nextUrl = nextParsedUrl.toString();
        if (visited.has(nextUrl)) {
          await release(dispatcher);
          throw new Error("Redirect loop detected");
        }
        if (nextParsedUrl.origin !== parsedUrl.origin) {
          currentInit = stripSensitiveHeadersForCrossOriginRedirect(currentInit);
        }
        visited.add(nextUrl);
        void response.body?.cancel();
        await closeDispatcher(dispatcher);
        currentUrl = nextUrl;
        continue;
      }

      return {
        response,
        finalUrl: currentUrl,
        release: async () => release(dispatcher),
      };
    } catch (err) {
      if (err instanceof SsrFBlockedError) {
        const context = params.auditContext ?? "url-fetch";
        logWarn(
          `security: blocked URL fetch (${context}) target=${parsedUrl.origin}${parsedUrl.pathname} reason=${err.message}`,
        );
      }
      await release(dispatcher);
      throw err;
    }
  }
}
