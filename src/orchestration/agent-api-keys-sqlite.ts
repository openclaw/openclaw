import { createHash, randomBytes } from "node:crypto";
import { randomUUID } from "node:crypto";
import { getStateDb } from "../infra/state-db/connection.js";
import type { AgentApiKey } from "./types.js";

type AgentApiKeyRow = {
  id: string;
  agent_id: string;
  workspace_id: string;
  name: string;
  key_hash: string;
  key_prefix: string;
  last_used_at: number | null;
  revoked_at: number | null;
  created_at: number;
};

function rowToAgentApiKey(row: AgentApiKeyRow): AgentApiKey {
  return {
    id: row.id,
    agentId: row.agent_id,
    workspaceId: row.workspace_id,
    name: row.name,
    keyPrefix: row.key_prefix,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  };
}

function hashKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}

/**
 * Create a new agent API key. The raw key is returned only once — it is never
 * stored in the database; only its SHA-256 hash is persisted.
 */
export function createAgentApiKey(params: {
  agentId: string;
  workspaceId?: string;
  name: string;
}): {
  id: string;
  agentId: string;
  name: string;
  keyPrefix: string;
  rawKey: string;
  createdAt: number;
} {
  const db = getStateDb();
  const id = randomUUID();
  const rawKey = randomBytes(32).toString("hex");
  const keyPrefix = rawKey.slice(0, 8);
  const keyHash = hashKey(rawKey);
  const workspaceId = params.workspaceId ?? "default";
  const now = Math.floor(Date.now() / 1000);

  db.prepare(`
    INSERT INTO op1_agent_api_keys
      (id, agent_id, workspace_id, name, key_hash, key_prefix, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, params.agentId, workspaceId, params.name, keyHash, keyPrefix, now);

  return {
    id,
    agentId: params.agentId,
    name: params.name,
    keyPrefix,
    rawKey,
    createdAt: now,
  };
}

/**
 * List API keys (without hash), optionally filtered by agent.
 */
export function listAgentApiKeys(agentId?: string): AgentApiKey[] {
  const db = getStateDb();
  let query = "SELECT * FROM op1_agent_api_keys";
  const args: Array<string | number | bigint | null> = [];

  if (agentId !== undefined) {
    query += " WHERE agent_id = ?";
    args.push(agentId);
  }

  query += " ORDER BY created_at DESC";

  const rows = db.prepare(query).all(...args);
  return (rows as unknown as AgentApiKeyRow[]).map(rowToAgentApiKey);
}

/**
 * Verify a raw API key: hash it, look up by hash, check not revoked, and
 * update last_used_at. Returns key metadata on success, null otherwise.
 */
export function verifyAgentApiKey(
  rawKey: string,
): { agentId: string; workspaceId: string; name: string } | null {
  const db = getStateDb();
  const keyHash = hashKey(rawKey);

  const row = db
    .prepare("SELECT * FROM op1_agent_api_keys WHERE key_hash = ?")
    .get(keyHash) as unknown as AgentApiKeyRow | undefined;

  if (!row || row.revoked_at !== null) {
    return null;
  }

  // Update last_used_at to current unix timestamp
  db.prepare("UPDATE op1_agent_api_keys SET last_used_at = unixepoch() WHERE id = ?").run(row.id);

  return {
    agentId: row.agent_id,
    workspaceId: row.workspace_id,
    name: row.name,
  };
}

/**
 * Revoke an API key by setting revoked_at to the current unix timestamp.
 */
export function revokeAgentApiKey(id: string): void {
  const db = getStateDb();
  db.prepare("UPDATE op1_agent_api_keys SET revoked_at = unixepoch() WHERE id = ?").run(id);
}
