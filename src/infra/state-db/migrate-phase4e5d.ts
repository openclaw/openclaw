/**
 * One-shot migration: Phase 4E + 5D → SQLite.
 *
 * 4E: MCP registries from tools.mcp.registries in openclaw config → op1_mcp_registries
 * 5D: Agent registries from ~/.openclaw/agent-registry-cache/registries.json → op1_agent_registries
 *
 * Idempotent: skips each store if the target table already has data.
 * Source data is removed after successful migration.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  saveAgentRegistryToDb,
  loadAgentRegistriesFromDb,
} from "../../agents/registries-sqlite.js";
import { saveMcpRegistryToDb, loadMcpRegistriesFromDb } from "../../mcp/registries-sqlite.js";
import { getConfigRawFromDb, setConfigRawInDb } from "./config-sqlite.js";

type MigrationResult = {
  store: string;
  count: number;
  migrated: boolean;
  error?: string;
};

function tryUnlink(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // ignore — file may already be absent
  }
}

// ── Phase 4E: MCP registries ────────────────────────────────────────────────

function migrateMcpRegistries(): MigrationResult {
  const result: MigrationResult = { store: "mcp-registries", count: 0, migrated: false };

  try {
    // Skip if SQLite already has MCP registries.
    if (loadMcpRegistriesFromDb().length > 0) {
      return result;
    }

    // Read registries from the config blob (stored in op1_config by Phase 6A).
    const raw = getConfigRawFromDb();
    if (!raw) {
      return result;
    }

    let config: Record<string, unknown>;
    try {
      config = JSON.parse(raw);
    } catch {
      return result;
    }

    const tools = config.tools as Record<string, unknown> | undefined;
    const mcp = tools?.mcp as Record<string, unknown> | undefined;
    const registries = mcp?.registries as Array<Record<string, unknown>> | undefined;

    if (!Array.isArray(registries) || registries.length === 0) {
      return result;
    }

    for (const reg of registries) {
      saveMcpRegistryToDb({
        id: typeof reg.id === "string" ? reg.id : "",
        name: typeof reg.name === "string" ? reg.name : "",
        url: typeof reg.url === "string" ? reg.url : "",
        description: typeof reg.description === "string" ? reg.description : undefined,
        auth_token_env: typeof reg.auth_token_env === "string" ? reg.auth_token_env : undefined,
        visibility:
          reg.visibility === "public" || reg.visibility === "private" ? reg.visibility : undefined,
        enabled: reg.enabled !== false,
      });
      result.count++;
    }
    result.migrated = true;

    // Remove registries from the config blob so they're not read again.
    if (mcp) {
      delete mcp.registries;
      setConfigRawInDb(JSON.stringify(config, null, 2));
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }

  return result;
}

// ── Phase 5D: Agent marketplace registries ──────────────────────────────────

function migrateAgentRegistries(): MigrationResult {
  const result: MigrationResult = { store: "agent-registries", count: 0, migrated: false };

  const jsonPath = path.join(os.homedir(), ".openclaw", "agent-registry-cache", "registries.json");

  try {
    if (!fs.existsSync(jsonPath)) {
      return result;
    }

    // Skip if SQLite already has agent registries.
    if (loadAgentRegistriesFromDb().length > 0) {
      tryUnlink(jsonPath);
      return result;
    }

    const content = fs.readFileSync(jsonPath, "utf-8");
    let registries: Array<Record<string, unknown>>;
    try {
      const parsed = JSON.parse(content);
      registries = Array.isArray(parsed) ? parsed : [];
    } catch {
      return result;
    }

    for (const reg of registries) {
      saveAgentRegistryToDb({
        id: typeof reg.id === "string" ? reg.id : "",
        name: typeof reg.name === "string" ? reg.name : "",
        url: typeof reg.url === "string" ? reg.url : "",
        description: typeof reg.description === "string" ? reg.description : undefined,
        visibility: reg.visibility === "private" ? "private" : "public",
        authTokenEnv: typeof reg.authTokenEnv === "string" ? reg.authTokenEnv : undefined,
        enabled: reg.enabled !== false,
        lastSynced: typeof reg.lastSynced === "string" ? reg.lastSynced : undefined,
        agentCount: typeof reg.agentCount === "number" ? reg.agentCount : undefined,
      });
      result.count++;
    }
    result.migrated = true;

    tryUnlink(jsonPath);
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }

  return result;
}

// ── Public entry point ──────────────────────────────────────────────────────

export function migratePhase4e5dToSqlite(): MigrationResult[] {
  return [migrateMcpRegistries(), migrateAgentRegistries()];
}
