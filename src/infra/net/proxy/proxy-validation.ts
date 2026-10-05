import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { isHttpUrl } from "@openclaw/net-policy/url-protocol";
import { coerceErrorMessage } from "@openclaw/normalization-core/error-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ProxyConfig } from "../../../config/zod-schema.proxy.js";
import { probeApnsHttp2ReachabilityViaProxy } from "../../push-apns-http2.js";
import { fetchWithRuntimeDispatcher } from "../runtime-fetch.js";
import { createHttp1ProxyAgent } from "../undici-runtime.js";
import {
  loadManagedProxyTlsOptions,
  resolveManagedProxyCaFileForUrl,
  type ManagedProxyTlsOptions,
} from "./proxy-tls.js";

const DEFAULT_PROXY_VALIDATION_ALLOWED_URLS = ["https://example.com/"] as const;
const DEFAULT_PROXY_VALIDATION_APNS_AUTHORITY = "https://api.sandbox.push.apple.com";

const DEFAULT_PROXY_VALIDATION_TIMEOUT_MS = 5000;
const DENIED_CANARY_HEADER = "x-openclaw-proxy-validation-canary";
const APNS_REACHABILITY_REASON = "InvalidProviderToken";

type ProxyValidationConfigSource = "override" | "config" | "env" | "missing" | "disabled";

type ProxyValidationResolvedConfig = {
  enabled: boolean;
  proxyUrl?: string;
  proxyCaFile?: string;
  source: ProxyValidationConfigSource;
  errors: string[];
};

type ProxyValidationCheckKind = "allowed" | "denied" | "apns";

type ProxyValidationCheck = {
  kind: ProxyValidationCheckKind;
  url: string;
  ok: boolean;
  status?: number;
  error?: string;
};

type ProxyValidationOutcome = Omit<ProxyValidationCheck, "kind" | "url">;

export type ProxyValidationResult = {
  ok: boolean;
  config: ProxyValidationResolvedConfig;
  checks: ProxyValidationCheck[];
};

type ProxyValidationFetchCheckParams = {
  proxyUrl: string;
  proxyTls?: ManagedProxyTlsOptions;
  targetUrl: string;
  timeoutMs: number;
};

type ProxyValidationFetchCheckResult = {
  ok: boolean;
  status: number;
  deniedCanaryToken?: string;
};

type ProxyValidationFetchCheck = (
  params: ProxyValidationFetchCheckParams,
) => Promise<ProxyValidationFetchCheckResult>;

type ProxyValidationApnsCheckParams = Parameters<typeof probeApnsHttp2ReachabilityViaProxy>[0];

type ProxyValidationApnsCheckResult = {
  status: number;
  /** Present when the response originated from a real APNs server (Apple always returns this UUID). */
  apnsId?: string;
  /** APNs JSON error reason. InvalidProviderToken proves the invalid-token probe reached APNs. */
  apnsReason?: string;
};

type ProxyValidationApnsCheck = (
  params: ProxyValidationApnsCheckParams,
) => Promise<ProxyValidationApnsCheckResult>;

type ResolveProxyValidationConfigOptions = {
  config?: ProxyConfig;
  env?: NodeJS.ProcessEnv | Partial<Record<"OPENCLAW_PROXY_URL", string | undefined>>;
  proxyUrlOverride?: string;
  proxyCaFileOverride?: string;
};

type RunProxyValidationOptions = ResolveProxyValidationConfigOptions & {
  allowedUrls?: readonly string[];
  deniedUrls?: readonly string[];
  timeoutMs?: number;
  fetchCheck?: ProxyValidationFetchCheck;
  apnsReachability?: boolean;
  apnsAuthority?: string;
  apnsCheck?: ProxyValidationApnsCheck;
};

function validateProxyUrl(value: string | undefined): string[] {
  if (!value) {
    return ["proxy validation requires proxy.proxyUrl, --proxy-url, or OPENCLAW_PROXY_URL"];
  }
  if (!isHttpUrl(value)) {
    return ["proxyUrl must use http:// or https://"];
  }
  return [];
}

