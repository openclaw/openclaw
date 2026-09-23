import { randomUUID } from "node:crypto";
import { resolveServiceManagerEnv } from "../../daemon/service-process-env.js";
import { readControlPlaneUpdateSentinelMeta } from "../../infra/update-control-plane-sentinel.js";
import { resolveUpdateInstallRoot } from "../../infra/update-install-root.js";
import { captureManagedUpdateLeaseDatabaseIdentity } from "../../infra/update-managed-service-handoff-database.js";
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
  admittedAuthorities,
  admittedRunIds,
  childOwners,
  clearUpdateCommandExecutorAdmission,
  preflightReleases,
  retainedOwners,
  type ManagedUpdateLeaseAuthority,
} from "./update-command-executor-admission.js";
import {
  createChildOwner,
  type UpdateCommandChildGrant,
} from "./update-command-executor-children.js";
import {
  assertUpdateCommandChildBindingCurrent,
  resolveUpdateCommandChildBinding,
} from "./update-command-executor-grant.js";
import {
  acquireLegacyUpdateExecutorParent,
  releaseLegacyPackageUpdateParent,
  type LegacyUpdateExecutorParent,
} from "./update-command-executor-legacy.js";
import { createUpdateIdentityWarningReporter } from "./update-command-identity-warning.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery-error.js";
import { createUpdateOperationDeadline } from "./update-operation-deadline.js";

function observeAuthorityFailure(observer: ((cause: unknown) => void) | undefined, cause: unknown) {
  if (!(cause instanceof UpdateActivationTimeoutError)) {
    observer?.(cause);
  }
}

function observeNativeAuthority(
  observer: ((cause: unknown) => void) | undefined,
  check: () => void,
) {
  return () => {
    try {
      check();
    } catch (cause) {
      observeAuthorityFailure(observer, cause);
      throw cause;
    }
  };
}

// Only an admitted native owner may inspect selected state to derive a budget.
type UpdateActivationBudget =
  | number
  | ((fence: UpdateRecoveryFence) => Promise<number | undefined>);

/** A live invocation, never a serialized claim, PID or recovered history row. */
export type UpdateCommandExecutor = {
  /** Acquire only after read-only service admission, before the first mutable phase. */
  enter(
    root: string,
    options?: {
      preflight?: true;
      activationTimeoutMs?: UpdateActivationBudget;
      serviceRoot?: string;
    },
  ): Promise<UpdateRecoveryFence>;
};

export {
  assertRetainedUpdateCommandRoot,
  assertUpdateRequesterContinuationOwner,
  captureUpdateCommandExecutorAuthority,
  releaseUpdateCommandPreflightForHandoff,
  requiresRetainedUpdateCommandOwner,
  withUpdateCommandExecutorChild,
  type UpdateCommandChildGrant,
} from "./update-command-executor-admission.js";

/** A delegated executor retains both its original root and immediate spawner.
 * Neither the transported grant nor a lease row without live identity grants effects. */
