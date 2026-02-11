import http, { type IncomingMessage, type ServerResponse } from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { request } from "undici";
import type { SecretRegistry } from "./secrets-registry.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { loadAllowlist, isDomainAllowed } from "./secrets-proxy-allowlist.js";
import { resolveOAuthToken } from "./secrets-registry.js";
import { STATE_DIR } from "../config/paths.js";

const logger = createSubsystemLogger("security/secrets-proxy");

// ---------------------------------------------------------------------------
// Allowlist cache — re-reads from disk only when the config file changes
// ---------------------------------------------------------------------------
const ALLOWLIST_CONFIG_PATH = path.join(STATE_DIR, "secrets-proxy-config.json");
let _cachedAllowlist: string[] | null = null;
let _allowlistMtimeMs = 0;

function getCachedAllowlist(): string[] {
  try {
    const stat = fs.statSync(ALLOWLIST_CONFIG_PATH, { throwIfNoEntry: false });
    const mtime = stat?.mtimeMs ?? 0;
    if (!_cachedAllowlist || mtime !== _allowlistMtimeMs) {
      _cachedAllowlist = loadAllowlist();
      _allowlistMtimeMs = mtime;
    }
  } catch {
    if (!_cachedAllowlist) _cachedAllowlist = loadAllowlist();
  }
  return _cachedAllowlist;
}

// DoS Protection Limits (from SECURITY.MD)
const PLACEHOLDER_LIMITS = {
  maxDepth: 10,
  maxReplacements: 50,
  timeoutMs: 100,
};

const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB max request body
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// Methods that should NOT have a body per HTTP spec
const BODYLESS_METHODS = new Set(["GET", "HEAD", "OPTIONS", "TRACE"]);

// Placeholder patterns
// Profile IDs can contain: word chars, hyphens, colons, @, dots (e.g., google-gemini-cli:developer@example.com)
const PATTERNS = {
  CONFIG: /\{\{CONFIG:([\w.]+)\}\}/g, // {{CONFIG:channels.discord.token}}
  OAUTH: /\{\{OAUTH:([\w\-:@.]+)\}\}/g, // {{OAUTH:google-gemini-cli:user@example.com}}
  OAUTH_REFRESH: /\{\{OAUTH_REFRESH:([\w\-:@.]+)\}\}/g, // {{OAUTH_REFRESH:google-gemini-cli:user@example.com}}
  APIKEY: /\{\{APIKEY:([\w\-:@.]+)\}\}/g, // {{APIKEY:anthropic}}
  TOKEN: /\{\{TOKEN:([\w\-:@.]+)\}\}/g, // {{TOKEN:github-copilot}}
  ENV: /\{\{([A-Z_][A-Z0-9_]*)\}\}/g, // {{ANTHROPIC_API_KEY}}
};

/**
 * Resolve CONFIG placeholder by traversing the config secrets object.
 * Maps placeholder paths to the correct registry subtrees.
 */
function resolveConfigPath(path: string, registry: SecretRegistry): string | object | null {
  const parts = path.split(".");

  // channels.X.Y -> registry.channelSecrets.X.Y
  if (parts[0] === "channels" && parts.length >= 3) {
    const channel = parts[1] as keyof typeof registry.channelSecrets;
    const channelSecrets = registry.channelSecrets[channel];
    if (channelSecrets && typeof channelSecrets === "object") {
      const key = parts[2] as keyof typeof channelSecrets;
      return ((channelSecrets as Record<string, unknown>)[key] as string | object | null) ?? null;
    }
    return null;
  }

  // gateway.auth.token -> registry.gatewaySecrets.authToken
  // gateway.auth.password -> registry.gatewaySecrets.authPassword
  // gateway.remote.token -> registry.gatewaySecrets.remoteToken
  // gateway.remote.password -> registry.gatewaySecrets.remotePassword
  if (parts[0] === "gateway" && parts.length === 3) {
    const section = parts[1]; // "auth" or "remote"
    const field = parts[2]; // "token" or "password"
    // Convert to camelCase: auth + Token = authToken, remote + Password = remotePassword
    const camelKey = `${section}${field.charAt(0).toUpperCase()}${field.slice(1)}`;
    return (registry.gatewaySecrets as Record<string, string | undefined>)[camelKey] ?? null;
  }

  // talk.apiKey -> registry.gatewaySecrets.talkApiKey
  if (parts[0] === "talk" && parts[1] === "apiKey") {
    return registry.gatewaySecrets.talkApiKey ?? null;
  }

  // env.vars.KEY -> registry.envVars.KEY
  if (parts[0] === "env" && parts[1] === "vars" && parts.length === 3) {
    return registry.envVars[parts[2]] ?? null;
  }

  // tools.* -> registry.toolSecrets.*
  if (parts[0] === "tools") {
    let current: unknown = registry.toolSecrets;
    for (let i = 1; i < parts.length && current; i++) {
      current = (current as Record<string, unknown>)[parts[i]];
    }
    return typeof current === "string" ? current : null;
  }

  return null;
}