/** Resolves validation config precedence: explicit override, config, then env. */
function resolveProxyValidationConfig(
  options: ResolveProxyValidationConfigOptions,
): ProxyValidationResolvedConfig {
  const overrideUrl = normalizeOptionalString(options.proxyUrlOverride);
  const configUrl = normalizeOptionalString(options.config?.proxyUrl);
  const proxyUrl =
    overrideUrl ?? configUrl ?? normalizeOptionalString(options.env?.OPENCLAW_PROXY_URL);
  if (proxyUrl) {
    const enabled = Boolean(overrideUrl) || options.config?.enabled !== false;
    const proxyCaFile = resolveManagedProxyCaFileForUrl({
      proxyUrl,
      config: overrideUrl ? undefined : options.config,
      caFileOverride: options.proxyCaFileOverride,
    });
    return {
      enabled,
      proxyUrl,
      ...(proxyCaFile ? { proxyCaFile } : {}),
      source: overrideUrl ? "override" : configUrl ? "config" : "env",
      errors: enabled
        ? validateProxyUrl(proxyUrl)
        : ["proxy validation is disabled by proxy.enabled=false"],
    };
  }

  if (options.config?.enabled === true) {
    return {
      enabled: true,
      source: "missing",
      errors: validateProxyUrl(undefined),
    };
  }

  return {
    enabled: false,
    source: "disabled",
    errors: ["proxy validation requires proxy.proxyUrl, OPENCLAW_PROXY_URL, or --proxy-url"],
  };
}

async function defaultProxyValidationFetchCheck({
  proxyUrl,
  proxyTls,
  targetUrl,
  timeoutMs,
}: ProxyValidationFetchCheckParams): Promise<ProxyValidationFetchCheckResult> {
  const dispatcher = createHttp1ProxyAgent(
    {
      uri: proxyUrl,
      ...(proxyTls ? { proxyTls } : {}),
    },
    timeoutMs,
  );
  try {
    const response = await fetchWithRuntimeDispatcher(targetUrl, {
      dispatcher,
      redirect: "manual",
    });
    void response.body?.cancel().catch(() => undefined);
    return {
      ok: response.ok,
      status: response.status,
      deniedCanaryToken: response.headers.get(DENIED_CANARY_HEADER) ?? undefined,
    };
  } finally {
    await dispatcher.close();
  }
}

async function defaultProxyValidationApnsCheck(
  params: ProxyValidationApnsCheckParams,
): Promise<ProxyValidationApnsCheckResult> {
  const result = await probeApnsHttp2ReachabilityViaProxy(params);
  return {
    status: result.status,
    apnsId: result.responseHeaders?.["apns-id"],
    apnsReason: parseApnsErrorReason(result.body),
  };
}

function parseApnsErrorReason(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== "object") {
      return undefined;
    }
    const reason = (parsed as { reason?: unknown }).reason;
    return typeof reason === "string" && reason.trim() ? reason : undefined;
  } catch {
    return undefined;
  }
}

type ProxyValidationDeniedTarget = {
  url: string;
  expectedCanaryToken?: string;
};

type LoopbackValidationCanary = {
  url: string;
  token: string;
  close: () => Promise<void>;
};

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

