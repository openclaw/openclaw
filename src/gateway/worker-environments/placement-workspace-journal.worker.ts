import {
  deferSqliteWorkerCommitReceipt,
  requestSqliteWorkerOperationAdmission,
} from "../../infra/sqlite-worker-operation-admission.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import type {
  WorkerOperationContext,
  WorkerOperationHandlers,
} from "../../state/worker-operation-registry.js";
import { createPlacementWorkspaceJournalOps } from "./placement-workspace-journal.js";
import type {
  WorkerWorkspaceJournalOwner,
  WorkspaceJournalMutation,
  WorkspaceJournalReceipt,
} from "./placement-workspace-journal.types.js";
import type { WorkerWorkspaceReconciliationJournal } from "./workspace-manifest.js";

function operation<Input>(
  type: WorkspaceJournalReceipt["type"],
  execute: (
    journal: ReturnType<typeof createPlacementWorkspaceJournalOps>,
    input: Input,
  ) => WorkspaceJournalMutation,
  now: (input: Input) => number = Date.now,
) {
  return (input: Input, { open }: WorkerOperationContext): WorkspaceJournalReceipt =>
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
        const journal = createPlacementWorkspaceJournalOps({
          now: () => now(input),
          write: (write) => write(db),
        });
        const receipt: WorkspaceJournalReceipt = { type, ...execute(journal, input) };
        requestSqliteWorkerOperationAdmission({ stage: "commit", facts: receipt });
        deferSqliteWorkerCommitReceipt(db, receipt);
        return receipt;
      },
      { database: open() },
      { operationLabel: type },
    );
}

export const workspaceJournalOperations = {
  "placementJournals.begin": operation(
    "placementJournals.begin",
    (
      journal,
      input: {
        owner: WorkerWorkspaceJournalOwner;
        journal: WorkerWorkspaceReconciliationJournal;
        nowMs?: number;
      },
    ) => journal.beginWorkspaceReconciliation(input.owner, input.journal),
    (input) => input.nowMs ?? Date.now(),
  ),
  "placementJournals.abort": operation(
    "placementJournals.abort",
    (journal, input: { owner: WorkerWorkspaceJournalOwner; force?: boolean }) =>
      journal.abortWorkspaceReconciliation(input.owner, { force: input.force }),
  ),
  "placementJournals.prune": operation(
    "placementJournals.prune",
    (journal, _input: Record<string, never>) => journal.pruneOrphanedWorkspaceReconciliations(),
  ),
} satisfies WorkerOperationHandlers;
