import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { resolveServiceManagerEnv } from "../../daemon/service-process-env.js";
import { readControlPlaneUpdateSentinelMeta } from "../../infra/update-control-plane-sentinel.js";
import { resolveUpdateInstallRoot } from "../../infra/update-install-root.js";
import {
  captureManagedUpdateLeaseDatabaseIdentity,
  type ManagedUpdateLeaseDatabaseIdentity,
} from "../../infra/update-managed-service-handoff-database.js";
import {
  createManagedHandoffLeaseStore,
  resolveManagedUpdateLeaseDatabasePath,
  type ManagedHandoffLease,
  type ManagedHandoffParent,
} from "../../infra/update-managed-service-handoff-lease.js";
import type { UpdateRecoveryFence } from "../../infra/update-run-recovery.js";
import { hasCommandProcessCleanupError } from "../../process/exec-result.js";
import { withCommandProcessScope } from "../../process/exec-spawn.js";
import { UpdateActivationTimeoutError } from "./update-command-activation.js";
import {
  createChildOwner,
  type ChildOperation,
  type ChildPurpose,
  type UpdateCommandChildGrant,
} from "./update-command-executor-children.js";
import { resolveUpdateCommandChildBinding } from "./update-command-executor-grant.js";
import {
  acquireLegacyUpdateExecutorParent,
  releaseLegacyPackageUpdateParent,
  type LegacyUpdateExecutorParent,
} from "./update-command-executor-legacy.js";
import { createUpdateIdentityWarningReporter } from "./update-command-identity-warning.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery-error.js";
import { createUpdateOperationDeadline } from "./update-operation-deadline.js";

/** A live invocation, never a serialized claim, PID or recovered history row. */
export type UpdateCommandExecutor = {
  /** Acquire only after read-only service admission, before the first mutable phase. */
  enter(
    root: string,
    options?: { preflight?: true; activationTimeoutMs?: number; serviceRoot?: string },
  ): Promise<UpdateRecoveryFence>;
};

type ManagedUpdateLeaseAuthority = ManagedUpdateLeaseDatabaseIdentity &
  Readonly<{ installKey: string; owner: string }>;
const admittedAuthorities = new WeakMap<
  UpdateRecoveryFence,
  {
    authority: ManagedUpdateLeaseAuthority;
    assertCurrent: () => void;
    managedHandoff: boolean;
  }
>();
const admittedRunIds = new WeakMap<UpdateRecoveryFence, string>();
const retainedOwners = new WeakMap<UpdateRecoveryFence, string>();

export function captureUpdateCommandExecutorAuthority(
  fence: UpdateRecoveryFence,
  runId?: string,
): ManagedUpdateLeaseAuthority {
  fence.assertCurrent();
  const admitted = admittedAuthorities.get(fence);
  if (!admitted || (runId !== undefined && admittedRunIds.get(fence) !== runId)) {
    throw new UpdateCommandRecoveryPendingError("Package recovery requires its admitted executor.");
  }
  return admitted.authority;
}

/** Requester checks also run while a bound child suspends its parent's mutation fence. */
export function assertUpdateRequesterContinuationOwner(
  fence: UpdateRecoveryFence,
  runId: string,
): void {
  const admitted = admittedAuthorities.get(fence);
  if (!admitted?.managedHandoff || admittedRunIds.get(fence) !== runId) {
    throw new UpdateCommandRecoveryPendingError(
      "Requester continuation requires its admitted Gateway update owner.",
    );
  }
  admitted.assertCurrent();
}

/** Compatibility requirement from a live admission, never a serialized claim. */
export function requiresRetainedUpdateCommandOwner(fence: UpdateRecoveryFence): boolean {
  captureUpdateCommandExecutorAuthority(fence);
  return retainedOwners.has(fence);
}

export function assertRetainedUpdateCommandRoot(fence: UpdateRecoveryFence, root: string): void {
  captureUpdateCommandExecutorAuthority(fence);
  if (retainedOwners.get(fence) !== resolveUpdateInstallRoot(root)) {
    throw new UpdateCommandRecoveryPendingError(
      "Service recovery requires its retained executor root.",
    );
  }
}