async function createLoopbackValidationCanary(): Promise<LoopbackValidationCanary> {
  const token = randomUUID();
  // Only the per-probe token distinguishes our listener from a proxy response.
  const server = createServer((_request, response) => {
    response.writeHead(204, {
      [DENIED_CANARY_HEADER]: token,
      "cache-control": "no-store",
    });
    response.end();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (typeof address === "string" || address === null) {
    await closeServer(server);
    throw new Error("Unable to start loopback proxy validation canary");
  }

  return {
    url: `http://127.0.0.1:${address.port}/`,
    token,
    close: () => closeServer(server),
  };
}

/** Probes the active runtime route, independently of explicit proxy-denial checks. */
export async function probeManagedProxyLoopback(
  options: ResolveProxyValidationConfigOptions,
): Promise<boolean | null> {
  const config = resolveProxyValidationConfig(options);
  if (!config.enabled || !config.proxyUrl || config.errors.length > 0) {
    return null;
  }
  const canary = await createLoopbackValidationCanary();
  try {
    const response = await fetchWithRuntimeDispatcher(canary.url, {
      redirect: "manual",
      signal: AbortSignal.timeout(DEFAULT_PROXY_VALIDATION_TIMEOUT_MS),
    });
    void response.body?.cancel().catch(() => undefined);
    return response.ok && response.headers.get(DENIED_CANARY_HEADER) === canary.token;
  } catch {
    return false;
  } finally {
    await canary.close();
  }
}

async function runValidationCheck(
  kind: ProxyValidationCheckKind,
  url: string,
  run: () => Promise<ProxyValidationOutcome>,
): Promise<ProxyValidationCheck> {
  try {
    return { kind, url, ...(await run()) };
  } catch (err) {
    return { kind, url, ok: false, error: coerceErrorMessage(err) };
  }
}

export async function runProxyValidation(
  options: RunProxyValidationOptions,
): Promise<ProxyValidationResult> {
  const config = resolveProxyValidationConfig(options);
  if (config.errors.length > 0 || !config.proxyUrl) {
    return { ok: false, config, checks: [] };
  }

  const proxyUrl = config.proxyUrl;
  const timeoutMs =
    options.timeoutMs === undefined || !Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0
      ? DEFAULT_PROXY_VALIDATION_TIMEOUT_MS
      : Math.floor(options.timeoutMs);
  let proxyTls: ManagedProxyTlsOptions | undefined;
  try {
    proxyTls = await loadManagedProxyTlsOptions(config.proxyCaFile);
  } catch (err) {
    return {
      ok: false,
      config: {
        ...config,
        errors: [...config.errors, coerceErrorMessage(err)],
      },
      checks: [],
    };
  }
  const fetchCheck = options.fetchCheck ?? defaultProxyValidationFetchCheck;
  const apnsCheck = options.apnsCheck ?? defaultProxyValidationApnsCheck;
  const apnsAuthority = options.apnsAuthority ?? DEFAULT_PROXY_VALIDATION_APNS_AUTHORITY;
  const allowedUrls = options.allowedUrls ?? DEFAULT_PROXY_VALIDATION_ALLOWED_URLS;
  let canary: LoopbackValidationCanary | undefined;
  let deniedTargets: ProxyValidationDeniedTarget[];
  if (options.deniedUrls !== undefined) {
    deniedTargets = options.deniedUrls.map((url) => ({ url }));
  } else {
    canary = await createLoopbackValidationCanary();
    deniedTargets = [{ url: canary.url, expectedCanaryToken: canary.token }];
  }
  const checks: ProxyValidationCheck[] = [];
  const checkDestination = (kind: "allowed" | "denied", target: ProxyValidationDeniedTarget) =>
    runValidationCheck(kind, target.url, async () => {
      if (!isHttpUrl(target.url)) {
        return { ok: false, error: `Invalid ${kind} destination URL` };
      }
      try {
        const result = await fetchCheck({
          proxyUrl,
          ...(proxyTls ? { proxyTls } : {}),
          targetUrl: target.url,
          timeoutMs,
        });
        if (kind === "allowed") {
          return result.ok
            ? { ok: true, status: result.status }
            : {
                ok: false,
                status: result.status,
                error: `Allowed destination returned HTTP ${result.status}`,
              };
        }
        if (
          target.expectedCanaryToken !== undefined &&
          result.deniedCanaryToken !== target.expectedCanaryToken
        ) {
          // Only the token proves forwarding; an unverified success is not a denial.
          return result.ok
            ? {
                ok: false,
                status: result.status,
                error: `Denied loopback canary returned HTTP ${result.status} without the validation token`,
              }
            : { ok: true, status: result.status };
        }
        return {
          ok: false,
          status: result.status,
          error:
            target.expectedCanaryToken === undefined
              ? `Denied destination returned HTTP ${result.status}; expected the proxy to block the connection`
              : `Denied loopback canary was reachable through the proxy with HTTP ${result.status}`,
        };
      } catch (err) {
        if (kind === "allowed") {
          throw err;
        }
        const message = coerceErrorMessage(err);
        return target.expectedCanaryToken !== undefined
          ? { ok: true, error: message }
          : {
              ok: false,
              error: `Denied destination failed without a verifiable proxy-deny signal: ${message}`,
            };
      }
    });

  try {
    for (const url of allowedUrls) {
      checks.push(await checkDestination("allowed", { url }));
    }
    for (const target of deniedTargets) {
      checks.push(await checkDestination("denied", target));
    }
    if (options.apnsReachability === true) {
      checks.push(
        await runValidationCheck("apns", apnsAuthority, async () => {
          const result = await apnsCheck({
            proxyUrl,
            ...(proxyTls ? { proxyTls } : {}),
            authority: apnsAuthority,
            timeoutMs,
          });
          // The invalid-token response proves the tunnel reached Apple without an apns-id header.
          return result.apnsId ||
            (result.status === 403 && result.apnsReason === APNS_REACHABILITY_REASON)
            ? { ok: true, status: result.status }
            : {
                ok: false,
                error:
                  "APNs reachability check failed: response did not include an apns-id header or APNs InvalidProviderToken body. " +
                  "The proxy may be intercepting the connection instead of tunneling it.",
              };
        }),
      );
    }
  } finally {
    await canary?.close();
  }

  return {
    ok: checks.every((check) => check.ok),
    config,
    checks,
  };
}
