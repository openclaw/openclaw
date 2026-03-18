import { EnvHttpProxyAgent, ProxyAgent, fetch as undiciFetch } from "undici";
import { logWarn } from "../../logger.js";
import { hasEnvHttpProxyConfigured } from "./proxy-env.js";

export const PROXY_FETCH_PROXY_URL = Symbol.for("openclaw.proxyFetch.proxyUrl");
type ProxyFetchWithMetadata = typeof fetch & {
  [PROXY_FETCH_PROXY_URL]?: string;
};

function isSocksUrl(url: string): boolean {
  return /^socks[45h]?:\/\//i.test(url);
}

/**
 * Create a fetch function that routes requests through the given proxy.
 * Supports both HTTP(S) proxies (via undici ProxyAgent) and SOCKS proxies.
 */
export function makeProxyFetch(proxyUrl: string): typeof fetch {
  if (isSocksUrl(proxyUrl)) {
    return makeSocksProxyFetch(proxyUrl);
  }
  let agent: ProxyAgent | null = null;
  const resolveAgent = (): ProxyAgent => {
    if (!agent) {
      agent = new ProxyAgent(proxyUrl);
    }
    return agent;
  };
  // undici's fetch is runtime-compatible with global fetch but the types diverge
  // on stream/body internals. Single cast at the boundary keeps the rest type-safe.
  const proxyFetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    undiciFetch(input as string | URL, {
      ...(init as Record<string, unknown>),
      dispatcher: resolveAgent(),
    }) as unknown as Promise<Response>) as ProxyFetchWithMetadata;
  Object.defineProperty(proxyFetch, PROXY_FETCH_PROXY_URL, {
    value: proxyUrl,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return proxyFetch;
}

function makeSocksProxyFetch(proxyUrl: string): typeof fetch {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { SocksProxyAgent } = require("socks-proxy-agent") as typeof import("socks-proxy-agent");
  const agent = new SocksProxyAgent(proxyUrl);

  const proxyFetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const targetUrl =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : ((input as { url?: string }).url ?? JSON.stringify(input));
    const method = init?.method ?? "GET";
    const headers = init?.headers as Record<string, string> | undefined;
    const body = init?.body as string | Buffer | undefined;

    const parsed = new URL(targetUrl);
    const isHttps = parsed.protocol === "https:";

    return new Promise<Response>((resolve, reject) => {
      const options = {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method,
        headers,
        agent,
        timeout: 30_000,
      };

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = isHttps ? require("https") : require("http");
      const req = mod.request(options, (res: import("http").IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const responseBody = Buffer.concat(chunks);
          resolve(
            new Response(responseBody, {
              status: res.statusCode ?? 200,
              statusText: res.statusMessage ?? "",
              headers: res.headers as Record<string, string>,
            }),
          );
        });
        res.on("error", reject);
      });
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy(new Error("SOCKS proxy request timed out after 30000ms"));
      });

      const signal = init?.signal;
      if (signal) {
        if (signal.aborted) {
          req.destroy();
          reject(new DOMException("The operation was aborted.", "AbortError"));
          return;
        }
        const onAbort = () => {
          req.destroy();
          reject(new DOMException("The operation was aborted.", "AbortError"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        req.on("close", () => signal.removeEventListener("abort", onAbort));
      }

      if (body) {
        req.write(body);
      }
      req.end();
    });
  }) as ProxyFetchWithMetadata;

  Object.defineProperty(proxyFetch, PROXY_FETCH_PROXY_URL, {
    value: proxyUrl,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return proxyFetch;
}

export function getProxyUrlFromFetch(fetchImpl?: typeof fetch): string | undefined {
  const proxyUrl = (fetchImpl as ProxyFetchWithMetadata | undefined)?.[PROXY_FETCH_PROXY_URL];
  if (typeof proxyUrl !== "string") {
    return undefined;
  }
  const trimmed = proxyUrl.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Resolve a proxy-aware fetch from standard environment variables
 * (HTTPS_PROXY, HTTP_PROXY, https_proxy, http_proxy).
 * Respects NO_PROXY / no_proxy exclusions via undici's EnvHttpProxyAgent.
 * Returns undefined when no proxy is configured.
 * Gracefully returns undefined if the proxy URL is malformed.
 */
export function resolveProxyFetchFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): typeof fetch | undefined {
  if (!hasEnvHttpProxyConfigured("https", env)) {
    return undefined;
  }
  try {
    const agent = new EnvHttpProxyAgent();
    return ((input: RequestInfo | URL, init?: RequestInit) =>
      undiciFetch(input as string | URL, {
        ...(init as Record<string, unknown>),
        dispatcher: agent,
      }) as unknown as Promise<Response>) as typeof fetch;
  } catch (err) {
    logWarn(
      `Proxy env var set but agent creation failed — falling back to direct fetch: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}