export async function withDelegatedUpdateCommandExecutor<T>(
  grant: UpdateCommandChildGrant,
  runId: string,
  root: string,
  operation: (fence: UpdateRecoveryFence) => Promise<T>,
  options?: {
    activationTimeoutMs?: UpdateActivationBudget;
    onAuthorityFailure?: (cause: unknown) => void;
  },
): Promise<T> {
  const activation = createUpdateOperationDeadline();
  return await activation.run(() =>
    withCommandProcessScope(async () => {
      const identityWarnings = createUpdateIdentityWarningReporter(runId);
      const binding = resolveUpdateCommandChildBinding(grant, runId, root, identityWarnings.warn);
      const {
        original,
        databaseIdentity,
        databasePath,
        store,
        parent,
        originalChild,
        child,
        retained,
        retainedChild,
      } = binding;
      let active = true;
      if (
        !store.acceptParentBoundExecutor(originalChild) ||
        !store.acceptParentBoundExecutor(child) ||
        (retainedChild && !store.acceptParentBoundExecutor(retainedChild))
      ) {
        throw new UpdateCommandRecoveryPendingError(
          "The update process no longer has permission to continue.",
        );
      }
      const assertNative = observeNativeAuthority(options?.onAuthorityFailure, () => {
        if (!active) {
          throw new UpdateCommandRecoveryPendingError(
            "The update process no longer has permission to continue.",
          );
        }
        assertUpdateCommandChildBindingCurrent(binding);
      });
      const assertBase = () => {
        if (!active && activation.failure) {
          activation.assertCurrent();
        }
        assertNative();
        activation.assertCurrent();
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
      const assertIdle = observeNativeAuthority(options?.onAuthorityFailure, () => {
        owner.assertIdle();
      });
      // Deadline expiry cannot hide custody lost during child settlement. Only
      // the public effect fence applies the deadline before ordinary busy state.
      const assertSettled = () => {
        assertNative();
        assertIdle();
      };
      const fence = {
        assertCurrent() {
          assertBase();
          assertIdle();
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
            let timeoutMs = options?.activationTimeoutMs;
            if (typeof timeoutMs === "function") {
              timeoutMs = await timeoutMs(fence);
              fence.assertCurrent();
            }
            if (timeoutMs !== undefined) {
              activation.start(new UpdateActivationTimeoutError(root, timeoutMs), timeoutMs);
            }
            outcome = { result: await operation(fence) };
          } catch (error) {
            outcome = { error };
          }
          owner.close();
          try {
            await owner.settle();
            assertSettled();
            identityWarnings.flush();
          } catch (cause) {
            try {
              assertSettled();
            } catch {
              /* Preserve the settlement failure below. */
            }
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
        clearUpdateCommandExecutorAdmission(fence);
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
  options?: (
    | {
        existingAuthority?: never;
        legacyManagedParent?: never;
        legacyPackageParent?: never;
        legacyPackageHandoff?: never;
      }
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
      }
  ) & { onAuthorityFailure?: (cause: unknown) => void },
): Promise<T> {
  const activation = createUpdateOperationDeadline();
  return await activation.run(() =>
    withCommandProcessScope(async () => {
      let active = true;
      let entering = false;
      let databasePath: string | undefined;
      let store: ReturnType<typeof createManagedHandoffLeaseStore> | undefined;
      let lease: ManagedHandoffParent | undefined;
      let borrowed = false;
      let managedHandoff = false;
      let serviceLease: ManagedHandoffLease | undefined;
      let serviceKey: string | undefined;
      let admissionComplete = false;
      let legacyChild: ManagedHandoffLease | undefined;
      let legacyTarget: ManagedHandoffLease | undefined;
      const identityWarnings = createUpdateIdentityWarningReporter(runId);
      const assertNative = observeNativeAuthority(options?.onAuthorityFailure, () => {
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
      });
      const assertBase = () => {
        if (!active && activation.failure) {
          activation.assertCurrent();
        }
        assertNative();
        activation.assertCurrent();
      };
      const assertIdle = observeNativeAuthority(options?.onAuthorityFailure, () => {
        if (lease?.version === 3 || serviceLease?.version === 3) {
          throw new UpdateCommandRecoveryPendingError(
            "Parent executor has unresolved native custody.",
          );
        }
        children.assertIdle();
      });
      const assertSettled = () => {
        assertNative();
        assertIdle();
      };
      const assertCurrent = () => {
        assertBase();
        assertIdle();
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
          try {
            // An expired operation must not hide a changed native generation.
            if (active && lease) {
              assertNative();
            }
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
            const distinctServiceKey =
              requestedServiceKey === key ? undefined : requestedServiceKey;
            if (options?.existingAuthority && distinctServiceKey) {
              throw new UpdateCommandRecoveryPendingError(
                "Recovery cannot acquire a new service root.",
              );
            }
            if (lease) {
              assertCurrent();
              identityWarnings.flush();
              if ((legacyTarget ?? lease).key !== key || serviceKey !== distinctServiceKey) {
                throw new UpdateCommandRecoveryPendingError(
                  "Update executor installation changed.",
                );
              }
              if (!enterOptions?.preflight) {
                preflightReleases.delete(fence);
              }
              let timeoutMs = enterOptions?.activationTimeoutMs;
              if (typeof timeoutMs === "function") {
                timeoutMs = await timeoutMs(fence);
                assertCurrent();
              }
              if (timeoutMs !== undefined) {
                activation.start(new UpdateActivationTimeoutError(key, timeoutMs), timeoutMs);
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
              if (
                borrowed &&
                !legacyChild &&
                (lease.version === 1 || !store.owns(lease, "executor")) &&
                !(
                  lease.version !== 1 &&
                  process.connected &&
                  store.acceptParentBoundExecutor(lease)
                )
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
                  try {
                    assertCurrent();
                    if (!store || !lease || children.pending) {
                      throw new UpdateCommandRecoveryPendingError(
                        "Preflight executor release failed.",
                      );
                    }
                    active = false;
                    children.close();
                    childOwners.delete(fence);
                    clearUpdateCommandExecutorAdmission(fence);
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
                      throw new UpdateCommandRecoveryPendingError(
                        "Preflight executor release failed.",
                      );
                    }
                    lease = undefined;
                  } catch (cause) {
                    observeAuthorityFailure(options?.onAuthorityFailure, cause);
                    throw cause;
                  }
                });
              }
              let timeoutMs = enterOptions?.activationTimeoutMs;
              if (typeof timeoutMs === "function") {
                timeoutMs = await timeoutMs(fence);
                assertCurrent();
              }
              if (timeoutMs !== undefined) {
                activation.start(new UpdateActivationTimeoutError(key, timeoutMs), timeoutMs);
              }
              return fence;
            } finally {
              entering = false;
            }
          } catch (cause) {
            observeAuthorityFailure(options?.onAuthorityFailure, cause);
            throw cause;
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
              if (lease && ("result" in operationOutcome || options?.onAuthorityFailure)) {
                assertSettled();
              }
              if ("result" in operationOutcome) {
                identityWarnings.flush();
              }
            } catch (cause) {
              try {
                if (lease) {
                  assertSettled();
                }
              } catch {
                /* Preserve the settlement failure below. */
              }
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
      clearUpdateCommandExecutorAdmission(fence);
      if ("error" in outcome && hasCommandProcessCleanupError(outcome.error)) {
        const failure = new UpdateCommandRecoveryPendingError(
          "Command cleanup is unconfirmed; update ownership remains retained.",
          { cause: outcome.error },
        );
        observeAuthorityFailure(options?.onAuthorityFailure, failure);
        throw failure;
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
        observeAuthorityFailure(options?.onAuthorityFailure, cause);
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
