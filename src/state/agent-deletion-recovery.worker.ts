import type { EngineConnection } from "../infra/sql-connection.js";
import { resolveAgentDeletionRecoveryHolds } from "./agent-deletion-journal-recovery.js";
import {
  readAgentDeletionRecoveryHolds,
  type AgentDeletionRecoveryHoldPredicate,
} from "./agent-deletion-journal-recovery.kernel.js";
import {
  listPendingAgentDeletionJournalsInDatabase,
  readAgentDeletionJournalInDatabase,
} from "./agent-deletion-journal.js";
import type { WorkerWriteOperationContext } from "./worker-operation-registry.js";

export const agentRecoveryOperations = {
  "agentRecovery.resolveHolds": (
    input: { predicate: AgentDeletionRecoveryHoldPredicate; paths: string[] },
    context: WorkerWriteOperationContext,
  ) =>
    context.writeAdmitted(
      (database) =>
        resolveAgentDeletionRecoveryHolds(
          database,
          input.predicate.agentId,
          input.paths,
          input.predicate,
        ),
      { operationLabel: "agent.recovery.resolve" },
    ),
};

export const agentRecoveryReadOperations = {
  "agentRecovery.holds": (input: { statePath: string }, db: EngineConnection) => ({
    type: "agentRecovery.holds" as const,
    held: readAgentDeletionRecoveryHolds({ db, path: input.statePath }),
  }),
  "agentRecovery.pendingDeletions": (_input: undefined, db: EngineConnection) => ({
    type: "agentRecovery.pendingDeletions" as const,
    ...listPendingAgentDeletionJournalsInDatabase({ db }),
  }),
  "agentRecovery.creationJournal": (input: { agentId: string }, db: EngineConnection) => ({
    type: "agentRecovery.creationJournal" as const,
    journal: readAgentDeletionJournalInDatabase({ db }, input.agentId, "runtime"),
  }),
};
