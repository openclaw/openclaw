import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { agentProvenanceFromRow } from "./agent-provenance.kernel.js";
import type { AgentProvenance } from "./agent-provenance.types.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import type { DB } from "./openclaw-state-db.generated.js";
import type { WorkerOperationHandlers } from "./worker-operation-registry.js";

export type AgentLifecycleStoreFacts = {
  deletionBlocked: boolean;
  provenance: AgentProvenance | null;
};

/** Seed one lifecycle snapshot; committed owner receipts maintain its in-process projection. */
export function readAgentLifecycleStoreFacts(
  database: DatabaseSync,
  agentId: string,
): AgentLifecycleStoreFacts {
  const db = getNodeSqliteKysely<Pick<DB, "agent_provenance" | "agent_deletion_journal">>(database);
  const base = db.selectFrom(
    db.selectNoFrom((eb) => eb.val(normalizeAgentId(agentId)).as("agent_id")).as("target"),
  );
  const hasProvenance = tableExists(database, "agent_provenance");
  const hasJournal = tableExists(database, "agent_deletion_journal");
  const lifecycleQuery = base
    .$if(hasProvenance, (query) =>
      query
        .leftJoin("agent_provenance as provenance", "provenance.agent_id", "target.agent_id")
        .select([
          "provenance.agent_id as provenanceAgentId",
          "provenance.created_via as createdVia",
          "provenance.creator_agent_id as creatorAgentId",
          "provenance.created_at_ms as createdAtMs",
        ]),
    )
    .$if(!hasProvenance, (query) =>
      query.select((eb) => [
        eb.val(null).as("provenanceAgentId"),
        eb.val(null).as("createdVia"),
        eb.val(null).as("creatorAgentId"),
        eb.val(null).as("createdAtMs"),
      ]),
    )
    .$if(hasJournal, (query) =>
      query
        .leftJoin("agent_deletion_journal as deletion", "deletion.agent_id", "target.agent_id")
        .select("deletion.agent_id as deletedAgentId"),
    )
    .$if(!hasJournal, (query) => query.select((eb) => eb.val(null).as("deletedAgentId")));
  const row = executeSqliteQueryTakeFirstSync(database, lifecycleQuery);
  if (!row) {
    throw new Error("Agent lifecycle lookup returned no target row");
  }
  if (row.deletedAgentId != null || row.provenanceAgentId == null) {
    return { deletionBlocked: row.deletedAgentId != null, provenance: null };
  }
  if (row.createdVia == null || row.createdAtMs == null) {
    throw new Error("Agent provenance is missing its durable incarnation fields");
  }
  return {
    deletionBlocked: row.deletedAgentId != null,
    provenance: agentProvenanceFromRow({
      agent_id: row.provenanceAgentId,
      created_via: row.createdVia,
      creator_agent_id: row.creatorAgentId ?? null,
      created_at_ms: row.createdAtMs,
    }),
  };
}

export const agentLifecycleReadOperations = {
  "agentLifecycle.read": (agentId: string, database) => ({
    type: "agentLifecycle.read" as const,
    facts: readAgentLifecycleStoreFacts(database, agentId),
  }),
} satisfies WorkerOperationHandlers<DatabaseSync>;
