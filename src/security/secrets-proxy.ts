import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { request } from "undici";
import type { SecretRegistry } from "./secrets-registry.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { loadAllowlist, isDomainAllowed } from "./secrets-proxy-allowlist.js";
import { resolveOAuthToken } from "./secrets-registry.js";

const logger = createSubsystemLogger("security/secrets-proxy");

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
 */
function resolveConfigPath(path: string, registry: SecretRegistry): string | null {
  const parts = path.split(".");
  let current: any = registry;

  // Navigate: channels.discord.token -> registry.channelSecrets.discord.token
  if (parts[0] === "channels") {
    current = registry.channelSecrets[parts[1] as keyof typeof registry.channelSecrets];
    if (parts.length === 3 && current) {
      return current[parts[2]] ?? null;
    }
  } else if (parts[0] === "gateway") {
    // gateway.auth.token -> registry.gatewaySecrets.authToken
    const key = parts.slice(1).join(""); // auth.token -> authToken
    const camelKey = key.charAt(0).toLowerCase() + key.slice(1).replace(/\./g, "");
    return (registry.gatewaySecrets as any)[camelKey] ?? null;
  } else if (parts[0] === "talk" && parts[1] === "apiKey") {
    return registry.gatewaySecrets.talkApiKey ?? null;
  } else if (parts[0] === "tools") {
    // Traverse tools.* paths: tools.web.search.apiKey, tools.web.fetch.firecrawl.apiKey, etc.
    current = registry.toolSecrets;
    for (let i = 1; i < parts.length && current; i++) {
      current = current[parts[i]];
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
  const startTime = Date.now();

  const checkLimits = () => {
    if (Date.now() - startTime > PLACEHOLDER_LIMITS.timeoutMs) {
      logger.warn(`Placeholder replacement timeout reached`);
      return true;
    }
    if (count++ >= PLACEHOLDER_LIMITS.maxReplacements) {
      logger.warn(`Placeholder replacement limit reached (${PLACEHOLDER_LIMITS.maxReplacements})`);
      return true;
    }
    return false;
  };

  // 1. Replace CONFIG placeholders
  text = text.replace(PATTERNS.CONFIG, (match, path) => {
    if (checkLimits()) return match;
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
    if (checkLimits()) break;
    const profileId = match[1];
    const token = await resolveOAuthToken(registry, profileId);
    if (token) {
      text = text.replace(match[0], token);
    } else {
      logger.warn(`OAuth token not found for profile: ${profileId}`);
    }
  }

  // 2b. Replace OAUTH_REFRESH placeholders (refresh tokens)
  text = text.replace(PATTERNS.OAUTH_REFRESH, (match, profileId) => {
    if (checkLimits()) return match;
    const cred = registry.oauthProfiles.get(profileId);
    if (!cred?.refresh) {
      logger.warn(`OAuth refresh token not found for profile: ${profileId}`);
      return "";
    }
    return cred.refresh;
  });

  // 3. Replace APIKEY placeholders
  text = text.replace(PATTERNS.APIKEY, (match, profileId) => {
    if (checkLimits()) return match;
    const key = registry.apiKeys.get(profileId);
    if (!key) {
      logger.warn(`API key not found for profile: ${profileId}`);
      return "";
    }
    return key;
  });

  // 4. Replace TOKEN placeholders
  text = text.replace(PATTERNS.TOKEN, (match, profileId) => {
    if (checkLimits()) return match;
    const token = registry.tokens.get(profileId);
    if (!token) {
      logger.warn(`Token not found for profile: ${profileId}`);
      return "";
    }
    return token;
  });

  // 5. Replace ENV placeholders (process.env)
  text = text.replace(PATTERNS.ENV, (match, name) => {
    if (checkLimits()) return match;
    return process.env[name] ?? registry.envVars[name] ?? "";
  });

  return text;
}

export type SecretsProxyOptions = {
  port: number;
  bind?: string;
  registry: SecretRegistry;
};

export async function startSecretsProxy(opts: SecretsProxyOptions): Promise<http.Server> {
  const allowedDomains = loadAllowlist();
  const { registry } = opts;

  const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // Set request timeout
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      logger.warn(`Request timeout after ${REQUEST_TIMEOUT_MS}ms`);
      if (!res.headersSent) {
        res.statusCode = 408;
        res.end("Request Timeout");
      }
    });

    try {
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

      if (!isDomainAllowed(targetUrl, allowedDomains)) {
        logger.warn(`Blocked request to unauthorized domain: ${parsedUrl.hostname}`);
        res.statusCode = 403;
        res.end(`Domain not in allowlist: ${parsedUrl.hostname}`);
        return;
      }

      const method = (req.method || "GET").toUpperCase();
      const hasBody = !BODYLESS_METHODS.has(method);

      // Determine if body is text-based (safe for placeholder replacement)
      const contentType = (req.headers["content-type"] || "").toLowerCase();
      const isTextBody =
        contentType.includes("application/json") ||
        contentType.includes("text/") ||
        contentType.includes("application/xml") ||
        contentType.includes("application/x-www-form-urlencoded") ||
        contentType.includes("application/javascript") ||
        contentType === ""; // Assume text if no content-type (common for simple requests)

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
          lowerKey === "host" ||
          lowerKey === "connection" ||
          lowerKey === "transfer-encoding" ||
          lowerKey === "content-length" // Let undici recalculate
        ) {
          continue;
        }
        if (typeof value === "string") {
          headers[key] = await replacePlaceholders(value, registry);
        } else if (Array.isArray(value)) {
          // P1 Fix: Handle string[] headers by joining
          const replaced = await Promise.all(value.map((v) => replacePlaceholders(v, registry)));
          headers[key] = replaced.join(", ");
        }
      }

      logger.info(`Proxying request: ${method} ${rawTargetUrl}`);

      // P0 Fix: Only pass body for methods that should have one
      const response = await request(targetUrl, {
        method: method as any,
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
      logger.error(`Proxy error: ${String(err)}`);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end(`Proxy Error: ${String(err)}`);
      } else {
        res.end();
      }
    }
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(opts.port, opts.bind || "127.0.0.1", () => {
      logger.info(`Secrets Injection Proxy listening on ${opts.bind || "127.0.0.1"}:${opts.port}`);
      resolve(server);
    });
  });
}
