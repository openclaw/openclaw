import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
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

/** Decode only requested provenance, in the caller's order, including its first error. */
export function readAgentProvenanceBatchInDatabase(
  database: DatabaseSync,
  agentIds: readonly string[],
): AgentProvenance[] {
  if (agentIds.length === 0) {
    return [];
  }
  const db = getNodeSqliteKysely<AgentProvenanceDatabase>(database);
  const requestedIds = JSON.stringify(agentIds.map(normalizeAgentId));
  const query = db
    .selectFrom((eb) =>
      eb.fn<{ key: number; value: string }>("json_each", [eb.val(requestedIds)]).as("requested"),
    )
    .innerJoin("agent_provenance", "agent_provenance.agent_id", "requested.value")
    .selectAll("agent_provenance")
    .orderBy("requested.key", "asc");
  const records: AgentProvenance[] = [];
  // Eager native row decoding could throw on a later unsafe integer before an
  // earlier row's invalid created_via reaches the owning codec.
  for (const row of iterateSqliteQuerySync(database, query)) {
    records.push(fromRow(row));
  }
  return records;
}
