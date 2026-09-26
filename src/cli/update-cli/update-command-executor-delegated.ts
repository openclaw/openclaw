import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { readControlPlaneUpdateSentinelMeta } from "../../infra/update-control-plane-sentinel.js";
import { resolveUpdateInstallRoot } from "../../infra/update-install-root.js";
import type {
  ManagedHandoffLease,
  ManagedHandoffParent,
} from "../../infra/update-managed-service-handoff-lease.js";
import type { UpdateRecoveryFence } from "../../infra/update-run-recovery.js";
import { withCommandProcessScope } from "../../process/exec-spawn.js";
import { UpdateActivationTimeoutError } from "./update-command-activation.js";
import {
  createChildOwner,
  type UpdateCommandChildGrant,
} from "./update-command-executor-children.js";
import { resolveUpdateCommandChildBinding } from "./update-command-executor-grant.js";
import {
  admittedAuthorities,
  admittedRunIds,
  retainedOwners,
  slotReservations,
  occupiedSlotKey,
  childOwners,
} from "./update-command-executor-state.js";
import { createUpdateIdentityWarningReporter } from "./update-command-identity-warning.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery-error.js";
import { createUpdateOperationDeadline } from "./update-operation-deadline.js";

/** A delegated executor retains both its original root and immediate spawner.
 * Neither the transported grant nor a lease row without live identity grants effects. */