/**
 * Replaces all placeholder types with actual secrets.
 * Includes DoS protection with replacement limits.
 */
async function replacePlaceholders(text: string, registry: SecretRegistry): Promise<string> {
  let count = 0;
  let limitHit = false;
  const startTime = Date.now();

  // Each .replace() callback below is invoked once per regex match.
  // count++ inside each callback ensures the limit is enforced per individual match.
  const checkLimits = () => {
    if (limitHit) return true;
    if (Date.now() - startTime > PLACEHOLDER_LIMITS.timeoutMs) {
      logger.warn(`Placeholder replacement timeout reached`);
      limitHit = true;
      return true;
    }
    if (count >= PLACEHOLDER_LIMITS.maxReplacements) {
      logger.warn(`Placeholder replacement limit reached (${PLACEHOLDER_LIMITS.maxReplacements})`);
      limitHit = true;
      return true;
    }
    return false;
  };

  // 1. Replace CONFIG placeholders
  text = text.replace(PATTERNS.CONFIG, (match, path) => {
    if (checkLimits()) {
      return match;
    }
    count++;
    const value = resolveConfigPath(path, registry);
    if (value === null || value === undefined) {
      logger.warn(`Config secret not found: ${path}`);
      return "";
    }
    // Handle object values (like serviceAccount)
    return typeof value === "object" ? JSON.stringify(value) : String(value);
  });

  // 2. Replace OAUTH placeholders (async, with refresh)
  const oauthMatches = [...text.matchAll(PATTERNS.OAUTH)];
  for (const match of oauthMatches) {
    if (checkLimits()) {
      break;
    }
    count++;
    const profileId = match[1];
    const token = await resolveOAuthToken(registry, profileId);
    if (token) {
      text = text.replace(match[0], token);
    } else {
      logger.warn(`OAuth token not found for profile: ${profileId}`);
    }
  }

  // 2b. Replace OAUTH_REFRESH placeholders (refresh tokens)
  // Read from authStore.profiles (not oauthProfiles) to get updated tokens after refresh
  text = text.replace(PATTERNS.OAUTH_REFRESH, (match, profileId) => {
    if (checkLimits()) {
      return match;
    }
    count++;
    const cred = registry.authStore.profiles[profileId];
    if (cred?.type !== "oauth" || !cred?.refresh) {
      logger.warn(`OAuth refresh token not found for profile: ${profileId}`);
      return "";
    }
    return cred.refresh;
  });

  // 3. Replace APIKEY placeholders
  text = text.replace(PATTERNS.APIKEY, (match, profileId) => {
    if (checkLimits()) {
      return match;
    }
    count++;
    const key = registry.apiKeys.get(profileId);
    if (!key) {
      logger.warn(`API key not found for profile: ${profileId}`);
      return "";
    }
    return key;
  });

  // 4. Replace TOKEN placeholders
  text = text.replace(PATTERNS.TOKEN, (match, profileId) => {
    if (checkLimits()) {
      return match;
    }
    count++;
    const token = registry.tokens.get(profileId);
    if (!token) {
      logger.warn(`Token not found for profile: ${profileId}`);
      return "";
    }
    return token;
  });

  // 5. Replace ENV placeholders (process.env)
  text = text.replace(PATTERNS.ENV, (match, name) => {
    if (checkLimits()) {
      return match;
    }
    count++;
    return process.env[name] ?? registry.envVars[name] ?? "";
  });

  return text;
}

