/**
 * MCP server installation scope management.
 *
 * Handles local → project → user scope resolution and config merging.
 * Mirrors the agent scope pattern in `src/config/agent-scope.ts`.
 *
 * Storage strategy:
 * - "user" scope  → SQLite (`op1_mcp_servers`, scope = 'user'), with YAML fallback
 * - "project" scope → YAML file (`<projectRoot>/.openclaw/mcp/servers.yaml`)
 * - "local" scope   → YAML file (`<projectRoot>/.openclaw/mcp.local/servers.yaml`)
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  deleteMcpServerFromDb,
  hasMcpServersInDb,
  loadMcpServersFromDb,
  saveMcpServerToDb,
} from "./servers-sqlite.js";
import type { McpConfig, McpScope, McpServerConfig } from "./types.js";

// ── Scope paths ──────────────────────────────────────────────────────────────

/**
 * Resolve the MCP config directory for a given scope.
 *
 * - local:   `<projectRoot>/.openclaw/mcp.local/`
 * - project: `<projectRoot>/.openclaw/mcp/`
 * - user:    `~/.openclaw/mcp/`
 */
export function mcpDirForScope(scope: McpScope, projectRoot: string): string {
  switch (scope) {
    case "local":
      return join(projectRoot, ".openclaw", "mcp.local");
    case "project":
      return join(projectRoot, ".openclaw", "mcp");
    case "user":
      return join(homedir(), ".openclaw", "mcp");
  }
}

/**
 * Resolve the MCP lock file path for a given scope.
 */
export function mcpLockFileForScope(scope: McpScope, projectRoot: string): string {
  switch (scope) {
    case "local":
      return join(projectRoot, ".openclaw", "mcp.local-lock.yaml");
    case "project":
      return join(projectRoot, ".openclaw", "mcp-lock.yaml");
    case "user":
      return join(homedir(), ".openclaw", "mcp-lock.yaml");
  }
}

// ── Internal YAML helpers (project / local scopes) ───────────────────────────

/**
 * Load servers from a YAML file for project or local scopes.
 * Returns an empty record if the file doesn't exist or is invalid.
 */
async function loadServersFromYaml(
  scope: McpScope,
  projectRoot: string,
): Promise<Record<string, McpServerConfig>> {
  const filePath = join(mcpDirForScope(scope, projectRoot), "servers.yaml");
  try {
    const content = await readFile(filePath, "utf-8");
    const parsed = parseYaml(content) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== "object") {
      return {};
    }
    const servers: Record<string, McpServerConfig> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (value && typeof value === "object" && "type" in value) {
        servers[key] = value as McpServerConfig;
      }
    }
    return servers;
  } catch {
    return {};
  }
}

/**
 * Write servers to a YAML file for project or local scopes.
 * Creates the directory if needed.
 */
async function writeServersToYaml(
  scope: McpScope,
  projectRoot: string,
  servers: Record<string, McpServerConfig>,
): Promise<void> {
  const dir = mcpDirForScope(scope, projectRoot);
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, "servers.yaml");
  const yaml = stringifyYaml(servers, { lineWidth: 120 });
  await writeFile(filePath, yaml, "utf-8");
}

// ── Config loading ───────────────────────────────────────────────────────────

/**
 * Load MCP servers config from a scope.
 *
 * - "user" scope: reads from SQLite. If no DB rows exist, falls back to
 *   ~/.openclaw/mcp/servers.yaml and auto-imports into the DB.
 * - "project" / "local" scopes: reads from YAML files as before.
 *
 * Returns an empty record if nothing is found.
 */
export async function loadServersFromScope(
  scope: McpScope,
  projectRoot: string,
): Promise<Record<string, McpServerConfig>> {
  if (scope === "user") {
    // Primary: SQLite
    if (hasMcpServersInDb("user")) {
      return loadMcpServersFromDb("user");
    }

    // Fallback: read YAML and auto-import into DB (one-time migration path for
    // environments where the schema migration didn't handle it, e.g. tests).
    const yamlServers = await loadServersFromYaml("user", projectRoot);
    if (Object.keys(yamlServers).length > 0) {
      for (const [key, config] of Object.entries(yamlServers)) {
        try {
          saveMcpServerToDb("user", key, config);
        } catch {
          // Best-effort: skip rows that fail (e.g. table not yet created in test).
        }
      }
      return yamlServers;
    }

    return {};
  }

  // project / local: YAML files
  return loadServersFromYaml(scope, projectRoot);
}

// ── Scope resolution ─────────────────────────────────────────────────────────

