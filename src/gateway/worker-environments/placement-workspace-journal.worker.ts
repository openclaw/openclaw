import type {
  WorkerWriteOperationContext,
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
  return (input: Input, { writeAdmitted }: WorkerWriteOperationContext): WorkspaceJournalReceipt =>
    writeAdmitted(
      ({ db }) => {
        const journal = createPlacementWorkspaceJournalOps({
          now: () => now(input),
          write: (write) => write(db),
        });
        return { type, ...execute(journal, input) };
      },
      { operationLabel: type, receipt: "result", transactionEnvironment: "process" },
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
} satisfies WorkerOperationHandlers<WorkerWriteOperationContext>;
