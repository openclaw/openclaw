import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { loadJsonFile, saveJsonFile } from "../infra/json-file.js";

// ── Endpoint resolution ─────────────────────────────────────────────────────
// Derives all GitHub Copilot-related endpoint URLs from a single host value.
// Supports github.com (default) and GHE Cloud with data residency (e.g. "myorg.ghe.com").

const DEFAULT_CLIENT_ID = "Iv1.b507a08c87ecfe98";

export type GitHubCopilotEndpoints = {
  /** The GitHub host, e.g. "github.com" or "myorg.ghe.com". */
  host: string;
  /** OAuth App Client ID for the device flow. */
  clientId: string;
  /** POST — request a device code. */
  deviceCodeUrl: string;
  /** POST — poll for an access token. */
  accessTokenUrl: string;
  /** GET — exchange GitHub token for Copilot API token. */
  copilotTokenUrl: string;
  /** GET — Copilot user / usage info. */
  copilotUserUrl: string;
  /** Fallback Copilot API base URL (if not derivable from token response). */
  defaultCopilotApiBaseUrl: string;
};

export function isGitHubDotCom(host: string): boolean {
  return !host || host === "github.com";
}

/**
 * Resolve all Copilot endpoint URLs from a host string.
 *
 * @param host - GitHub host, e.g. "github.com" (default) or "myorg.ghe.com".
 * @param clientId - OAuth Client ID override; defaults to the public Copilot App.
 */
export function resolveGitHubCopilotEndpoints(
  host?: string,
  clientId?: string,
): GitHubCopilotEndpoints {
  const effectiveHost = host?.trim() || "github.com";
  const dotCom = isGitHubDotCom(effectiveHost);
  const apiBase = dotCom ? "https://api.github.com" : `https://api.${effectiveHost}`;

  return {
    host: effectiveHost,
    clientId: clientId?.trim() || DEFAULT_CLIENT_ID,
    deviceCodeUrl: `https://${effectiveHost}/login/device/code`,
    accessTokenUrl: `https://${effectiveHost}/login/oauth/access_token`,
    copilotTokenUrl: `${apiBase}/copilot_internal/v2/token`,
    copilotUserUrl: `${apiBase}/copilot_internal/user`,
    defaultCopilotApiBaseUrl: dotCom
      ? "https://api.individual.githubcopilot.com"
      : `https://copilot-api.${effectiveHost}`,
  };
}

// ── Token resolution ────────────────────────────────────────────────────────

export type CachedCopilotToken = {
  token: string;
  /** milliseconds since epoch */
  expiresAt: number;
  /** milliseconds since epoch */
  updatedAt: number;
};

function resolveCopilotTokenCachePath(env: NodeJS.ProcessEnv = process.env, host?: string) {
  const suffix =
    host && !isGitHubDotCom(host)
      ? `github-copilot.${host}.token.json`
      : "github-copilot.token.json";
  return path.join(resolveStateDir(env), "credentials", suffix);
}

function isTokenUsable(cache: CachedCopilotToken, now = Date.now()): boolean {
  // Keep a small safety margin when checking expiry.
  return cache.expiresAt - now > 5 * 60 * 1000;
}

function parseCopilotTokenResponse(value: unknown): {
  token: string;
  expiresAt: number;
  /** Proxy endpoint from the response JSON (GHE Cloud returns this as endpoints.proxy). */
  proxyEndpoint: string | null;
} {
  if (!value || typeof value !== "object") {
    throw new Error("Unexpected response from GitHub Copilot token endpoint");
  }
  const asRecord = value as Record<string, unknown>;
  const token = asRecord.token;
  const expiresAt = asRecord.expires_at;
  if (typeof token !== "string" || token.trim().length === 0) {
    throw new Error("Copilot token response missing token");
  }

  // GitHub returns a unix timestamp (seconds), but we defensively accept ms too.
  let expiresAtMs: number;
  if (typeof expiresAt === "number" && Number.isFinite(expiresAt)) {
    expiresAtMs = expiresAt > 10_000_000_000 ? expiresAt : expiresAt * 1000;
  } else if (typeof expiresAt === "string" && expiresAt.trim().length > 0) {
    const parsed = Number.parseInt(expiresAt, 10);
    if (!Number.isFinite(parsed)) {
      throw new Error("Copilot token response has invalid expires_at");
    }
    expiresAtMs = parsed > 10_000_000_000 ? parsed : parsed * 1000;
  } else {
    throw new Error("Copilot token response missing expires_at");
  }

  // GHE Cloud with data residency returns endpoints in the JSON body, e.g.:
  //   { "endpoints": { "proxy": "https://copilot-proxy.myorg.ghe.com" } }
  // Extract the proxy endpoint if present.
  let proxyEndpoint: string | null = null;
  const endpoints = asRecord.endpoints;
  if (endpoints && typeof endpoints === "object") {
    const ep = endpoints as Record<string, unknown>;
    if (typeof ep.proxy === "string" && ep.proxy.trim().length > 0) {
      proxyEndpoint = ep.proxy.trim();
    }
  }

  return { token, expiresAt: expiresAtMs, proxyEndpoint };
}

