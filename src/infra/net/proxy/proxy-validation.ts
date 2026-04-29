import type { ProxyConfig } from "../../../config/zod-schema.proxy.js";
import { fetchWithRuntimeDispatcher } from "../runtime-fetch.js";
import { createHttp1ProxyAgent } from "../undici-runtime.js";

export const DEFAULT_PROXY_VALIDATION_ALLOWED_URLS = ["https://example.com/"] as const;
export const DEFAULT_PROXY_VALIDATION_DENIED_URLS = [
  "http://127.0.0.1/",
  "http://169.254.169.254/",
] as const;

export const DEFAULT_PROXY_VALIDATION_TIMEOUT_MS = 5000;

export type ProxyValidationConfigSource = "override" | "config" | "env" | "missing" | "disabled";

export type ProxyValidationResolvedConfig = {
  enabled: boolean;
  proxyUrl?: string;
  source: ProxyValidationConfigSource;
  errors: string[];
};

export type ProxyValidationCheckKind = "allowed" | "denied";

export type ProxyValidationCheck = {
  kind: ProxyValidationCheckKind;
  url: string;
  ok: boolean;
  status?: number;
  error?: string;
};

export type ProxyValidationResult = {
  ok: boolean;
  config: ProxyValidationResolvedConfig;
  checks: ProxyValidationCheck[];
};

export type ProxyValidationFetchCheckParams = {
  proxyUrl: string;
  targetUrl: string;
  timeoutMs: number;
};

export type ProxyValidationFetchCheckResult = {
  ok: boolean;
  status: number;
};

export type ProxyValidationFetchCheck = (
  params: ProxyValidationFetchCheckParams,
) => Promise<ProxyValidationFetchCheckResult>;

export type ResolveProxyValidationConfigOptions = {
  config?: ProxyConfig;
  env?: NodeJS.ProcessEnv | Partial<Record<"OPENCLAW_PROXY_URL", string | undefined>>;
  proxyUrlOverride?: string;
};

export type RunProxyValidationOptions = ResolveProxyValidationConfigOptions & {
  allowedUrls?: readonly string[];
  deniedUrls?: readonly string[];
  timeoutMs?: number;
  fetchCheck?: ProxyValidationFetchCheck;
};

function normalizeProxyUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isHttpProxyUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "http:";
  } catch {
    return false;
  }
}

function validateProxyUrl(value: string | undefined): string[] {
  if (!value) {
    return ["proxy validation requires proxy.proxyUrl or OPENCLAW_PROXY_URL"];
  }
  if (!isHttpProxyUrl(value)) {
    return ["proxy URL must use http://"];
  }
  return [];
}

export function resolveProxyValidationConfig(
  options: ResolveProxyValidationConfigOptions,
): ProxyValidationResolvedConfig {
  const overrideUrl = normalizeProxyUrl(options.proxyUrlOverride);
  if (overrideUrl) {
    return {
      enabled: true,
      proxyUrl: overrideUrl,
      source: "override",
      errors: validateProxyUrl(overrideUrl),
    };
  }

  const configUrl = normalizeProxyUrl(options.config?.proxyUrl);
  if (configUrl) {
    return {
      enabled: options.config?.enabled === true,
      proxyUrl: configUrl,
      source: "config",
      errors: validateProxyUrl(configUrl),
    };
  }

  const envUrl = normalizeProxyUrl(options.env?.OPENCLAW_PROXY_URL);
  if (envUrl) {
    return {
      enabled: options.config?.enabled === true,
      proxyUrl: envUrl,
      source: "env",
      errors: validateProxyUrl(envUrl),
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
    errors: [],
  };
}

async function defaultProxyValidationFetchCheck({
  proxyUrl,
  targetUrl,
  timeoutMs,
}: ProxyValidationFetchCheckParams): Promise<ProxyValidationFetchCheckResult> {
  const dispatcher = createHttp1ProxyAgent({ uri: proxyUrl }, timeoutMs);
  try {
    const response = await fetchWithRuntimeDispatcher(targetUrl, {
      dispatcher,
      redirect: "manual",
    });
    void response.body?.cancel();
    return { ok: response.ok, status: response.status };
  } finally {
    await dispatcher.close();
  }
}

function normalizeTimeoutMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_PROXY_VALIDATION_TIMEOUT_MS;
  }
  return Math.floor(value);
}

function isValidHttpTargetUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

async function runAllowedCheck(params: {
  url: string;
  proxyUrl: string;
  timeoutMs: number;
  fetchCheck: ProxyValidationFetchCheck;
}): Promise<ProxyValidationCheck> {
  try {
    const result = await params.fetchCheck({
      proxyUrl: params.proxyUrl,
      targetUrl: params.url,
      timeoutMs: params.timeoutMs,
    });
    if (!result.ok) {
      return {
        kind: "allowed",
        url: params.url,
        ok: false,
        status: result.status,
        error: `Allowed destination returned HTTP ${result.status}`,
      };
    }
    return { kind: "allowed", url: params.url, ok: true, status: result.status };
  } catch (err) {
    return {
      kind: "allowed",
      url: params.url,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function runDeniedCheck(params: {
  url: string;
  proxyUrl: string;
  timeoutMs: number;
  fetchCheck: ProxyValidationFetchCheck;
}): Promise<ProxyValidationCheck> {
  if (!isValidHttpTargetUrl(params.url)) {
    return {
      kind: "denied",
      url: params.url,
      ok: false,
      error: "Invalid denied destination URL",
    };
  }

  try {
    const result = await params.fetchCheck({
      proxyUrl: params.proxyUrl,
      targetUrl: params.url,
      timeoutMs: params.timeoutMs,
    });
    return {
      kind: "denied",
      url: params.url,
      ok: false,
      status: result.status,
      error: `Denied destination returned HTTP ${result.status}; expected the proxy to block the connection`,
    };
  } catch (err) {
    return {
      kind: "denied",
      url: params.url,
      ok: true,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function runProxyValidation(
  options: RunProxyValidationOptions,
): Promise<ProxyValidationResult> {
  const config = resolveProxyValidationConfig(options);
  if (config.errors.length > 0 || !config.proxyUrl) {
    return { ok: false, config, checks: [] };
  }

  const timeoutMs = normalizeTimeoutMs(options.timeoutMs);
  const fetchCheck = options.fetchCheck ?? defaultProxyValidationFetchCheck;
  const allowedUrls = options.allowedUrls ?? DEFAULT_PROXY_VALIDATION_ALLOWED_URLS;
  const deniedUrls = options.deniedUrls ?? DEFAULT_PROXY_VALIDATION_DENIED_URLS;
  const checks: ProxyValidationCheck[] = [];

  for (const url of allowedUrls) {
    checks.push(await runAllowedCheck({ url, proxyUrl: config.proxyUrl, timeoutMs, fetchCheck }));
  }
  for (const url of deniedUrls) {
    checks.push(await runDeniedCheck({ url, proxyUrl: config.proxyUrl, timeoutMs, fetchCheck }));
  }

  return {
    ok: checks.every((check) => check.ok),
    config,
    checks,
  };
}
