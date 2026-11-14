import { exchangeSqliteDatabaseAdmission } from "../../infra/sqlite-database-admission-context.js";
import {
  withSqliteReaderOwner,
  type SqliteOperationHoldContext,
} from "../../infra/sqlite-reader-lifecycle.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  withAgentCreationClaimWitness,
  type AgentCreationClaimWitness,
} from "../../state/agent-creation-claim.js";
import { prepareAgentDeletionJournalStatus } from "../../state/agent-deletion-journal-status.js";
import type { OpenClawAgentDatabaseReadValidation } from "../../state/openclaw-agent-db-validation-cache.js";
import { sessionHistoryCleanupError } from "./session-history-worker-errors.js";
import type {
  SessionTranscriptHistoryWorkerInput,
  SessionTranscriptWorkerSuccess,
} from "./session-transcript-worker.types.js";

// Keep target switching within the existing serialized worker; no read snapshot survives a task.
const MAX_RETAINED_HISTORY_DATABASES = 64;
const log = createSubsystemLogger("sqlite/transaction");
const historyDatabaseScopes = new Map<
  string,
  {
    database: SessionTranscriptHistoryWorkerInput["database"];
    scope: import("../../state/openclaw-agent-db-readonly-scope.js").OpenClawAgentDatabaseReadOnlyScope;
  }
>();

export async function withHistoryDatabase<T>(
  database: SessionTranscriptHistoryWorkerInput["database"],
  operationLabel: string,
  operation: () => T | Promise<T>,
  validation?: OpenClawAgentDatabaseReadValidation,
  holdContext?: SqliteOperationHoldContext,
  creation?: { witness: AgentCreationClaimWitness; assertCurrent: () => void },
): Promise<SessionTranscriptWorkerSuccess<T>> {
  if (
    creation &&
    prepareAgentDeletionJournalStatus(creation.witness.statePath, creation.witness.agentId)() ===
      undefined
  ) {
    // A warm reader may know the state generation before this row fact was published.
    creation.assertCurrent();
    exchangeSqliteDatabaseAdmission(creation.witness.statePath);
    creation.assertCurrent();
  }
  const key = JSON.stringify(database);
  let retained = historyDatabaseScopes.get(key);
  if (!retained) {
    const { OpenClawAgentDatabaseReadOnlyScope } =
      await import("../../state/openclaw-agent-db-readonly-scope.js");
    retained = { database, scope: new OpenClawAgentDatabaseReadOnlyScope() };
  }
  const { scope } = retained;
  try {
    const value = await withSqliteReaderOwner(
      { operation: `sessions.${operationLabel}`, ownerKind: "worker" },
      () => {
        const read = () => scope.run({ ...database, validation }, operation);
        return creation
          ? withAgentCreationClaimWitness(creation.witness, creation.assertCurrent, read)
          : read();
      },
      { agentId: database.agentId, ...holdContext },
      log,
    );
    historyDatabaseScopes.delete(key);
    // Tasks without retained connections must not evict useful connections or retain empty scopes.
    if (!scope.hasRetainedConnection) {
      return { ok: true, value, closedHistoryDatabase: database };
    }
    historyDatabaseScopes.set(key, retained);
    if (historyDatabaseScopes.size > MAX_RETAINED_HISTORY_DATABASES) {
      const oldest = historyDatabaseScopes.entries().next().value!;
      oldest[1].scope.close();
      historyDatabaseScopes.delete(oldest[0]);
      return { ok: true, value, closedHistoryDatabase: oldest[1].database };
    }
    return { ok: true, value };
  } catch (error) {
    // The parent joins worker retirement on failure, including a failed native close.
    try {
      scope.close();
    } catch (cleanupError) {
      throw sessionHistoryCleanupError(error, cleanupError, "database close");
    }
    throw error;
  }
}

export function pruneClosedHistoryDatabaseScopes(): void {
  for (const [identity, retained] of historyDatabaseScopes) {
    if (!retained.scope.hasRetainedConnection) {
      historyDatabaseScopes.delete(identity);
    }
  }
}