export const DEFAULT_COPILOT_API_BASE_URL = "https://api.individual.githubcopilot.com";

export function deriveCopilotApiBaseUrlFromToken(token: string): string | null {
  const trimmed = token.trim();
  if (!trimmed) {
    return null;
  }

  // The token returned from the Copilot token endpoint is a semicolon-delimited
  // set of key/value pairs. One of them is `proxy-ep=...`.
  const match = trimmed.match(/(?:^|;)\s*proxy-ep=([^;\s]+)/i);
  const proxyEp = match?.[1]?.trim();
  if (!proxyEp) {
    return null;
  }

  // pi-ai expects converting proxy.* -> api.*
  // (see upstream getGitHubCopilotBaseUrl).
  const host = proxyEp.replace(/^https?:\/\//, "").replace(/^proxy\./i, "api.");
  if (!host) {
    return null;
  }

  return `https://${host}`;
}

export async function resolveCopilotApiToken(params: {
  githubToken: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  /** GitHub host for Enterprise, e.g. "myorg.ghe.com". Defaults to github.com. */
  githubHost?: string;
}): Promise<{
  token: string;
  expiresAt: number;
  source: string;
  baseUrl: string;
}> {
  const env = params.env ?? process.env;
  const endpoints = resolveGitHubCopilotEndpoints(params.githubHost);
  const cachePath = resolveCopilotTokenCachePath(env, endpoints.host);
  const cached = loadJsonFile(cachePath) as CachedCopilotToken | undefined;
  if (cached && typeof cached.token === "string" && typeof cached.expiresAt === "number") {
    if (isTokenUsable(cached)) {
      return {
        token: cached.token,
        expiresAt: cached.expiresAt,
        source: `cache:${cachePath}`,
        baseUrl:
          deriveCopilotApiBaseUrlFromToken(cached.token) ?? endpoints.defaultCopilotApiBaseUrl,
      };
    }
  }

  const tokenUrl = endpoints.copilotTokenUrl;
  const fetchImpl = params.fetchImpl ?? fetch;
  const res = await fetchImpl(tokenUrl, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${params.githubToken}`,
    },
  });

  if (!res.ok) {
    throw new Error(`Copilot token exchange failed: HTTP ${res.status}`);
  }

  const json = parseCopilotTokenResponse(await res.json());
  const payload: CachedCopilotToken = {
    token: json.token,
    expiresAt: json.expiresAt,
    updatedAt: Date.now(),
  };
  saveJsonFile(cachePath, payload);

  // Prefer: 1) proxy-ep from the token string (github.com tokens embed this)
  //         2) host-derived default (works for both github.com and GHE Cloud)
  //
  // Note: we intentionally skip the `endpoints.proxy` JSON field for API base
  // URL derivation. GHE Cloud returns a shared proxy domain (e.g.
  // copilot-proxy.githubusercontent.com) that cannot be hostname-swapped to get
  // the org-specific API base URL (copilot-api.{host}).
  const baseUrl =
    deriveCopilotApiBaseUrlFromToken(payload.token) ?? endpoints.defaultCopilotApiBaseUrl;

  return {
    token: payload.token,
    expiresAt: payload.expiresAt,
    source: `fetched:${tokenUrl}`,
    baseUrl,
  };
}

/**
 * Derive a Copilot API base URL from the `endpoints.proxy` field in the
 * token response by transforming `copilot-proxy.X` → `copilot-api.X`.
 *
 * WARNING: This does NOT work for GHE Cloud with data residency because
 * the token response returns a shared proxy (`copilot-proxy.githubusercontent.com`)
 * rather than an org-specific one. Use `endpoints.defaultCopilotApiBaseUrl`
 * (from `resolveGitHubCopilotEndpoints`) for GHE Cloud instead.
 *
 * Exported for edge-case callers; not used in the main resolution chain.
 */
export function deriveCopilotApiBaseUrlFromProxyEndpoint(
  proxyEndpoint: string | null | undefined,
): string | null {
  if (!proxyEndpoint) {
    return null;
  }
  const trimmed = proxyEndpoint.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const url = new URL(trimmed);
    // copilot-proxy.myorg.ghe.com → copilot-api.myorg.ghe.com
    if (url.hostname.startsWith("copilot-proxy.")) {
      url.hostname = url.hostname.replace(/^copilot-proxy\./, "copilot-api.");
    }
    // Strip trailing slash for consistency.
    return url.origin;
  } catch {
    return null;
  }
}