// Only a direct preflight owner can release before a supervised handoff. Neither
// a saved fence nor a borrowed helper lease grants this one-way transition.
const preflightReleases = new WeakMap<UpdateRecoveryFence, () => void>();
export function releaseUpdateCommandPreflightForHandoff(fence: UpdateRecoveryFence): void {
  const release = preflightReleases.get(fence);
  if (!release) {
    throw new UpdateCommandRecoveryPendingError("Update preflight handoff is not current.");
  }
  release();
}

export type { UpdateCommandChildGrant } from "./update-command-executor-children.js";

const childOwners = new WeakMap<
  UpdateRecoveryFence,
  <T>(root: string, operation: ChildOperation<T>, purpose?: ChildPurpose) => Promise<T>
>();

export async function withUpdateCommandExecutorChild<T>(
  fence: UpdateRecoveryFence,
  root: string,
  operation: ChildOperation<T>,
  purpose?: ChildPurpose,
): Promise<T> {
  const owner = childOwners.get(fence);
  if (!owner) {
    throw new UpdateCommandRecoveryPendingError("Child continuation requires its live executor.");
  }
  return await owner(root, operation, purpose);
}

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
        store,
        parent,
        originalChild,
        child,
        retained,
        retainedChild,
      } = resolveUpdateCommandChildBinding(grant, runId, root, identityWarnings.warn);
      using readConnections = new DisposableStack();
      readConnections.use(store.retainReadConnection());
      let active = true;
      const isLive = (identity: ManagedHandoffLease["executor"]) =>
        store.isProcessIdentityCurrent(identity);
      if (
        !store.acceptParentBoundExecutor(originalChild) ||
        !store.acceptParentBoundExecutor(child) ||
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
        childOwners.delete(fence);
        admittedAuthorities.delete(fence);
        admittedRunIds.delete(fence);
        retainedOwners.delete(fence);
      }
    }, activation.signal),
  );
}

/**
 * Reuse the native handoff owner for direct invocations too. Its database is
 * outside the canonical state family, so checking this fence never opens a
 * displaced/migrated source. Physical source exclusion remains a separate duty.
 */