export type SecretsProxyOptions = {
  /** TCP port (required for TCP mode, used on Windows). */
  port?: number;
  /** TCP bind address (default: 127.0.0.1). Only used in TCP mode. */
  bind?: string;
  /** Unix socket path. When set, proxy listens on this socket instead of TCP. */
  socketPath?: string;
  registry: SecretRegistry;
  /** Shared secret token that clients must send in X-Proxy-Token header. */
  authToken: string;
};

/** Generate a random proxy auth token. */
export function generateProxyAuthToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export async function startSecretsProxy(opts: SecretsProxyOptions): Promise<http.Server> {
  const { registry, authToken } = opts;

  if (!authToken) {
    throw new Error("authToken is required — the secrets proxy must not run without authentication");
  }

  const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // Cached allowlist: re-reads from disk only when config file mtime changes
    const allowedDomains = getCachedAllowlist();
    // Set request timeout
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      logger.warn(`Request timeout after ${REQUEST_TIMEOUT_MS}ms`);
      if (!res.headersSent) {
        res.statusCode = 408;
        res.end("Request Timeout");
      }
    });

    try {
      // Authenticate client via shared secret (prevents untrusted local processes from using the proxy)
      if (authToken) {
        const rawToken = req.headers["x-proxy-token"];
        const clientToken = Array.isArray(rawToken) ? rawToken[0] : rawToken;
        if (clientToken !== authToken) {
          logger.warn(`Rejected unauthenticated proxy request from ${req.socket.remoteAddress}`);
          res.statusCode = 403;
          res.end("Invalid or missing X-Proxy-Token");
          return;
        }
      }

      const rawTargetUrl = req.headers["x-target-url"];
      if (typeof rawTargetUrl !== "string" || !rawTargetUrl) {
        res.statusCode = 400;
        res.end("Missing X-Target-URL header");
        return;
      }

      // CRITICAL: Resolve placeholders in the URL (e.g., for Telegram bot token in path)
      const targetUrl = await replacePlaceholders(rawTargetUrl, registry);

      // Validate target URL before checking allowlist
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(targetUrl);
      } catch {
        res.statusCode = 400;
        res.end("Invalid X-Target-URL");
        return;
      }

      // Reject URLs with userinfo to prevent credential injection
      if (parsedUrl.username || parsedUrl.password) {
        logger.warn(`Blocked request with userinfo in URL: ${parsedUrl.hostname}`);
        res.statusCode = 400;
        res.end("URL userinfo not allowed");
        return;
      }

      if (!isDomainAllowed(parsedUrl.toString(), allowedDomains)) {
        logger.warn(`Blocked request to unauthorized domain: ${parsedUrl.hostname}`);
        res.statusCode = 403;
        res.end(`Domain not in allowlist: ${parsedUrl.hostname}`);
        return;
      }

      const method = (req.method || "GET").toUpperCase();
      const hasBody = !BODYLESS_METHODS.has(method);

      // Determine if body is text-based (safe for placeholder replacement).
      // Only treat explicitly text-typed bodies as text; missing Content-Type
      // is forwarded as raw binary to avoid corrupting non-text payloads.
      const contentType = (req.headers["content-type"] || "").toLowerCase();
      const isTextBody =
        contentType.includes("application/json") ||
        contentType.includes("+json") || // e.g. application/vnd.api+json
        contentType.includes("text/") ||
        contentType.includes("application/xml") ||
        contentType.includes("+xml") || // e.g. application/atom+xml
        contentType.includes("application/x-www-form-urlencoded") ||
        contentType.includes("application/javascript") ||
        contentType.includes("application/graphql");

      // P0 Fix: Only read and process body for methods that should have one
      let modifiedBody: Buffer | string | undefined;
      if (hasBody) {
        const chunks: Buffer[] = [];
        let totalSize = 0;
        for await (const chunk of req) {
          totalSize += chunk.length;
          if (totalSize > MAX_BODY_SIZE) {
            res.statusCode = 413;
            res.end(`Request body too large (max ${MAX_BODY_SIZE / 1024 / 1024}MB)`);
            return;
          }
          chunks.push(chunk);
        }

        if (chunks.length > 0) {
          const rawBuffer = Buffer.concat(chunks);
          if (isTextBody) {
            // Text body: do placeholder replacement
            const rawBody = rawBuffer.toString("utf8");
            modifiedBody = await replacePlaceholders(rawBody, registry);
          } else {
            // Binary body: pass through unchanged to avoid corruption
            modifiedBody = rawBuffer;
          }
        }
      } else {
        // Drain the body for bodyless methods (ignore any sent body)
        for await (const _ of req) {
          // Discard
        }
      }

      // Prepare headers - filter out hop-by-hop and the special target header
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        const lowerKey = key.toLowerCase();
        if (
          lowerKey === "x-target-url" ||
          lowerKey === "x-proxy-token" || // Don't leak proxy auth token to target
          lowerKey === "host" ||
          lowerKey === "connection" ||
          lowerKey === "transfer-encoding" ||
          lowerKey === "content-length" // Let undici recalculate
        ) {
          continue;
        }
        if (typeof value === "string") {
          headers[lowerKey] = await replacePlaceholders(value, registry);
        } else if (Array.isArray(value)) {
          // P1 Fix: Handle string[] headers by joining
          const replaced = await Promise.all(value.map((v) => replacePlaceholders(v, registry)));
          headers[lowerKey] = replaced.join(", ");
        }
      }

      // Log only origin + pathname to avoid leaking secrets in URL path/query
      logger.info(`Proxying request: ${method} ${parsedUrl.origin}${parsedUrl.pathname}`);

      // Redirect handling: we intentionally do NOT block or follow 3xx responses.
      // undici v7 request() does not follow redirects by default, so the raw 3xx
      // is returned to the caller. Explicit redirect blocking is unnecessary because
      // the gateway container runs on a Docker --internal network and can ONLY reach
      // the outside world through this proxy. If the client follows the Location header,
      // that follow-up request will route back through the proxy, where the target URL
      // is re-validated against the allowlist and credentials are re-injected as needed.
      // Use the normalized parsedUrl so the fetched URL matches the allowlist check
      const normalizedUrl = parsedUrl.toString();
      const response = await request(normalizedUrl, {
        method: method as import("undici").Dispatcher.HttpMethod,
        headers,
        body: hasBody ? modifiedBody : undefined,
      });

      res.statusCode = response.statusCode;

      // P1 Fix: Properly handle response headers (string | string[] | undefined)
      for (const [key, value] of Object.entries(response.headers)) {
        if (value === undefined || value === null) {
          continue;
        }

        // Skip hop-by-hop headers
        const lowerKey = key.toLowerCase();
        if (lowerKey === "transfer-encoding" || lowerKey === "connection") {
          continue;
        }

        if (typeof value === "string") {
          res.setHeader(key, value);
        } else if (Array.isArray(value)) {
          res.setHeader(key, value);
        }
      }

      // Stream the response back
      for await (const chunk of response.body) {
        res.write(chunk);
      }
      res.end();
    } catch (err) {
      // Log full error on host only; don't leak expanded URLs/headers to container
      logger.error(`Proxy error: ${String(err)}`);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end("Proxy Error: request failed");
      } else {
        res.end();
      }
    }
  });

  // Validate: exactly one of socketPath or port must be provided
  if (!opts.socketPath && !opts.port) {
    throw new Error("startSecretsProxy requires either socketPath (Linux/macOS) or port (Windows)");
  }
  if (opts.socketPath && opts.port) {
    throw new Error("startSecretsProxy: socketPath and port are mutually exclusive");
  }

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    if (opts.socketPath) {
      // Unix socket mode (Linux/macOS) — no TCP exposure at all
      // Remove stale socket file from previous session (prevents EADDRINUSE)
      try { fs.unlinkSync(opts.socketPath); } catch { /* doesn't exist, fine */ }
      server.listen(opts.socketPath, () => {
        // Restrict socket permissions to owner only (prevents other local users from connecting)
        try { fs.chmodSync(opts.socketPath!, 0o600); } catch { /* best effort */ }
        // Clean up socket file when server closes
        server.on("close", () => {
          try { fs.unlinkSync(opts.socketPath!); } catch { /* already gone */ }
        });
        logger.info(`Secrets Injection Proxy listening on socket: ${opts.socketPath}`);
        resolve(server);
      });
    } else {
      // TCP mode (Windows) — bind to loopback only
      const bind = opts.bind || "127.0.0.1";
      const port = opts.port!;
      server.listen(port, bind, () => {
        logger.info(`Secrets Injection Proxy listening on ${bind}:${port}`);
        resolve(server);
      });
    }
  });
}
