import { hasErrnoCode } from "../infra/errno.js";
import { normalizeAgentId } from "../routing/session-key.js";
import {
  readAgentProvenanceBatchInDatabase,
  recordAgentProvenanceInDatabase,
} from "../state/agent-provenance.kernel.js";
import { ensureAgentProvenanceSchema } from "../state/agent-provenance.schema.js";
import type { AgentCreatedVia, AgentProvenance } from "../state/agent-provenance.types.js";
import { withExistingOpenClawStateDatabaseCurrentReadOnly } from "../state/openclaw-state-db-readonly.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";

/** Seed foreign provenance in fixtures that do not own a worker broker. */
export function seedAgentProvenance(
  agentId: string,
  provenance: { createdVia: AgentCreatedVia; creatorAgentId?: string },
  options: OpenClawStateDatabaseOptions & { nowMs?: number } = {},
): void {
  ensureAgentProvenanceSchema(options);
  runOpenClawStateWriteTransaction(
    ({ db }) =>
      recordAgentProvenanceInDatabase(db, {
        agentId: normalizeAgentId(agentId),
        createdVia: provenance.createdVia,
        creatorAgentId: provenance.creatorAgentId
          ? normalizeAgentId(provenance.creatorAgentId)
          : null,
        createdAtMs: options.nowMs ?? Date.now(),
      }),
    options,
  );
}

/** Inspect persisted fixture state without creating a missing database or provenance table. */
export function readAgentProvenance(
  agentId: string,
  options: OpenClawStateDatabaseOptions = {},
): AgentProvenance | undefined {
  return withExistingOpenClawStateDatabaseCurrentReadOnly(({ db }) => {
    try {
      return readAgentProvenanceBatchInDatabase(db, [agentId])[0];
    } catch (error) {
      if (
        error instanceof Error &&
        hasErrnoCode(error, "ERR_SQLITE_ERROR") &&
        error.message === "no such table: agent_provenance"
      ) {
        return undefined;
      }
      throw error;
    }
  }, options);
}
