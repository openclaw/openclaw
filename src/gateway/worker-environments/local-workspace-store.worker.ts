import { deserialize } from "node:v8";
import { inflateRawSync } from "node:zlib";
import { assertWorktreeRegistryPredicates } from "../../agents/worktrees/registry-run-end.worker.js";
import type { WorktreeRegistryPredicate } from "../../agents/worktrees/types.js";
import { deferSqliteWorkerCommitReceipt } from "../../infra/sqlite-worker-operation-admission.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { assertOpenClawStateLeasesWorkerOwnedInTransaction } from "../../state/openclaw-state-lease-worker.js";
import type { OpenClawStateLeaseIdentity } from "../../state/openclaw-state-lease.types.js";
import type { WorkerOperationContext } from "../../state/worker-operation-registry.js";
import type { LocalWorkspacePreparation } from "./local-workspace-cas.js";
import {
  beginLocalWorkspaceSweepInDatabase,
  deleteLocalWorkspaceSweepBatchInDatabase,
  prepareLocalWorkspaceContentInDatabase,
  pruneLocalWorkspaceLegacyBatchInDatabase,
  type LocalWorkspaceSweepCandidates,
} from "./local-workspace-cas.kernel.js";
import { mutateLocalWorkspaceProjection } from "./local-workspace-store.kernel.js";
import type { LocalWorkspaceMutation } from "./local-workspace-store.types.js";

export const localWorkspaceOperations = {
  "localWorkspace.prepare": (
    input: { preparation: Uint8Array },
    { open }: WorkerOperationContext,
  ) => {
    // SAFETY: Only the workspace read/scan owner produces these bounded preparation batches.
    const preparation = deserialize(inflateRawSync(input.preparation)) as LocalWorkspacePreparation;
    return runOpenClawStateWriteTransaction(
      ({ db }) => {
        prepareLocalWorkspaceContentInDatabase(db, preparation);
      },
      { database: open() },
    );
  },
  "localWorkspace.pruneLegacy": (input: { id: string }, { open }: WorkerOperationContext) =>
    runOpenClawStateWriteTransaction(
      ({ db }) => pruneLocalWorkspaceLegacyBatchInDatabase(db, input.id),
      { database: open() },
    ),
  "localWorkspace.beginSweep": (_input: Record<string, never>, { open }: WorkerOperationContext) =>
    runOpenClawStateWriteTransaction(({ db }) => beginLocalWorkspaceSweepInDatabase(db), {
      database: open(),
    }),
  "localWorkspace.sweepBatch": (
    input: { epoch: number; batch: LocalWorkspaceSweepCandidates },
    { open }: WorkerOperationContext,
  ) =>
    runOpenClawStateWriteTransaction(
      ({ db }) => deleteLocalWorkspaceSweepBatchInDatabase(db, input.epoch, input.batch),
      { database: open() },
    ),
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
    // The workspace owner prepares this wire shape. Decode before entering the transaction;
    // current leases and registry predicates still gate the actual commit below.
    const mutation: LocalWorkspaceMutation =
      input.mutation instanceof Uint8Array
        ? (deserialize(inflateRawSync(input.mutation)) as LocalWorkspaceMutation) // SAFETY: The workspace owner serialized a LocalWorkspaceMutation.
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
