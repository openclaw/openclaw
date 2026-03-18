import { randomUUID } from "node:crypto";
import { getStateDb } from "../infra/state-db/index.js";
import type { AgentConfigRevision } from "./types.js";

type AgentConfigRevisionRow = {
  id: string;
  workspace_id: string;
  agent_id: string;
  config_json: string;
  changed_by: string | null;
  change_note: string | null;
  created_at: number;
};

function rowToAgentConfigRevision(row: AgentConfigRevisionRow): AgentConfigRevision {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    agentId: row.agent_id,
    configJson: row.config_json,
    changedBy: row.changed_by,
    changeNote: row.change_note,
    createdAt: row.created_at,
  };
}

export function createAgentConfigRevision(params: {
  workspaceId: string;
  agentId: string;
  config: unknown;
  changedBy?: string;
  changeNote?: string;
}): AgentConfigRevision {
  const db = getStateDb();
  const id = randomUUID();
  const now = Math.floor(Date.now() / 1000);

  const stmt = db.prepare(`
    INSERT INTO op1_agent_config_revisions (
      id, workspace_id, agent_id, config_json, changed_by, change_note, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    id,
    params.workspaceId,
    params.agentId,
    JSON.stringify(params.config),
    params.changedBy || null,
    params.changeNote || null,
    now,
  );

  return getAgentConfigRevision(id)!;
}

export function getAgentConfigRevision(id: string): AgentConfigRevision | null {
  const db = getStateDb();
  const stmt = db.prepare("SELECT * FROM op1_agent_config_revisions WHERE id = ?");
  const row = stmt.get(id);
  return row ? rowToAgentConfigRevision(row as unknown as AgentConfigRevisionRow) : null;
}

export function listAgentConfigRevisions(filters: {
  workspaceId: string;
  agentId?: string;
}): AgentConfigRevision[] {
  const db = getStateDb();
  let query = "SELECT * FROM op1_agent_config_revisions WHERE workspace_id = ?";
  const params: Array<string | number | bigint | null> = [filters.workspaceId];

  if (filters.agentId) {
    query += " AND agent_id = ?";
    params.push(filters.agentId);
  }

  query += " ORDER BY created_at DESC";

  const stmt = db.prepare(query);
  const rows = stmt.all(...params);
  return (rows as unknown as AgentConfigRevisionRow[]).map(rowToAgentConfigRevision);
}
