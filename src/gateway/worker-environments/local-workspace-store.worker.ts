import { deserialize } from "node:v8";
import { inflateRawSync } from "node:zlib";
import { assertWorktreeRegistryPredicates } from "../../agents/worktrees/registry-run-end.worker.js";
import type { WorktreeRegistryPredicate } from "../../agents/worktrees/types.js";
import { deferSqliteWorkerCommitReceipt } from "../../infra/sqlite-worker-operation-admission.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { assertOpenClawStateLeasesWorkerOwnedInTransaction } from "../../state/openclaw-state-lease-worker.js";
import type { OpenClawStateLeaseIdentity } from "../../state/openclaw-state-lease.types.js";
import type { WorkerOperationContext } from "../../state/worker-operation-registry.js";
import {
  mutateLocalWorkspaceProjection,
  type LocalWorkspaceMutation,
} from "./local-workspace-store.kernel.js";

export const localWorkspaceOperations = {
  "localWorkspace.mutate": (
    input: {
      id: string;
      mutation: LocalWorkspaceMutation | Uint8Array;
      leases: readonly OpenClawStateLeaseIdentity[];
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
    // The host owns this internal wire shape. Decode before entering the transaction;
    // current leases and registry predicates still gate the actual commit below.
    const mutation: LocalWorkspaceMutation =
      input.mutation instanceof Uint8Array
        ? (deserialize(inflateRawSync(input.mutation)) as LocalWorkspaceMutation) // SAFETY: The host serialized a LocalWorkspaceMutation.
        : input.mutation;
    return runOpenClawStateWriteTransaction(
      ({ db }) => {
        const committed = mutateLocalWorkspaceProjection(db, input.id, mutation) ?? null;
        assertOpenClawStateLeasesWorkerOwnedInTransaction(db, input.leases, "commit");
        assertWorktreeRegistryPredicates(db, input.predicates);
        deferSqliteWorkerCommitReceipt(db, committed);
        return committed;
      },
      { database: open() },
    );
  },
};
