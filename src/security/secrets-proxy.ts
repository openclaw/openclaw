import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { request } from "undici";
import { createSubsystemLogger } from "../logging/subsystem.js";

import { loadAllowlist, isDomainAllowed } from "./secrets-proxy-allowlist.js";

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

/**
 * Replaces {{VAR_NAME}} with process.env.VAR_NAME.
 * Includes DoS protection with replacement limits.
 */
function replacePlaceholders(text: string): string {
  let count = 0;
  const startTime = Date.now();
  
  return text.replace(/\{\{(\w+)\}\}/g, (match, name) => {
    // Check timeout
    if (Date.now() - startTime > PLACEHOLDER_LIMITS.timeoutMs) {
      logger.warn(`Placeholder replacement timeout reached`);
      return match; // Return original on timeout
    }
    
    // Check replacement limit
    if (count++ >= PLACEHOLDER_LIMITS.maxReplacements) {
      logger.warn(`Placeholder replacement limit reached (${PLACEHOLDER_LIMITS.maxReplacements})`);
      return `{{LIMIT_REACHED:${name}}}`;
    }
    
    return process.env[name] ?? "";
  });
}

export type SecretsProxyOptions = {
  port: number;
  bind?: string;
};

export async function startSecretsProxy(opts: SecretsProxyOptions): Promise<http.Server> {
  const allowedDomains = loadAllowlist();

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
      const targetUrl = req.headers["x-target-url"];
      if (typeof targetUrl !== "string" || !targetUrl) {
        res.statusCode = 400;
        res.end("Missing X-Target-URL header");
        return;
      }

      // Validate target URL before checking allowlist
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(targetUrl);
      } catch {
        res.statusCode = 400;
        res.end("Invalid X-Target-URL");
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

      // P0 Fix: Only read and process body for methods that should have one
      let modifiedBody: string | undefined;
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
          const rawBody = Buffer.concat(chunks).toString("utf8");
          modifiedBody = replacePlaceholders(rawBody);
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
          headers[key] = replacePlaceholders(value);
        } else if (Array.isArray(value)) {
          // P1 Fix: Handle string[] headers by joining
          headers[key] = value.map(v => replacePlaceholders(v)).join(", ");
        }
      }

      logger.info(`Proxying request: ${method} ${targetUrl}`);

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
