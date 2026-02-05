/**
 * Internal Config API Server
 *
 * Phase 2 of Agent Firewall: Tailscale-authenticated service for serving
 * behavioral core configuration files.
 *
 * Security features:
 * - Binds ONLY to Tailscale interface (100.x.x.x)
 * - Verifies every request via `tailscale whois`
 * - Returns SHA-256 hash with every response for integrity verification
 * - Logs all requests to security event log
 */

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import { pickPrimaryTailnetIPv4 } from "../infra/tailnet.js";
import { getTailscaleBinary } from "../infra/tailscale.js";
import { runExec } from "../process/exec.js";
import { logSecurityEvent, SecurityEventTypes } from "./security-logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Behavioral core directory (relative to project root)
const BEHAVIORAL_CORE_DIR = path.resolve(__dirname, "../../internal/behavioral-core");

// Default port for internal config API
export const DEFAULT_CONFIG_API_PORT = 18790;

// File mappings from API paths to behavioral core locations
const FILE_MAPPINGS: Record<string, string> = {
  // Primary configs
  "/config/soul": "soul/SOUL.md",
  "/config/agents": "agents/AGENTS.md",
  "/config/tools": "tools/TOOLS.md",
  "/config/bootstrap": "bootstrap/BOOTSTRAP.md",
  "/config/heartbeat": "heartbeat/HEARTBEAT.md",
  "/config/identity": "identity/IDENTITY.md",
  "/config/user": "user/USER.md",
  "/config/repo-agents": "agents/REPO_AGENTS.md",

  // Hook configs
  "/hooks/boot-md": "hooks/bundled/boot-md-HOOK.md",
  "/hooks/command-logger": "hooks/bundled/command-logger-HOOK.md",
  "/hooks/session-memory": "hooks/bundled/session-memory-HOOK.md",
  "/hooks/soul-evil": "hooks/bundled/soul-evil-HOOK.md",
};

export interface TailscaleWhoisResult {
  valid: boolean;
  nodeId?: string;
  nodeName?: string;
  userLogin?: string;
  tailnet?: string;
  ipAddress?: string;
  error?: string;
}

export interface ConfigAPIRequest {
  path: string;
  remoteAddress: string;
  whoisResult: TailscaleWhoisResult;
  timestamp: string;
}

export interface ConfigAPIResponse {
  content: string;
  sha256: string;
  path: string;
  servedAt: string;
}

/**
 * Verify a request via Tailscale whois.
 * Returns identity information if the request is from a valid Tailscale node.
 */
