import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
  sqliteStringSetEntries,
} from "../infra/kysely-sync.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { agentProvenancePublication } from "./agent-provenance-publication.js";
import type { AgentProvenance } from "./agent-provenance.types.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateKyselyDatabase } from "./openclaw-state-db.generated.js";
import type { WorkerOperationHandlers } from "./worker-operation-registry.js";

type AgentProvenanceDatabase = Pick<OpenClawStateKyselyDatabase, "agent_provenance">;

export const agentProvenanceReadOperations = {
  "agentProvenance.readBatch": (input: { agentIds: readonly string[] }, db) => ({
    type: "agentProvenance.readBatch" as const,
    records: tableExists(db, "agent_provenance")
      ? readAgentProvenanceBatchInDatabase(db, input.agentIds)
      : [],
  }),
  "agentProvenance.list": (_input: undefined, db) => ({
    type: "agentProvenance.list" as const,
    records: tableExists(db, "agent_provenance") ? listAgentProvenanceInDatabase(db) : [],
  }),
} satisfies WorkerOperationHandlers<EngineConnection>;

export function recordAgentProvenanceInDatabase(
  database: EngineConnection,
  provenance: AgentProvenance,
): void {
  const db = getNodeSqliteKysely<AgentProvenanceDatabase>(database);
  const values = {
    agent_id: provenance.agentId,
    created_via: provenance.createdVia,
    creator_agent_id: provenance.creatorAgentId,
    created_at_ms: provenance.createdAtMs,
  };
  executeSqliteQuerySync(
    database,
    db
      .insertInto("agent_provenance")
      .values(values)
      .onConflict((conflict) =>
        conflict.column("agent_id").doUpdateSet({
          created_via: values.created_via,
          creator_agent_id: values.creator_agent_id,
          created_at_ms: values.created_at_ms,
        }),
      ),
  );
  agentProvenancePublication.stagePostimages(database, [provenance]);
}

export function agentProvenanceFromRow(
  row: AgentProvenanceDatabase["agent_provenance"],
): AgentProvenance {
  if (
    row.created_via !== "operator" &&
    row.created_via !== "agent" &&
    row.created_via !== "template"
  ) {
    throw new Error(`Invalid agent provenance created_via: ${row.created_via}`);
  }
  return {
    agentId: row.agent_id,
    createdVia: row.created_via,
    creatorAgentId: row.creator_agent_id,
    createdAtMs: row.created_at_ms,
  };
}

export function listAgentProvenanceInDatabase(database: EngineConnection): AgentProvenance[] {
  const db = getNodeSqliteKysely<AgentProvenanceDatabase>(database);
  return executeSqliteQuerySync(
    database,
    db.selectFrom("agent_provenance").selectAll().orderBy("agent_id", "asc"),
  ).rows.map(agentProvenanceFromRow);
}

/** Decode only requested provenance, in the caller's order, including its first error. */
export function readAgentProvenanceBatchInDatabase(
  database: EngineConnection,
  agentIds: readonly string[],
): AgentProvenance[] {
  if (agentIds.length === 0) {
    return [];
  }
  const db = getNodeSqliteKysely<AgentProvenanceDatabase>(database);
  const requestedIds = JSON.stringify(agentIds.map(normalizeAgentId));
  const query = db
    .selectFrom(sqliteStringSetEntries(requestedIds).as("requested"))
    .innerJoin("agent_provenance", "agent_provenance.agent_id", "requested.value")
    .selectAll("agent_provenance")
    .orderBy("requested.key", "asc");
  const records: AgentProvenance[] = [];
  // Eager native row decoding could throw on a later unsafe integer before an
  // earlier row's invalid created_via reaches the owning codec.
  for (const row of iterateSqliteQuerySync(database, query)) {
    records.push(agentProvenanceFromRow(row));
  }
  return records;
}
