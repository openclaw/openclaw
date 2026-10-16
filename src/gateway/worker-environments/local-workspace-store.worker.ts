import { assertWorktreeRegistryPredicates } from "../../agents/worktrees/registry-run-end.worker.js";
import type { WorktreeRegistryPredicate } from "../../agents/worktrees/types.js";
import { deferSqliteWorkerCommitReceipt } from "../../infra/sqlite-worker-operation-admission.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { assertOpenClawStateLeasesWorkerOwnedInTransaction } from "../../state/openclaw-state-lease-worker.js";
import type { OpenClawStateLeaseIdentity } from "../../state/openclaw-state-lease.types.js";
import type { WorkerOperationContext } from "../../state/worker-operation-registry.js";
import { localWorkspacePublication } from "./local-workspace-publication.js";
import {
  mutateLocalWorkspaceProjection,
  type LocalWorkspaceMutation,
} from "./local-workspace-store.kernel.js";

export const localWorkspaceOperations = {
  "localWorkspace.mutate": (
    input: {
      id: string;
      mutation: LocalWorkspaceMutation;
      leases: readonly OpenClawStateLeaseIdentity[];
      receipt: string;
      predicates?: readonly WorktreeRegistryPredicate[];
    },
    { open }: WorkerOperationContext,
  ) => {
    if (
      !input.leases.some(
        (lease) => lease.scope === "workspace.local-reconciliation" && lease.key === input.id,
      )
    ) {
      throw new Error("Local workspace mutation requires reconciliation custody");
    }
    return runOpenClawStateWriteTransaction(
      ({ db }) => {
        const { result: row, receipt } = localWorkspacePublication.capture(db, () =>
          mutateLocalWorkspaceProjection(db, input.id, input.mutation),
        );
        assertOpenClawStateLeasesWorkerOwnedInTransaction(db, input.leases, "commit");
        assertWorktreeRegistryPredicates(db, input.predicates);
        deferSqliteWorkerCommitReceipt(db, {
          operationId: input.receipt,
          receipt: localWorkspacePublication.bound(receipt),
        });
        return row;
      },
      { database: open() },
    );
  },
};
