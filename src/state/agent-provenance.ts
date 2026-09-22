import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { readAgentProvenanceInDatabase } from "./agent-provenance.kernel.js";
import { ensureAgentProvenanceSchema } from "./agent-provenance.schema.js";
import type { AgentCreatedVia, AgentProvenance } from "./agent-provenance.types.js";
import type { DB as OpenClawStateKyselyDatabase } from "./openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "./openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";

export { ensureAgentProvenanceSchema } from "./agent-provenance.schema.js";
export type { AgentCreatedVia, AgentProvenance } from "./agent-provenance.types.js";

type AgentProvenanceDatabase = Pick<OpenClawStateKyselyDatabase, "agent_provenance">;
type AgentProvenanceOptions = OpenClawStateDatabaseOptions & { nowMs?: number };

export function recordAgentProvenance(
  agentId: string,
  provenance: { createdVia: AgentCreatedVia; creatorAgentId?: string },
  options: AgentProvenanceOptions = {},
): void {
  ensureAgentProvenanceSchema(options);
  const id = normalizeAgentId(agentId);
  const creatorAgentId = provenance.creatorAgentId
    ? normalizeAgentId(provenance.creatorAgentId)
    : null;
  const createdAtMs = options.nowMs ?? Date.now();
  runOpenClawStateWriteTransaction(
    ({ db: sqlite }) => {
      const db = getNodeSqliteKysely<AgentProvenanceDatabase>(sqlite);
      executeSqliteQuerySync(
        sqlite,
        db
          .insertInto("agent_provenance")
          .values({
            agent_id: id,
            created_via: provenance.createdVia,
            creator_agent_id: creatorAgentId,
            created_at_ms: createdAtMs,
          })
          .onConflict((conflict) =>
            conflict.column("agent_id").doUpdateSet({
              created_via: provenance.createdVia,
              creator_agent_id: creatorAgentId,
              created_at_ms: createdAtMs,
            }),
          ),
      );
    },
    options,
    { operationLabel: "agent-provenance.record" },
  );
}

export function readAgentProvenance(
  agentId: string,
  options: OpenClawStateDatabaseOptions = {},
): AgentProvenance | undefined {
  ensureAgentProvenanceSchema(options);
  const database = openOpenClawStateDatabase(options);
  return readAgentProvenanceInDatabase(database.db, agentId);
}

type AgentProvenanceReadOptions = Pick<OpenClawStateDatabaseOptions, "env" | "path">;

/** Presentation reads may wait; incarnation checks retain the synchronous reader above. */
export async function readAgentProvenanceForDisplay(
  agentId: string,
  options: AgentProvenanceReadOptions = {},
): Promise<AgentProvenance | undefined> {
  const context = captureOpenClawStateWorkerContext(options);
  const { executeOpenClawStateWorker } = await import("./openclaw-state-worker-store.js");
  return executeOpenClawStateWorker(context, {
    type: "agentProvenance.read",
    input: { agentId },
  });
}

export async function listAgentProvenance(
  options: AgentProvenanceReadOptions = {},
): Promise<AgentProvenance[]> {
  const context = captureOpenClawStateWorkerContext(options);
  const { executeOpenClawStateWorker } = await import("./openclaw-state-worker-store.js");
  return executeOpenClawStateWorker(context, {
    type: "agentProvenance.list",
    input: undefined,
  });
}

/** Delete one row inside the caller's authoritative state transaction. */
export function deleteAgentProvenanceForAgent(database: DatabaseSync, agentId: string): void {
  const db = getNodeSqliteKysely<AgentProvenanceDatabase>(database);
  executeSqliteQuerySync(
    database,
    db.deleteFrom("agent_provenance").where("agent_id", "=", normalizeAgentId(agentId)),
  );
}