/** Resolution order: user (broadest) → project → local (narrowest wins). */
const SCOPE_LOAD_ORDER: McpScope[] = ["user", "project", "local"];

/**
 * Merge MCP server configs from all scopes with the inline config.
 *
 * Priority (narrowest wins on key collision):
 * 1. Inline config from `tools.mcp.servers` (highest — explicit config)
 * 2. Local scope (`.openclaw/mcp.local/servers.yaml`)
 * 3. Project scope (`.openclaw/mcp/servers.yaml`)
 * 4. User scope (SQLite op1_mcp_servers / ~/.openclaw/mcp/servers.yaml fallback)
 */
export async function resolveMcpServers(
  inlineConfig: McpConfig | undefined,
  projectRoot: string,
): Promise<Record<string, McpServerConfig>> {
  const merged: Record<string, McpServerConfig> = {};

  // Load broadest first so narrower scopes overwrite.
  for (const scope of SCOPE_LOAD_ORDER) {
    const servers = await loadServersFromScope(scope, projectRoot);
    Object.assign(merged, servers);
  }

  // Inline config (from tools.mcp.servers) takes highest priority.
  if (inlineConfig?.servers) {
    Object.assign(merged, inlineConfig.servers);
  }

  return merged;
}

/**
 * Resolve the effective MCP config by merging scope-based servers
 * with the inline config's global settings.
 */
export async function resolveEffectiveMcpConfig(
  inlineConfig: McpConfig | undefined,
  projectRoot: string,
): Promise<{ config: McpConfig; servers: Record<string, McpServerConfig> }> {
  const servers = await resolveMcpServers(inlineConfig, projectRoot);

  const config: McpConfig = {
    maxResultBytes: inlineConfig?.maxResultBytes,
    toolSearchThreshold: inlineConfig?.toolSearchThreshold,
    toolSearch: inlineConfig?.toolSearch,
    registries: inlineConfig?.registries,
    servers,
  };

  return { config, servers };
}

// ── Scope writing ─────────────────────────────────────────────────────────

/**
 * Write the full servers record to a scope.
 *
 * - "user" scope: bulk-upserts into SQLite (deletes removed keys).
 * - "project" / "local" scopes: writes YAML file.
 */
export async function writeServersToScope(
  scope: McpScope,
  projectRoot: string,
  servers: Record<string, McpServerConfig>,
): Promise<void> {
  if (scope === "user") {
    // Fetch existing keys so we can delete any that were removed.
    const existing = loadMcpServersFromDb("user");
    for (const key of Object.keys(existing)) {
      if (!(key in servers)) {
        deleteMcpServerFromDb("user", key);
      }
    }
    for (const [key, config] of Object.entries(servers)) {
      saveMcpServerToDb("user", key, config);
    }
    return;
  }

  await writeServersToYaml(scope, projectRoot, servers);
}

/**
 * Find which scope a server key lives in. Checks narrowest → broadest.
 * Returns undefined if the server isn't found in any scope.
 */
export async function findServerScope(
  serverKey: string,
  projectRoot: string,
): Promise<McpScope | undefined> {
  // Check narrowest first so the UI targets the most-specific scope.
  const searchOrder: McpScope[] = ["local", "project", "user"];
  for (const scope of searchOrder) {
    const servers = await loadServersFromScope(scope, projectRoot);
    if (serverKey in servers) {
      return scope;
    }
  }
  return undefined;
}

/**
 * Add or update a server in a specific scope.
 *
 * - "user" scope: single-row upsert in SQLite.
 * - "project" / "local" scopes: read-modify-write YAML.
 */
export async function upsertServerInScope(
  scope: McpScope,
  projectRoot: string,
  serverKey: string,
  config: McpServerConfig,
): Promise<void> {
  if (scope === "user") {
    saveMcpServerToDb("user", serverKey, config);
    return;
  }

  const servers = await loadServersFromYaml(scope, projectRoot);
  servers[serverKey] = config;
  await writeServersToYaml(scope, projectRoot, servers);
}

/**
 * Remove a server from a specific scope.
 * Returns true if the server was found and removed.
 */
export async function removeServerFromScope(
  scope: McpScope,
  projectRoot: string,
  serverKey: string,
): Promise<boolean> {
  if (scope === "user") {
    return deleteMcpServerFromDb("user", serverKey);
  }

  const servers = await loadServersFromYaml(scope, projectRoot);
  if (!(serverKey in servers)) {
    return false;
  }
  delete servers[serverKey];
  await writeServersToYaml(scope, projectRoot, servers);
  return true;
}