export async function withUpdateCommandExecutor<T>(
  runId: string,
  operation: (executor: UpdateCommandExecutor) => Promise<T>,
  options?:
    | {
        existingAuthority: Omit<ManagedUpdateLeaseAuthority, "owner">;
        legacyManagedParent?: never;
        legacyPackageParent?: never;
        legacyPackageHandoff?: never;
      }
    | {
        existingAuthority?: never;
        legacyManagedParent: { runId: string; handoffId: string; root: string };
        legacyPackageParent?: never;
        legacyPackageHandoff?: never;
      }
    | {
        existingAuthority?: never;
        legacyManagedParent?: never;
        legacyPackageParent: Extract<LegacyUpdateExecutorParent, { kind: "package" }>["identity"];
        legacyPackageHandoff?: { handoffId: string; root: string };
      },
): Promise<T> {
  const activation = createUpdateOperationDeadline();
  return await activation.run(() =>
    withCommandProcessScope(async () => {
      let active = true;
      let entering = false;
      let databasePath: string | undefined;
      let store: ReturnType<typeof createManagedHandoffLeaseStore> | undefined;
      using readConnections = new DisposableStack();
      let lease: ManagedHandoffParent | undefined;
      let borrowed = false;
      let managedHandoff = false;
      let serviceLease: ManagedHandoffLease | undefined;
      let serviceKey: string | undefined;
      let admissionComplete = false;
      let legacyChild: ManagedHandoffLease | undefined;
      let legacyTarget: ManagedHandoffLease | undefined;
      const identityWarnings = createUpdateIdentityWarningReporter(runId);
      const assertBase = () => {
        if (active || activation.failure) {
          activation.assertCurrent();
        }
        if (
          !active ||
          !admissionComplete ||
          !store ||
          !lease ||
          (serviceLease && !store.owns(serviceLease, "executor")) ||
          (legacyTarget && !store.owns(legacyTarget, "executor")) ||
          (legacyChild
            ? !store.current(lease) ||
              lease.executor.pid !== process.ppid ||
              !store.isProcessIdentityCurrent(lease.helper) ||
              !store.isProcessIdentityCurrent(lease.executor) ||
              !store.owns(legacyChild, "executor")
            : lease.version === 1 || !store.owns(lease, "executor"))
        ) {
          throw new UpdateCommandRecoveryPendingError(
            "Update executor ownership is no longer current.",
          );
        }
      };
      const assertCurrent = () => {
        assertBase();
        if (lease?.version === 3 || serviceLease?.version === 3) {
          throw new UpdateCommandRecoveryPendingError(
            "Parent executor has unresolved native custody.",
          );
        }
        children.assertIdle();
      };
      const fence = { assertCurrent };
      const children = createChildOwner({
        runId,
        assertBase,
        onStart: (purpose) => {
          if (!purpose?.auxiliaryPreflight) {
            preflightReleases.delete(fence);
          }
        },
        binding: () => {
          if (!store || !lease || !databasePath) {
            throw new UpdateCommandRecoveryPendingError("Child executor admission is closed.");
          }
          const spawner = legacyChild ?? lease;
          if (spawner.version === 1) {
            throw new UpdateCommandRecoveryPendingError("Borrowed parent has no child lifetime.");
          }
          return {
            store,
            parent: legacyTarget ?? lease,
            original: lease,
            spawner,
            ...(serviceLease ? { retainedParent: serviceLease } : {}),
            databasePath,
            databaseIdentity: admittedAuthorities.get(fence)?.authority,
          };
        },
      });
      activation.signal.addEventListener("abort", () => children.close(), { once: true });
      childOwners.set(fence, async (root, childOperation, purpose) => {
        try {
          assertCurrent();
          return await children.run(root, childOperation, purpose);
        } catch (error) {
          preflightReleases.delete(fence);
          throw error;
        }
      });
      const executor: UpdateCommandExecutor = {
        async enter(root, enterOptions) {
          // Executor closure owns its recovery error unless a deadline already failed.
          if (active || activation.failure) {
            activation.assertCurrent();
          }
          if (!active || entering) {
            throw new UpdateCommandRecoveryPendingError(
              "Update executor admission is closed or busy.",
            );
          }
          // A missing canonical package is a recorded publication state, not an
          // invitation to resolve a different installation through the current cwd.
          const key = options?.existingAuthority?.installKey ?? resolveUpdateInstallRoot(root);
          if (options?.existingAuthority && root !== key) {
            throw new UpdateCommandRecoveryPendingError("Recovery installation key changed.");
          }
          const requestedServiceKey = enterOptions?.serviceRoot
            ? resolveUpdateInstallRoot(enterOptions.serviceRoot)
            : undefined;
          const distinctServiceKey = requestedServiceKey === key ? undefined : requestedServiceKey;
          if (options?.existingAuthority && distinctServiceKey) {
            throw new UpdateCommandRecoveryPendingError(
              "Recovery cannot acquire a new service root.",
            );
          }
          if (lease) {
            assertCurrent();
            identityWarnings.flush();
            if ((legacyTarget ?? lease).key !== key || serviceKey !== distinctServiceKey) {
              throw new UpdateCommandRecoveryPendingError("Update executor installation changed.");
            }
            if (!enterOptions?.preflight) {
              preflightReleases.delete(fence);
            }
            if (enterOptions?.activationTimeoutMs !== undefined) {
              activation.start(
                new UpdateActivationTimeoutError(key, enterOptions.activationTimeoutMs),
                enterOptions.activationTimeoutMs,
              );
            }
            return fence;
          }
          entering = true;
          try {
            databasePath =
              options?.existingAuthority?.databasePath ?? resolveManagedUpdateLeaseDatabasePath();
            const existingIdentity =
              options?.existingAuthority ??
              (options?.legacyPackageHandoff
                ? captureManagedUpdateLeaseDatabaseIdentity(databasePath)
                : undefined);
            databasePath = existingIdentity?.databasePath ?? databasePath;
            store = createManagedHandoffLeaseStore({
              databasePath,
              serviceManagerEnv: resolveServiceManagerEnv(),
              existingIdentity,
              onProcessIdentityWarning: identityWarnings.warn,
            });
            const found = store.read(key);
            if (found.kind === "unreadable" && !options?.legacyPackageParent) {
              throw new UpdateCommandRecoveryPendingError("Update executor state is unreadable.");
            }
            const legacyParent: LegacyUpdateExecutorParent | undefined =
              options?.legacyManagedParent
                ? { kind: "managed", ...options.legacyManagedParent }
                : options?.legacyPackageParent
                  ? {
                      kind: "package",
                      identity: options.legacyPackageParent,
                      handoff: options.legacyPackageHandoff,
                    }
                  : undefined;
            if (legacyParent) {
              const admitted = acquireLegacyUpdateExecutorParent({
                store,
                key,
                runId,
                parent: legacyParent,
                childName: randomUUID(),
              });
              lease = admitted.lease;
              borrowed = admitted.borrowed;
              legacyChild = admitted.child;
              legacyTarget = admitted.target;
            } else if (
              found.kind === "current" &&
              !options?.existingAuthority &&
              found.lease.helper.pid !== process.pid &&
              found.lease.executor.pid === process.pid
            ) {
              const { isCurrentManagedServiceUpdateHandoffProcess } =
                await import("../../infra/update-managed-service-handoff.js");
              const handedOff = await isCurrentManagedServiceUpdateHandoffProcess({
                root: key,
                runId,
              });
              // Retain the exact row observed before the await. Matching the run in
              // a later metadata read cannot authorize a different lease generation.
              if (
                !active ||
                !handedOff ||
                found.lease.action.kind !== "update" ||
                (!store.owns(found.lease, "executor") &&
                  !(process.connected && store.acceptParentBoundExecutor(found.lease)))
              ) {
                throw new UpdateCommandRecoveryPendingError(
                  "Managed update executor changed during admission.",
                );
              }
              lease = found.lease;
              borrowed = true;
              managedHandoff = true;
            } else {
              const acquired = store.acquire(key, randomUUID(), { kind: "update" });
              if (acquired.kind !== "acquired") {
                throw new UpdateCommandRecoveryPendingError(
                  "Another update executor owns this installation.",
                );
              }
              lease = acquired.lease;
            }
            serviceKey = distinctServiceKey;
            if (serviceKey) {
              const acquired = store.acquire(serviceKey, randomUUID(), { kind: "update" });
              if (acquired.kind !== "acquired") {
                throw new UpdateCommandRecoveryPendingError(
                  "Another update executor owns the managed service installation.",
                );
              }
              serviceLease = acquired.lease;
            }
            admissionComplete = true;
            assertCurrent();
            const authority = Object.freeze({
              ...(existingIdentity ?? captureManagedUpdateLeaseDatabaseIdentity(databasePath)),
              installKey: lease.key,
              owner: lease.owner,
            });
            // Switch the live owner too: capture, later child admission and final
            // release must not recreate a database lost after initial admission.
            databasePath = authority.databasePath;
            store = createManagedHandoffLeaseStore({
              databasePath,
              serviceManagerEnv: resolveServiceManagerEnv(),
              existingIdentity: authority,
              onProcessIdentityWarning: identityWarnings.warn,
            });
            readConnections.use(store.retainReadConnection());
            if (
              borrowed &&
              !legacyChild &&
              (lease.version === 1 || !store.owns(lease, "executor")) &&
              !(lease.version !== 1 && process.connected && store.acceptParentBoundExecutor(lease))
            ) {
              throw new UpdateCommandRecoveryPendingError(
                "Managed update executor changed during admission.",
              );
            }
            assertCurrent();
            admittedAuthorities.set(fence, {
              authority,
              assertCurrent: assertBase,
              managedHandoff,
            });
            admittedRunIds.set(fence, runId);
            if (serviceLease) {
              retainedOwners.set(fence, serviceLease.key);
            }
            if (enterOptions?.preflight && !borrowed) {
              preflightReleases.set(fence, () => {
                assertCurrent();
                if (!store || !lease || children.pending) {
                  throw new UpdateCommandRecoveryPendingError("Preflight executor release failed.");
                }
                active = false;
                children.close();
                childOwners.delete(fence);
                admittedAuthorities.delete(fence);
                admittedRunIds.delete(fence);
                retainedOwners.delete(fence);
                preflightReleases.delete(fence);
                if (serviceLease) {
                  if (!store.release(serviceLease)) {
                    throw new UpdateCommandRecoveryPendingError(
                      "Preflight service owner release failed.",
                    );
                  }
                  serviceLease = undefined;
                }
                if (lease.version === 1 || !store.release(lease)) {
                  throw new UpdateCommandRecoveryPendingError("Preflight executor release failed.");
                }
                lease = undefined;
                readConnections.dispose();
              });
            }
            if (enterOptions?.activationTimeoutMs !== undefined) {
              activation.start(
                new UpdateActivationTimeoutError(key, enterOptions.activationTimeoutMs),
                enterOptions.activationTimeoutMs,
              );
            }
            return fence;
          } finally {
            entering = false;
          }
        },
      };
      let outcome: { result: T } | { error: Error };
      try {
        outcome = {
          result: await withCommandProcessScope(async () => {
            let operationOutcome: { result: T } | { error: Error };
            try {
              operationOutcome = { result: await operation(executor) };
            } catch (cause) {
              operationOutcome = {
                error:
                  cause instanceof Error ? cause : new Error("Update execution failed", { cause }),
              };
            }
            // Admitted children retain authority after the callback returns or
            // rejects. Join them before this scope stops its remaining commands.
            children.close();
            try {
              await children.settle();
              if ("result" in operationOutcome) {
                if (lease) {
                  assertCurrent();
                }
                identityWarnings.flush();
              }
            } catch (cause) {
              operationOutcome = {
                error:
                  "error" in operationOutcome && operationOutcome.error !== cause
                    ? new AggregateError([operationOutcome.error, cause], "Update cleanup failed", {
                        cause,
                      })
                    : cause instanceof Error
                      ? cause
                      : new Error("Update settlement failed", { cause }),
              };
            }
            if ("error" in operationOutcome) {
              throw operationOutcome.error;
            }
            return operationOutcome.result;
          }),
        };
      } catch (cause) {
        outcome = {
          error: cause instanceof Error ? cause : new Error("Update execution failed", { cause }),
        };
      }
      active = false;
      preflightReleases.delete(fence);
      childOwners.delete(fence);
      admittedAuthorities.delete(fence);
      admittedRunIds.delete(fence);
      retainedOwners.delete(fence);
      if ("error" in outcome && hasCommandProcessCleanupError(outcome.error)) {
        throw new UpdateCommandRecoveryPendingError(
          "Command cleanup is unconfirmed; update ownership remains retained.",
          { cause: outcome.error },
        );
      }
      try {
        if (serviceLease && store && (serviceLease.version === 3 || !store.release(serviceLease))) {
          throw new UpdateCommandRecoveryPendingError(
            "Managed service executor release could not be confirmed.",
          );
        }
        if (legacyTarget && store && !store.release(legacyTarget)) {
          throw new UpdateCommandRecoveryPendingError("Active package generation has not settled.");
        }
        if (legacyChild && store && !store.release(legacyChild)) {
          throw new UpdateCommandRecoveryPendingError("Legacy finalizer has not settled.");
        }
        if (
          lease &&
          store &&
          (lease.version === 3 ||
            (!borrowed &&
              (lease.version === 1 ||
                !(options?.legacyPackageParent
                  ? releaseLegacyPackageUpdateParent(store, lease)
                  : store.release(lease)))))
        ) {
          throw new UpdateCommandRecoveryPendingError(
            "Update executor release could not be confirmed.",
          );
        }
      } catch (cause) {
        if ("error" in outcome) {
          throw new UpdateCommandRecoveryPendingError(
            "Update failed and executor release remains pending",
            {
              cause: new AggregateError([outcome.error, cause], "Update executor cleanup failed", {
                cause: outcome.error,
              }),
            },
          );
        }
        throw cause;
      }
      if ("error" in outcome) {
        throw outcome.error;
      }
      return outcome.result;
    }, activation.signal),
  );
}
