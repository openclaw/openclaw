import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { createSqliteWorkerWriteAdmission } from "../infra/sqlite-worker-store.js";
import { normalizeAgentId } from "../routing/session-key.js";
import {
  agentProvenancePublication,
  withAgentProvenancePublication,
} from "./agent-provenance-publication.js";
import type { AgentCreatedVia, AgentProvenance } from "./agent-provenance.types.js";
import type { DB as OpenClawStateKyselyDatabase } from "./openclaw-state-db.generated.js";
import type { OpenClawStateDatabaseOptions } from "./openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";

export type { AgentCreatedVia, AgentProvenance } from "./agent-provenance.types.js";

type AgentProvenanceDatabase = Pick<OpenClawStateKyselyDatabase, "agent_provenance">;
type AgentProvenanceOptions = OpenClawStateDatabaseOptions & { nowMs?: number };

export async function recordAgentProvenance(
  agentId: string,
  provenance: { createdVia: AgentCreatedVia; creatorAgentId?: string },
  options: AgentProvenanceOptions = {},
): Promise<void> {
  const context = captureOpenClawStateWorkerContext({
    ...options,
    path: options.database?.path ?? options.path,
  });
  const input = {
    agentId: normalizeAgentId(agentId),
    createdVia: provenance.createdVia,
    creatorAgentId: provenance.creatorAgentId ? normalizeAgentId(provenance.creatorAgentId) : null,
    createdAtMs: options.nowMs ?? Date.now(),
  };
  const { runOpenClawStateWorkerOperation } = await import("./openclaw-state-worker-store.js");
  await runOpenClawStateWorkerOperation(
    context,
    (scope) => scope.execute({ type: "agentProvenance.record", input }),
    {
      createAdmission: withAgentProvenancePublication(
        createSqliteWorkerWriteAdmission(context.admission.assertCurrent, [
          context.admission.databasePath,
        ]),
        context,
      ),
    },
  );
}

type AgentProvenanceReadOptions = Pick<OpenClawStateDatabaseOptions, "env" | "path">;
const DISPLAY_PROVENANCE_BATCH_SIZE = 256;

/** Read provenance for the selected presentation roster in bounded worker batches. */
export async function readAgentProvenanceForDisplay(
  agentIds: readonly string[],
  options: AgentProvenanceReadOptions = {},
): Promise<AgentProvenance[]> {
  if (agentIds.length === 0) {
    return [];
  }
  const context = captureOpenClawStateWorkerContext(options);
  const requestedIds = agentIds.map(normalizeAgentId);
  const { executeOpenClawStateWorker } = await import("./openclaw-state-worker-store.js");
  const records: AgentProvenance[] = [];
  // Canonical IDs are bounded; chunking keeps roster growth below broker input
  // admission limits while preserving caller order and the first read error.
  for (let offset = 0; offset < requestedIds.length; offset += DISPLAY_PROVENANCE_BATCH_SIZE) {
    const batch = await executeOpenClawStateWorker(context, {
      type: "agentProvenance.readBatch",
      input: { agentIds: requestedIds.slice(offset, offset + DISPLAY_PROVENANCE_BATCH_SIZE) },
    });
    records.push(...batch);
  }
  return records;
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
  agentProvenancePublication.stageDeletions(database, [normalizeAgentId(agentId)]);
}
