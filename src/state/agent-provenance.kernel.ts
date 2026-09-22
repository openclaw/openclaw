import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { normalizeAgentId } from "../routing/session-key.js";
import type { AgentCreatedVia, AgentProvenance } from "./agent-provenance.types.js";
import type { DB as OpenClawStateKyselyDatabase } from "./openclaw-state-db.generated.js";

type AgentProvenanceDatabase = Pick<OpenClawStateKyselyDatabase, "agent_provenance">;

function fromRow(row: {
  agent_id: string;
  created_via: string;
  creator_agent_id: string | null;
  created_at_ms: number;
}): AgentProvenance {
  let createdVia: AgentCreatedVia;
  switch (row.created_via) {
    case "operator":
    case "agent":
    case "claw":
      createdVia = row.created_via;
      break;
    default:
      throw new Error(`Invalid agent provenance created_via: ${row.created_via}`);
  }
  return {
    agentId: row.agent_id,
    createdVia,
    creatorAgentId: row.creator_agent_id,
    createdAtMs: row.created_at_ms,
  };
}

export function readAgentProvenanceInDatabase(
  database: DatabaseSync,
  agentId: string,
): AgentProvenance | undefined {
  const db = getNodeSqliteKysely<AgentProvenanceDatabase>(database);
  const row = executeSqliteQueryTakeFirstSync(
    database,
    db.selectFrom("agent_provenance").selectAll().where("agent_id", "=", normalizeAgentId(agentId)),
  );
  return row ? fromRow(row) : undefined;
}

export function listAgentProvenanceInDatabase(database: DatabaseSync): AgentProvenance[] {
  const db = getNodeSqliteKysely<AgentProvenanceDatabase>(database);
  return executeSqliteQuerySync(
    database,
    db.selectFrom("agent_provenance").selectAll().orderBy("agent_id", "asc"),
  ).rows.map(fromRow);
}
