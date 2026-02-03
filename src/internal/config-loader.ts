/**
 * Secure Config Loader
 *
 * Phase 2.6: Unified config loading that prioritizes internal API
 * but falls back to disk when API is unavailable.
 *
 * This loader:
 * 1. Checks if internal config API is available
 * 2. Fetches behavioral core files from API with hash verification
 * 3. Falls back to disk read if API unavailable
 * 4. Logs all loading decisions for audit trail
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { pickPrimaryTailnetIPv4 } from "../infra/tailnet.js";
import { logSecurityEvent, SecurityEventTypes } from "./security-logger.js";
import {
  DEFAULT_CONFIG_API_PORT,
  fetchConfigFromAPI,
  computeHash,
  type ConfigAPIResponse,
} from "./config-api.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Behavioral core directory (for fallback disk reads)
const BEHAVIORAL_CORE_DIR = path.resolve(__dirname, "../../internal/behavioral-core");

// Known hashes for integrity verification (populated during startup)
let knownHashes: Map<string, string> | null = null;

export interface LoadedConfig {
  name: string;
  content: string;
  sha256: string;
  source: "api" | "disk" | "fallback";
  verified: boolean;
}

export interface ConfigLoaderOptions {
  /** Force disk loading (bypass API) */
  forceLocalRead?: boolean;
  /** API host override (for testing) */
  apiHost?: string;
  /** API port override */
  apiPort?: number;
  /** Expected hashes for verification */
  expectedHashes?: Map<string, string>;
}

/**
 * Check if internal config API is reachable.
 */