export async function withDelegatedUpdateCommandExecutor<T>(
  grant: UpdateCommandChildGrant,
  runId: string,
  root: string,
  operation: (fence: UpdateRecoveryFence) => Promise<T>,
  options?: { activationTimeoutMs: number },
): Promise<T> {
  const activation = createUpdateOperationDeadline();
  return await activation.run(() =>
    withCommandProcessScope(async () => {
      const identityWarnings = createUpdateIdentityWarningReporter(runId);
      const {
        original,
        spawner,
        databaseIdentity,
        databasePath,
        initialStoreAdmission,
        store,
        parent,
        originalChild,
        child,
        retained,
        retainedChild,
        slot,
        slotChild,
      } = resolveUpdateCommandChildBinding(grant, runId, root, identityWarnings.warn);
      using readConnections = new DisposableStack();
      readConnections.use(store.retainReadConnection());
      let active = true;
      const isLive = (identity: ManagedHandoffLease["executor"]) =>
        store.isProcessIdentityCurrent(identity);
      if (
        !store.acceptParentBoundExecutor(originalChild) ||
        !store.acceptParentBoundExecutor(child) ||
        (slotChild && !store.acceptParentBoundExecutor(slotChild)) ||
        (retainedChild && !store.acceptParentBoundExecutor(retainedChild))
      ) {
        throw new UpdateCommandRecoveryPendingError(
          "The update process no longer has permission to continue.",
        );
      }
      const assertBase = () => {
        if (active || activation.failure) {
          activation.assertCurrent();
        }
        // Several lineage roles can name the same full lease. Share only this
        // assertion's successful checks; every later assertion reads live state.
        const checkedParents: ManagedHandoffParent[] = [];
        const checkedReceivers: ManagedHandoffLease[] = [];
        const parentIsCurrent = (lease: ManagedHandoffParent) => {
          if (checkedParents.some((checked) => isDeepStrictEqual(checked, lease))) {
            return true;
          }
          if (!store.current(lease) || !isLive(lease.helper) || !isLive(lease.executor)) {
            return false;
          }
          checkedParents.push(lease);
          return true;
        };
        const receiverIsCurrent = (lease: ManagedHandoffLease) => {
          if (checkedReceivers.some((checked) => isDeepStrictEqual(checked, lease))) {
            return true;
          }
          if (!store.owns(lease, "executor")) {
            return false;
          }
          checkedReceivers.push(lease);
          return true;
        };
        if (
          !active ||
          !parentIsCurrent(original) ||
          !parentIsCurrent(parent) ||
          !parentIsCurrent(spawner) ||
          !receiverIsCurrent(originalChild) ||
          !receiverIsCurrent(child) ||
          (slot &&
            (!slotChild ||
              !parentIsCurrent(slot.parent) ||
              !parentIsCurrent(slot.spawner) ||
              (slot.reserver && !parentIsCurrent(slot.reserver)) ||
              !receiverIsCurrent(slotChild))) ||
          (retained &&
            (!retainedChild || !parentIsCurrent(retained) || !receiverIsCurrent(retainedChild)))
        ) {
          throw new UpdateCommandRecoveryPendingError(
            "The update process no longer has permission to continue.",
          );
        }
      };
      const owner = createChildOwner({
        runId,
        binding: () => ({
          store,
          parent,
          original,
          spawner: originalChild,
          ...(slot && slotChild
            ? {
                slot: {
                  parent: slot.parent,
                  spawner: slotChild,
                  ...(slot.reserver ? { reserver: slot.reserver } : {}),
                },
              }
            : {}),
          ...(retained ? { retainedParent: retained } : {}),
          databasePath,
          databaseIdentity,
          initialStores: grant.initialStores,
        }),
        assertBase,
      });
      activation.signal.addEventListener("abort", () => owner.close(), { once: true });
      const fence = {
        assertCurrent() {
          assertBase();
          owner.assertIdle();
        },
      };
      slotReservations.set(fence, (slotRoot) => {
        fence.assertCurrent();
        if (path.resolve(slotRoot) === original.key) {
          return;
        }
        const key = occupiedSlotKey(slotRoot);
        if (key !== original.key && key !== slot?.parent.key) {
          throw new UpdateCommandRecoveryPendingError(
            "Candidate cannot reserve an ungranted installation slot.",
          );
        }
      });
      const meta = await readControlPlaneUpdateSentinelMeta();
      assertBase();
      const managedHandoff =
        original.version !== 1 &&
        original.helper.pid !== original.executor.pid &&
        meta?.runId === runId &&
        meta.handoffId === original.owner &&
        meta.root !== undefined &&
        resolveUpdateInstallRoot(meta.root) === original.key;
      childOwners.set(fence, (childRoot, childOperation, purpose) =>
        owner.run(childRoot, childOperation, purpose),
      );
      try {
        return await withCommandProcessScope(async () => {
          let outcome: { result: T } | { error: unknown };
          try {
            fence.assertCurrent();
            if (databaseIdentity) {
              admittedRunIds.set(fence, runId);
              admittedAuthorities.set(fence, {
                authority: Object.freeze({
                  ...databaseIdentity,
                  installKey: original.key,
                  owner: original.owner,
                }),
                assertCurrent: assertBase,
                managedHandoff,
              });
            }
            if (retained) {
              retainedOwners.set(fence, retained.key);
            }
            if (options) {
              activation.start(
                new UpdateActivationTimeoutError(root, options.activationTimeoutMs),
                options.activationTimeoutMs,
              );
            }
            outcome = { result: await operation(fence) };
          } catch (error) {
            outcome = { error };
          }
          owner.close();
          try {
            await owner.settle();
            fence.assertCurrent();
            identityWarnings.flush();
          } catch (cause) {
            outcome = {
              error:
                "error" in outcome && outcome.error !== cause
                  ? new AggregateError(
                      [outcome.error, cause],
                      "Unable to finish stopping the update process and its children",
                      { cause },
                    )
                  : cause,
            };
          }
          if ("error" in outcome) {
            throw outcome.error;
          }
          return outcome.result;
        });
      } finally {
        active = false;
        initialStoreAdmission?.close();
        childOwners.delete(fence);
        slotReservations.delete(fence);
        admittedAuthorities.delete(fence);
        admittedRunIds.delete(fence);
        retainedOwners.delete(fence);
      }
    }, activation.signal),
  );
}