export async function verifyTailscaleWhois(
  remoteAddress: string,
  exec: typeof runExec = runExec,
  getTailscaleBin: typeof getTailscaleBinary = getTailscaleBinary,
): Promise<TailscaleWhoisResult> {
  // Strip IPv6 prefix if present (::ffff:100.x.x.x -> 100.x.x.x)
  const cleanAddress = remoteAddress.replace(/^::ffff:/, "");

  // Verify it's a Tailscale IP (100.64.0.0/10)
  const parts = cleanAddress.split(".");
  if (parts.length !== 4) {
    return { valid: false, error: "Invalid IP format", ipAddress: cleanAddress };
  }

  const [a, b] = parts.map((p) => Number.parseInt(p, 10));
  if (!(a === 100 && b >= 64 && b <= 127)) {
    return { valid: false, error: "Not a Tailscale IP", ipAddress: cleanAddress };
  }

  try {
    const tailscaleBin = await getTailscaleBin();
    const { stdout } = await exec(tailscaleBin, ["whois", "--json", cleanAddress], {
      timeoutMs: 5000,
    });

    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    const node = parsed.Node as Record<string, unknown> | undefined;
    const user = parsed.UserProfile as Record<string, unknown> | undefined;

    return {
      valid: true,
      nodeId: typeof node?.ID === "number" ? String(node.ID) : undefined,
      nodeName: typeof node?.Name === "string" ? node.Name : undefined,
      userLogin: typeof user?.LoginName === "string" ? user.LoginName : undefined,
      tailnet: typeof node?.Name === "string" ? node.Name.split(".").slice(1).join(".") : undefined,
      ipAddress: cleanAddress,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { valid: false, error: `Whois failed: ${message}`, ipAddress: cleanAddress };
  }
}

/**
 * Compute SHA-256 hash of content.
 */
export function computeHash(content: string): string {
  return crypto.createHash("sha256").update(content, "utf-8").digest("hex");
}

/**
 * Resolve behavioral core file path.
 * Returns null if path is invalid or attempts directory traversal.
 */
function resolveFilePath(apiPath: string): string | null {
  const relativePath = FILE_MAPPINGS[apiPath];
  if (!relativePath) return null;

  const fullPath = path.join(BEHAVIORAL_CORE_DIR, relativePath);

  // Prevent directory traversal
  const resolved = path.resolve(fullPath);
  if (!resolved.startsWith(BEHAVIORAL_CORE_DIR)) {
    return null;
  }

  return resolved;
}

/**
 * Load all skill files from a category.
 */
async function loadSkillsFromCategory(category: string): Promise<Record<string, string>> {
  const categoryDir = path.join(BEHAVIORAL_CORE_DIR, "skills", category);
  const skills: Record<string, string> = {};

  try {
    const files = await fs.readdir(categoryDir);
    for (const file of files) {
      if (file.endsWith("-SKILL.md")) {
        const skillName = file.replace("-SKILL.md", "");
        const content = await fs.readFile(path.join(categoryDir, file), "utf-8");
        skills[skillName] = content;
      }
    }
  } catch {
    // Category doesn't exist or can't be read
  }

  return skills;
}

/**
 * Handle incoming request.
 */
async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  verifyWhois: typeof verifyTailscaleWhois = verifyTailscaleWhois,
): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const apiPath = url.pathname;
  const remoteAddress = req.socket.remoteAddress ?? "unknown";
  const timestamp = new Date().toISOString();

  // Verify Tailscale identity
  const whoisResult = await verifyWhois(remoteAddress);

  // Log all requests
  logSecurityEvent({
    type: SecurityEventTypes.CONFIG_API_REQUEST,
    source: "config-api",
    blocked: false,
    details: {
      path: apiPath,
      remoteAddress,
      nodeId: whoisResult.nodeId,
      nodeName: whoisResult.nodeName,
      userLogin: whoisResult.userLogin,
      tailnet: whoisResult.tailnet,
    },
  });

  // Reject non-Tailscale requests
  if (!whoisResult.valid) {
    logSecurityEvent({
      type: SecurityEventTypes.CONFIG_API_AUTH_FAILURE,
      source: "config-api",
      blocked: true,
      details: {
        path: apiPath,
        remoteAddress,
        error: whoisResult.error,
      },
    });

    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Forbidden: Not a valid Tailscale connection" }));
    return;
  }

  // Log successful auth
  logSecurityEvent({
    type: SecurityEventTypes.CONFIG_API_AUTH_SUCCESS,
    source: "config-api",
    blocked: false,
    details: {
      path: apiPath,
      nodeId: whoisResult.nodeId,
      nodeName: whoisResult.nodeName,
      userLogin: whoisResult.userLogin,
    },
  });

  // Handle health check
  if (apiPath === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", timestamp }));
    return;
  }

  // Handle manifest request (list all available files with hashes)
  if (apiPath === "/manifest") {
    try {
      const manifest: Record<string, { path: string; sha256: string }> = {};

      for (const [api, relative] of Object.entries(FILE_MAPPINGS)) {
        const fullPath = path.join(BEHAVIORAL_CORE_DIR, relative);
        try {
          const content = await fs.readFile(fullPath, "utf-8");
          manifest[api] = { path: relative, sha256: computeHash(content) };
        } catch {
          // File doesn't exist
        }
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ manifest, timestamp }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Failed to generate manifest" }));
    }
    return;
  }

  // Handle skills listing by category
  if (apiPath.startsWith("/skills/")) {
    const category = apiPath.slice("/skills/".length);
    if (
      ["communication", "productivity", "development", "integration", "utility"].includes(category)
    ) {
      try {
        const skills = await loadSkillsFromCategory(category);
        const skillsWithHashes = Object.fromEntries(
          Object.entries(skills).map(([name, content]) => [
            name,
            { content, sha256: computeHash(content) },
          ]),
        );

        res.writeHead(200, {
          "Content-Type": "application/json",
          "X-Config-Timestamp": timestamp,
        });
        res.end(JSON.stringify({ category, skills: skillsWithHashes, timestamp }));
        return;
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `Failed to load skills for category: ${category}` }));
        return;
      }
    }
  }

  // Handle config file request
  const filePath = resolveFilePath(apiPath);
  if (!filePath) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found", path: apiPath }));
    return;
  }

  try {
    const content = await fs.readFile(filePath, "utf-8");
    const sha256 = computeHash(content);

    const response: ConfigAPIResponse = {
      content,
      sha256,
      path: apiPath,
      servedAt: timestamp,
    };

    res.writeHead(200, {
      "Content-Type": "application/json",
      "X-Config-SHA256": sha256,
      "X-Config-Timestamp": timestamp,
    });
    res.end(JSON.stringify(response));
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Failed to read config file", path: apiPath }));
  }
}

