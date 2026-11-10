import path from "node:path";
import { requestCliParentTermination } from "../../../cli-parent-lifetime.mjs";
import { GATEWAY_OWNER_HEARTBEAT_MS } from "../../infra/gateway-lock-payload.js";
import { readControlPlaneUpdateSentinelMeta } from "../../infra/update-control-plane-sentinel.js";
import { resolveUpdateInstallRoot } from "../../infra/update-install-root.js";
import type { ManagedCommandProcessAuthority } from "../../infra/update-managed-command-custody.js";
import type { UpdateRecoveryFence } from "../../infra/update-run-recovery.js";
import { withCommandProcessScope } from "../../process/exec-spawn.js";
import { UpdateActivationTimeoutError } from "./update-command-activation.js";
import { createChildOwner } from "./update-command-executor-children.js";
import { resolveUpdateCommandChildBinding } from "./update-command-executor-grant.js";
import {
  prepareUpdateCommandExecutorTerminal,
  withUpdateCommandExecutorOperation,
} from "./update-command-executor-operation.js";
import {
  admittedAuthorities,
  slotReservations,
  occupiedSlotKey,
  childOwners,
  terminalPreparations,
} from "./update-command-executor-state.js";
import { createUpdateIdentityWarningReporter } from "./update-command-identity-warning.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery-error.js";
import { createUpdateOperationDeadline } from "./update-operation-deadline.js";

/** A delegated executor retains both its original root and immediate spawner.
 * Neither the transported grant nor a lease row without live identity grants effects. */
export async function withDelegatedUpdateCommandExecutor<T>(
  grant: unknown,
  runId: string,
  root: string,
  operation: (
    fence: UpdateRecoveryFence,
    commandAuthority: ManagedCommandProcessAuthority,
  ) => Promise<T>,
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
        store,
        parent,
        originalChild,
        child,
        retained,
        retainedChild,
        slot,
        slotChild,
      } = await resolveUpdateCommandChildBinding(grant, runId, root, identityWarnings.warn);
      using readConnections = new DisposableStack();
      readConnections.use(store.retainReadConnection());
      let active = true;
      const parents = [
        original,
        parent,
        spawner,
        ...(slot ? [slot.parent, slot.spawner, ...(slot.reserver ? [slot.reserver] : [])] : []),
        ...(retained ? [retained] : []),
      ];
      const receivers = [
        originalChild,
        child,
        ...(slotChild ? [slotChild] : []),
        ...(retainedChild ? [retainedChild] : []),
      ];
      // Windows launcher ancestry can differ from the recorded spawner. The live
      // lease must still bind this PID and start identity; only an immediate
      // parent may supply the existing fallback for an unreadable self identity.
      if (
        !receivers.every(
          (lease) =>
            (process.platform === "win32" && store.owns(lease, "executor")) ||
            store.acceptParentBoundExecutor(lease),
        )
      ) {
        throw new UpdateCommandRecoveryPendingError(
          "The update process no longer has permission to continue.",
        );
      }
      const assertBase = () => {
        if (active || activation.failure) {
          activation.assertCurrent();
        }
        if (
          !active ||
          (slot && !slotChild) ||
          (retained && !retainedChild) ||
          !store.ownsDelegation(parents, receivers)
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
        [original.key, parent.key].includes(resolveUpdateInstallRoot(meta.root));
      childOwners.set(fence, (childRoot, childOperation, purpose) =>
        owner.run(childRoot, childOperation, purpose),
      );
      const processes = new Map(
        parents.flatMap((lease) =>
          [lease.helper, lease.executor].map(
            (identity) => [`${identity.pid}:${identity.startIdentity}`, identity] as const,
          ),
        ),
      );
      // A stalled await cannot recheck its fence. End orphaned maintenance through
      // the normal bounded shutdown; peers still wait for this process to exit.
      const parentWatch = setInterval(() => {
        for (const identity of processes.values()) {
          const state = store.inspectProcessIdentity(identity);
          if (state === "dead" || state === "mismatch") {
            requestCliParentTermination();
            break;
          }
        }
      }, GATEWAY_OWNER_HEARTBEAT_MS);
      parentWatch.unref();
      try {
        const operationOutcome = await withUpdateCommandExecutorOperation(
          {
            children: owner,
            operation: () => {
              fence.assertCurrent();
              admittedAuthorities.set(fence, {
                authority: Object.freeze({
                  ...databaseIdentity,
                  installKey: original.key,
                  owner: original.owner,
                }),
                assertCurrent: assertBase,
                managedHandoff,
                runId,
                retainedRoot: retained?.key,
              });
              if (options) {
                activation.start(
                  new UpdateActivationTimeoutError(root, options.activationTimeoutMs),
                  options.activationTimeoutMs,
                );
              }
              return operation(fence, {
                runId,
                databaseIdentity,
                parents: [
                  originalChild,
                  child,
                  ...(retainedChild ? [retainedChild] : []),
                  ...(slotChild ? [slotChild] : []),
                ],
              });
            },
          },
          "delegated",
        ).then(
          (result) => ({ result }),
          (error: unknown) => ({ error }),
        );
        const outcome = await prepareUpdateCommandExecutorTerminal(fence, operationOutcome);
        if ("error" in outcome) {
          throw outcome.error;
        }
        return outcome.result;
      } finally {
        clearInterval(parentWatch);
        identityWarnings.flush();
        active = false;
        childOwners.delete(fence);
        slotReservations.delete(fence);
        admittedAuthorities.delete(fence);
        terminalPreparations.delete(fence);
      }
    }, activation.signal),
  );
}