async function isConfigAPIAvailable(opts?: { host?: string; port?: number }): Promise<boolean> {
  const host = opts?.host ?? pickPrimaryTailnetIPv4();
  const port = opts?.port ?? DEFAULT_CONFIG_API_PORT;

  if (!host) {
    return false;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);

    const response = await fetch(`http://${host}:${port}/health`, {
      signal: controller.signal,
    });

    clearTimeout(timeout);
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Load config manifest from API to get expected hashes.
 */
async function loadManifestFromAPI(opts?: {
  host?: string;
  port?: number;
}): Promise<Map<string, string> | null> {
  const host = opts?.host ?? pickPrimaryTailnetIPv4();
  const port = opts?.port ?? DEFAULT_CONFIG_API_PORT;

  if (!host) return null;

  try {
    const response = await fetch(`http://${host}:${port}/manifest`);
    if (!response.ok) return null;

    const data = (await response.json()) as {
      manifest: Record<string, { path: string; sha256: string }>;
    };

    const hashes = new Map<string, string>();
    for (const [apiPath, info] of Object.entries(data.manifest)) {
      hashes.set(apiPath, info.sha256);
    }

    return hashes;
  } catch {
    return null;
  }
}

/**
 * Map workspace file name to API path.
 */
function fileNameToAPIPath(fileName: string): string | null {
  const mapping: Record<string, string> = {
    "SOUL.md": "/config/soul",
    "AGENTS.md": "/config/agents",
    "TOOLS.md": "/config/tools",
    "BOOTSTRAP.md": "/config/bootstrap",
    "HEARTBEAT.md": "/config/heartbeat",
    "IDENTITY.md": "/config/identity",
    "USER.md": "/config/user",
  };
  return mapping[fileName] ?? null;
}

/**
 * Map workspace file name to disk path in behavioral core.
 */
function fileNameToDiskPath(fileName: string): string | null {
  const mapping: Record<string, string> = {
    "SOUL.md": "soul/SOUL.md",
    "AGENTS.md": "agents/AGENTS.md",
    "TOOLS.md": "tools/TOOLS.md",
    "BOOTSTRAP.md": "bootstrap/BOOTSTRAP.md",
    "HEARTBEAT.md": "heartbeat/HEARTBEAT.md",
  };
  const relative = mapping[fileName];
  if (!relative) return null;
  return path.join(BEHAVIORAL_CORE_DIR, relative);
}

/**
 * Load a single config file, preferring API over disk.
 */
export async function loadConfigFile(
  fileName: string,
  opts?: ConfigLoaderOptions,
): Promise<LoadedConfig | null> {
  const apiPath = fileNameToAPIPath(fileName);
  const diskPath = fileNameToDiskPath(fileName);

  // Try API first (unless forced local)
  if (!opts?.forceLocalRead && apiPath) {
    const apiAvailable = await isConfigAPIAvailable({
      host: opts?.apiHost,
      port: opts?.apiPort,
    });

    if (apiAvailable) {
      try {
        const expectedHash = opts?.expectedHashes?.get(apiPath) ?? knownHashes?.get(apiPath);

        const response = await fetchConfigFromAPI(apiPath, {
          host: opts?.apiHost,
          port: opts?.apiPort,
          expectedHash,
        });

        logSecurityEvent({
          type: SecurityEventTypes.CONFIG_API_REQUEST,
          source: "config-loader",
          blocked: false,
          details: {
            fileName,
            apiPath,
            source: "api",
            sha256: response.sha256,
            verified: !!expectedHash,
          },
        });

        return {
          name: fileName,
          content: response.content,
          sha256: response.sha256,
          source: "api",
          verified: !!expectedHash,
        };
      } catch (err) {
        // API fetch failed, will fall back to disk
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[CONFIG-LOADER] API fetch failed for ${fileName}: ${message}`);

        // If it was a hash mismatch, this is a security event - don't fall back
        if (message.includes("integrity check failed")) {
          logSecurityEvent({
            type: SecurityEventTypes.CONFIG_API_HASH_MISMATCH,
            source: "config-loader",
            blocked: true,
            details: { fileName, apiPath, error: message },
          });
          throw err;
        }
      }
    }
  }

  // Fall back to disk read from behavioral core
  if (diskPath) {
    try {
      const content = await fs.readFile(diskPath, "utf-8");
      const sha256 = computeHash(content);

      // Verify against known hash if available
      const expectedHash =
        opts?.expectedHashes?.get(apiPath ?? "") ?? knownHashes?.get(apiPath ?? "");
      const verified = expectedHash ? sha256 === expectedHash : false;

      if (expectedHash && !verified) {
        logSecurityEvent({
          type: SecurityEventTypes.INTEGRITY_CHECK_FAILED,
          source: "config-loader",
          blocked: true,
          details: {
            fileName,
            diskPath,
            expectedHash,
            actualHash: sha256,
          },
        });
        throw new Error(
          `Config integrity check failed for ${fileName}: expected ${expectedHash}, got ${sha256}`,
        );
      }

      logSecurityEvent({
        type: SecurityEventTypes.CONFIG_API_REQUEST,
        source: "config-loader",
        blocked: false,
        details: {
          fileName,
          diskPath,
          source: "disk",
          sha256,
          verified,
        },
      });

      return {
        name: fileName,
        content,
        sha256,
        source: "disk",
        verified,
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
      // File doesn't exist in behavioral core
    }
  }

  return null;
}

/**
 * Load all bootstrap config files.
 * Prioritizes internal API, falls back to disk.
 */
export async function loadAllBootstrapConfigs(
  opts?: ConfigLoaderOptions,
): Promise<Map<string, LoadedConfig>> {
  const files = ["SOUL.md", "AGENTS.md", "TOOLS.md", "BOOTSTRAP.md", "HEARTBEAT.md"];
  const results = new Map<string, LoadedConfig>();

  // Load manifest for hash verification
  if (!opts?.forceLocalRead && !knownHashes) {
    knownHashes = await loadManifestFromAPI({
      host: opts?.apiHost,
      port: opts?.apiPort,
    });
  }

  for (const fileName of files) {
    const config = await loadConfigFile(fileName, opts);
    if (config) {
      results.set(fileName, config);
    }
  }

  return results;
}

/**
 * Initialize the config loader with known good hashes.
 * Call this at startup to establish baseline for integrity checks.
 */
export async function initializeConfigLoader(opts?: {
  apiHost?: string;
  apiPort?: number;
}): Promise<{ initialized: boolean; source: "api" | "none"; hashCount: number }> {
  const manifest = await loadManifestFromAPI(opts);

  if (manifest) {
    knownHashes = manifest;
    return {
      initialized: true,
      source: "api",
      hashCount: manifest.size,
    };
  }

  return {
    initialized: false,
    source: "none",
    hashCount: 0,
  };
}

/**
 * Get current known hashes (for debugging/verification).
 */
export function getKnownHashes(): Map<string, string> | null {
  return knownHashes ? new Map(knownHashes) : null;
}

/**
 * Clear cached hashes (for testing).
 */
export function clearKnownHashes(): void {
  knownHashes = null;
}
