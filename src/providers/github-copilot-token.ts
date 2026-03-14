import { createHash } from "node:crypto";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { loadJsonFile, saveJsonFile } from "../infra/json-file.js";

const COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";

export type CachedCopilotToken = {
  token: string;
  /** milliseconds since epoch */
  expiresAt: number;
  /** milliseconds since epoch */
  updatedAt: number;
  /** Short hash of the GitHub PAT that produced this token (for cache isolation). */
  githubTokenHash?: string;
};

/**
 * Derive a short, filesystem-safe hash from the GitHub PAT so each profile
 * gets its own cache file.
 */
export function hashGithubToken(githubToken: string): string {
  return createHash("sha256").update(githubToken).digest("hex").slice(0, 12);
}

function resolveCopilotTokenCachePath(githubToken: string, env: NodeJS.ProcessEnv = process.env) {
  const profileHash = hashGithubToken(githubToken);
  return path.join(resolveStateDir(env), "credentials", `github-copilot.token.${profileHash}.json`);
}

function isTokenUsable(cache: CachedCopilotToken, now = Date.now()): boolean {
  // Keep a small safety margin when checking expiry.
  return cache.expiresAt - now > 5 * 60 * 1000;
}

function parseCopilotTokenResponse(value: unknown): {
  token: string;
  expiresAt: number;
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

  return { token, expiresAt: expiresAtMs };
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
  cachePath?: string;
  loadJsonFileImpl?: (path: string) => unknown;
  saveJsonFileImpl?: (path: string, value: CachedCopilotToken) => void;
}): Promise<{
  token: string;
  expiresAt: number;
  source: string;
  baseUrl: string;
}> {
  const env = params.env ?? process.env;
  const tokenHash = hashGithubToken(params.githubToken);
  const cachePath =
    params.cachePath?.trim() || resolveCopilotTokenCachePath(params.githubToken, env);
  const loadJsonFileFn = params.loadJsonFileImpl ?? loadJsonFile;
  const saveJsonFileFn = params.saveJsonFileImpl ?? saveJsonFile;
  const cached = loadJsonFileFn(cachePath) as CachedCopilotToken | undefined;
  if (cached && typeof cached.token === "string" && typeof cached.expiresAt === "number") {
    // Accept the cached token only when it belongs to the same profile.  A
    // missing hash (legacy cache written before this change) is treated as a
    // match so that existing single-profile users are not forced to re-fetch.
    const hashMatches = !cached.githubTokenHash || cached.githubTokenHash === tokenHash;
    if (hashMatches && isTokenUsable(cached)) {
      return {
        token: cached.token,
        expiresAt: cached.expiresAt,
        source: `cache:${cachePath}`,
        baseUrl: deriveCopilotApiBaseUrlFromToken(cached.token) ?? DEFAULT_COPILOT_API_BASE_URL,
      };
    }
  }

  // Fall back to legacy unpartitioned cache file for smooth upgrades.
  if (!params.cachePath) {
    const legacyCachePath = path.join(
      resolveStateDir(env),
      "credentials",
      "github-copilot.token.json",
    );
    const legacyCached = loadJsonFileFn(legacyCachePath) as CachedCopilotToken | undefined;
    if (
      legacyCached &&
      typeof legacyCached.token === "string" &&
      typeof legacyCached.expiresAt === "number"
    ) {
      const legacyHashMatches = legacyCached.githubTokenHash === tokenHash;
      if (legacyHashMatches && isTokenUsable(legacyCached)) {
        // Migrate: persist into the new per-profile cache so subsequent reads hit the fast path.
        saveJsonFileFn(cachePath, {
          ...legacyCached,
          githubTokenHash: tokenHash,
          updatedAt: Date.now(),
        });
        return {
          token: legacyCached.token,
          expiresAt: legacyCached.expiresAt,
          source: `cache:${legacyCachePath}`,
          baseUrl:
            deriveCopilotApiBaseUrlFromToken(legacyCached.token) ?? DEFAULT_COPILOT_API_BASE_URL,
        };
      }
    }
  }

  const fetchImpl = params.fetchImpl ?? fetch;
  const res = await fetchImpl(COPILOT_TOKEN_URL, {
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
    githubTokenHash: tokenHash,
  };
  saveJsonFileFn(cachePath, payload);

  return {
    token: payload.token,
    expiresAt: payload.expiresAt,
    source: `fetched:${COPILOT_TOKEN_URL}`,
    baseUrl: deriveCopilotApiBaseUrlFromToken(payload.token) ?? DEFAULT_COPILOT_API_BASE_URL,
  };
}
