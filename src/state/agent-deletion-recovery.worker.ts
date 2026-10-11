import type { DatabaseSync } from "node:sqlite";
import { requestSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import { resolveAgentDeletionRecoveryHolds } from "./agent-deletion-journal-recovery.js";
import {
  readAgentDeletionRecoveryHolds,
  type AgentDeletionRecoveryHoldPredicate,
} from "./agent-deletion-journal-recovery.kernel.js";
import { readAgentDeletionJournalInDatabase } from "./agent-deletion-journal.js";
import type { WorkerWriteOperationContext } from "./worker-operation-registry.js";

export const agentRecoveryOperations = {
  "agentRecovery.resolveHolds": (
    input: { predicate: AgentDeletionRecoveryHoldPredicate; paths: string[] },
    context: WorkerWriteOperationContext,
  ) =>
    context.write(
      (database) => {
        requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
        const resolved = resolveAgentDeletionRecoveryHolds(
          database,
          input.predicate.agentId,
          input.paths,
          input.predicate,
        );
        requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
        return resolved;
      },
      { operationLabel: "agent.recovery.resolve" },
    ),
};

export const agentRecoveryReadOperations = {
  "agentRecovery.holds": (input: { statePath: string }, db: DatabaseSync) => ({
    type: "agentRecovery.holds" as const,
    held: readAgentDeletionRecoveryHolds({ db, path: input.statePath }),
  }),
  "agentRecovery.creationJournal": (input: { agentId: string }, db: DatabaseSync) => ({
    type: "agentRecovery.creationJournal" as const,
    journal: readAgentDeletionJournalInDatabase({ db }, input.agentId, "runtime"),
  }),
};