export interface ConfigAPIServer {
  server: http.Server;
  address: string;
  port: number;
  stop: () => Promise<void>;
}

/**
 * Start the internal config API server.
 * Binds ONLY to Tailscale interface.
 */
export async function startConfigAPI(opts?: {
  port?: number;
  host?: string;
}): Promise<ConfigAPIServer> {
  const port = opts?.port ?? DEFAULT_CONFIG_API_PORT;

  // Get Tailscale IP to bind to (or use provided host for testing)
  const tailscaleIP = opts?.host ?? pickPrimaryTailnetIPv4();

  if (!tailscaleIP) {
    throw new Error(
      "Cannot start internal config API: No Tailscale interface detected. " +
        "Ensure Tailscale is connected before starting the config API.",
    );
  }

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      console.error("[CONFIG-API] Request handler error:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);

    server.listen(port, tailscaleIP, () => {
      const addr = server.address();
      const boundPort = typeof addr === "object" && addr ? addr.port : port;
      const boundHost = typeof addr === "object" && addr ? addr.address : tailscaleIP;

      console.log(`[CONFIG-API] Internal config API listening on ${boundHost}:${boundPort}`);
      console.log(`[CONFIG-API] Tailscale-only binding enforced`);

      logSecurityEvent({
        type: SecurityEventTypes.CONFIG_API_REQUEST,
        source: "config-api-startup",
        blocked: false,
        details: {
          event: "server_started",
          host: boundHost,
          port: boundPort,
        },
      });

      resolve({
        server,
        address: boundHost,
        port: boundPort,
        stop: async () => {
          return new Promise((resolveStop) => {
            server.close(() => {
              console.log("[CONFIG-API] Server stopped");
              resolveStop();
            });
          });
        },
      });
    });
  });
}

/**
 * Client function to fetch config from internal API.
 * Used by agent config loading to retrieve behavioral core files.
 */
export async function fetchConfigFromAPI(
  apiPath: string,
  opts?: { host?: string; port?: number; expectedHash?: string },
): Promise<ConfigAPIResponse> {
  const host = opts?.host ?? pickPrimaryTailnetIPv4();
  const port = opts?.port ?? DEFAULT_CONFIG_API_PORT;

  if (!host) {
    throw new Error("Cannot fetch config: No Tailscale interface detected");
  }

  const url = `http://${host}:${port}${apiPath}`;

  const response = await fetch(url);

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Config API request failed: ${response.status} ${body}`);
  }

  const data = (await response.json()) as ConfigAPIResponse;

  // Verify hash if expected hash provided
  if (opts?.expectedHash && data.sha256 !== opts.expectedHash) {
    logSecurityEvent({
      type: SecurityEventTypes.CONFIG_API_HASH_MISMATCH,
      source: "config-api-client",
      blocked: true,
      details: {
        path: apiPath,
        expectedHash: opts.expectedHash,
        actualHash: data.sha256,
      },
    });
    throw new Error(
      `Config integrity check failed: expected ${opts.expectedHash}, got ${data.sha256}`,
    );
  }

  return data;
}
