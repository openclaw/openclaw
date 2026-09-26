import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveServiceManagerEnv } from "../../daemon/service-process-env.js";
import { withPackageReverseSymlinkCustody } from "../../infra/package-update-activation-symlink.js";
import {
  admitUpdateInitialStoreTransport,
  snapshotUpdateInitialStoreTransport,
} from "../../infra/update-initial-store-transport.js";
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
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { UpdateActivationTimeoutError } from "./update-command-activation.js";
import { createUpdateCommandOriginalCancellation } from "./update-command-executor-cancellation.js";
import {
  requestUpdateCommandExecutorCancellation,
  reserveUpdateCommandExecutorSlot,
} from "./update-command-executor-capabilities.js";
import { createChildOwner } from "./update-command-executor-children.js";
import { registerUpdateCommandGenerationOwner } from "./update-command-executor-generation.js";
import {
  acquireLegacyUpdateExecutorParent,
  releaseLegacyPackageUpdateParent,
  type LegacyUpdateExecutorParent,
} from "./update-command-executor-legacy.js";
import {
  admitManagedUpdateCommandGeneration,
  assertManagedAdmission,
  assertManagedUpdateCommandPlan,
  assertManagedUpdateCommandRoot,
  completeManagedUpdateCommandOutcome,
  finishManagedUpdateCommandGeneration,
  readManagedUpdateCommandRetainedLease,
} from "./update-command-executor-managed.js";
import {
  createUpdateCommandReadConnections,
  runUpdateCommandExecutorOperation,
} from "./update-command-executor-operation.js";
import {
  captureUpdateCommandDirectLocation,
  resolveUpdateCommandRetainedRoot,
  type UpdateCommandExecutor,
  type UpdateCommandExecutorOptions,
} from "./update-command-executor-options.js";
import {
  originalCancellations,
  admittedAuthorities,
  admittedRunIds,
  retainedOwners,
  preflightReleases,
  slotReservations,
  occupiedSlotKey,
  childOwners,
} from "./update-command-executor-state.js";
import { createUpdateIdentityWarningReporter } from "./update-command-identity-warning.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery-error.js";
import { createUpdateOperationDeadline } from "./update-operation-deadline.js";

export * from "./update-command-executor-capabilities.js";
export type { UpdateCommandChildGrant } from "./update-command-executor-children.js";

export type { UpdateCommandExecutor } from "./update-command-executor-options.js";

/**
 * Reuse the native handoff owner for direct invocations too. Its database is
 * outside the canonical state family, so checking this fence never opens a
 * displaced/migrated source. Physical source exclusion remains a separate duty.
 */
export async function withUpdateCommandExecutor<T>(
  runId: string,
  operation: (executor: UpdateCommandExecutor) => Promise<T>,
  options?: UpdateCommandExecutorOptions,
): Promise<T> {
  const managedIssuer = options?.managedGeneration;
  let initialStores =
    options && Object.hasOwn(options, "initialStores")
      ? snapshotUpdateInitialStoreTransport(options.initialStores!)
      : undefined;
  const directDatabasePath = captureUpdateCommandDirectLocation(options);
  let initialStoreAdmission: ReturnType<typeof admitUpdateInitialStoreTransport> | undefined;
  let originalFence: UpdateRecoveryFence | undefined;
  const activation = createUpdateOperationDeadline((cause) => {
    if (originalFence) {
      requestUpdateCommandExecutorCancellation(originalFence, runId, cause);
    }
  });
  const cancellationSignal = new AbortController();
  const operationSignal = AbortSignal.any([activation.signal, cancellationSignal.signal]);
  return await activation.run(async () => {
    try {
      return await withPackageReverseSymlinkCustody(() =>
        withCommandProcessScope(async () => {
          let active = true;
          let entering = false;
          let databasePath: string | undefined;
          let store: ReturnType<typeof createManagedHandoffLeaseStore> | undefined;
          using readConnections = createUpdateCommandReadConnections();
          let lease: ManagedHandoffParent | undefined;
          let slotLease: ManagedHandoffLease | undefined;
          let borrowed = false;
          let managedHandoff = false;
          let serviceLease: ManagedHandoffLease | undefined;
          let serviceKey: string | undefined;
          let admissionComplete = false;
          let generation: ReturnType<typeof registerUpdateCommandGenerationOwner> | undefined;
          let managed: Awaited<ReturnType<typeof admitManagedUpdateCommandGeneration>> | undefined;
          let legacyChild: ManagedHandoffLease | undefined;
          let legacyTarget: ManagedHandoffLease | undefined;
          const cancellation = createUpdateCommandOriginalCancellation({
            runId,
            signal: cancellationSignal,
            current: () => ({ active, store, lease, serviceLease }),
            closeChildren: () => children.close(),
          });
          const identityWarnings = createUpdateIdentityWarningReporter(runId);
          const assertBase = () => {
            const cancelled = cancellation.cause ?? managed?.cause;
            if (cancelled) {
              throw cancelled;
            }
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
              (slotLease && !store.owns(slotLease, "executor")) ||
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
          const assertPublicationCurrent = () => {
            assertBase();
            managed?.assertCurrent();
            generation?.assertPublicationCurrent();
            if (lease?.version === 3 || serviceLease?.version === 3) {
              throw new UpdateCommandRecoveryPendingError(
                "Parent executor has unresolved native custody.",
              );
            }
            children.assertIdle();
          };
          const assertCurrent = () => {
            assertPublicationCurrent();
            generation?.assertReady();
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
                throw new UpdateCommandRecoveryPendingError(
                  "Borrowed parent has no child lifetime.",
                );
              }
              return {
                store,
                parent: legacyTarget ?? lease,
                original: lease,
                spawner,
                ...(slotLease
                  ? {
                      slot: {
                        parent: slotLease,
                        spawner: slotLease,
                        ...(legacyChild ? { reserver: legacyChild } : {}),
                      },
                    }
                  : {}),
                ...(serviceLease ? { retainedParent: serviceLease } : {}),
                databasePath,
                databaseIdentity: admittedAuthorities.get(fence)?.authority,
                initialStores,
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
          slotReservations.set(fence, (root) => {
            assertCurrent();
            if (!store || !lease) {
              throw new UpdateCommandRecoveryPendingError(
                "Slot reservation requires its live executor.",
              );
            }
            const installLease = legacyTarget ?? lease;
            if (path.resolve(root) === installLease.key) {
              return;
            }
            const key = occupiedSlotKey(root);
            if (key === installLease.key) {
              return;
            }
            if (slotLease) {
              if (slotLease.key !== key) {
                throw new UpdateCommandRecoveryPendingError(
                  "Update executor occupied slot changed.",
                );
              }
              return;
            }
            // Reserve the spelling before publication moves the symlink. A live
            // original owner cannot use this to acquire an unrelated installation.
            if (fs.realpathSync.native(key) !== installLease.key) {
              throw new UpdateCommandRecoveryPendingError(
                "Occupied slot does not resolve to its original installation.",
              );
            }
            const acquired = store.acquire(
              key,
              lease.owner,
              { kind: "update" },
              false,
              undefined,
              lease,
            );
            if (acquired.kind !== "acquired") {
              throw new UpdateCommandRecoveryPendingError(
                "Another update executor owns the occupied slot.",
              );
            }
            slotLease = acquired.lease;
            preflightReleases.delete(fence);
            assertCurrent();
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
              assertManagedUpdateCommandPlan(managedIssuer, enterOptions);
              const distinctServiceKey = resolveUpdateCommandRetainedRoot(
                enterOptions?.serviceRoot,
                key,
                Boolean(options?.existingAuthority),
              );
              if (lease) {
                assertManagedAdmission(managedIssuer, managed, admissionComplete);
                assertCurrent();
                identityWarnings.flush();
                if (
                  ((legacyTarget ?? lease).key !== key && slotLease?.key !== key) ||
                  serviceKey !== distinctServiceKey
                ) {
                  throw new UpdateCommandRecoveryPendingError(
                    "Update executor installation changed.",
                  );
                }
                if (!enterOptions?.preflight) {
                  preflightReleases.delete(fence);
                  reserveUpdateCommandExecutorSlot(fence, root);
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
                  options?.existingAuthority?.databasePath ??
                  directDatabasePath ??
                  (managedIssuer ? initialStores?.selection.handoff.databasePath : undefined) ??
                  resolveManagedUpdateLeaseDatabasePath();
                let existingIdentity =
                  options?.existingAuthority ??
                  initialStores?.selection.handoff ??
                  (options?.legacyPackageHandoff
                    ? captureManagedUpdateLeaseDatabaseIdentity(databasePath)
                    : undefined);
                initialStoreAdmission = initialStores
                  ? admitUpdateInitialStoreTransport(initialStores, {
                      installationRoot: key,
                      handoffPath: databasePath,
                      statePath: resolveOpenClawStateSqlitePath(),
                    })
                  : undefined;
                databasePath = existingIdentity?.databasePath ?? databasePath;
                store = createManagedHandoffLeaseStore({
                  databasePath,
                  serviceManagerEnv: resolveServiceManagerEnv(),
                  existingIdentity,
                  originalUpdateKey:
                    !options?.legacyManagedParent && !options?.legacyPackageParent
                      ? key
                      : undefined,
                  initialStoreAdmission,
                  onProcessIdentityWarning: identityWarnings.warn,
                });
                const found = store.read(key);
                if (found.kind === "unreadable" && !options?.legacyPackageParent) {
                  throw new UpdateCommandRecoveryPendingError(
                    "Update executor state is unreadable.",
                  );
                }
                assertManagedUpdateCommandRoot(managedIssuer, found, key);
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
                  const handoff = { root: key, runId, store };
                  const handedOff = await isCurrentManagedServiceUpdateHandoffProcess(handoff);
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
                  if (acquired.originalDatabaseIdentity) {
                    existingIdentity = acquired.originalDatabaseIdentity;
                    databasePath = existingIdentity.databasePath;
                    store = createManagedHandoffLeaseStore({
                      databasePath,
                      existingIdentity,
                      initialStoreAdmission,
                      serviceManagerEnv: resolveServiceManagerEnv(),
                      onProcessIdentityWarning: identityWarnings.warn,
                    });
                  }
                }
                serviceKey = distinctServiceKey;
                if (managedIssuer && (!managedHandoff || !initialStoreAdmission)) {
                  throw new UpdateCommandRecoveryPendingError(
                    "Managed generation requires initial bound-child admission.",
                  );
                }
                // Managed pair admission belongs to the helper issuer below, after
                // the actual read-only target plan has supplied its retained root.
                if (serviceKey && !managedIssuer) {
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
                  initialStoreAdmission,
                  onProcessIdentityWarning: identityWarnings.warn,
                });
                readConnections.retain(store);
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
                if (managedIssuer && initialStores) {
                  if (lease.version === 1) {
                    throw new UpdateCommandRecoveryPendingError(
                      "Managed generation cannot borrow legacy authority.",
                    );
                  }
                  managed = await admitManagedUpdateCommandGeneration({
                    issuer: managedIssuer,
                    input: {
                      runId,
                      lease,
                      retainedRoot: serviceKey ?? null,
                      database: authority,
                      initialStores,
                    },
                    assertNative: assertBase,
                    closeEffects: (cause) => {
                      generation?.closeAdmission();
                      children.close();
                      cancellationSignal.abort(cause);
                    },
                  });
                  if (serviceKey) {
                    serviceLease = readManagedUpdateCommandRetainedLease(store, serviceKey, lease);
                  }
                  assertCurrent();
                }
                admittedAuthorities.set(fence, {
                  authority,
                  assertCurrent: assertBase,
                  assertPublicationCurrent,
                  managedHandoff,
                  ...(initialStores
                    ? {
                        currentStores: () => {
                          assertCurrent();
                          initialStoreAdmission!.assertCurrent();
                          return initialStores!;
                        },
                      }
                    : {}),
                });
                admittedRunIds.set(fence, runId);
                const originalOwner =
                  !borrowed &&
                  !legacyParent &&
                  lease.version === 2 &&
                  !lease.key.includes("/.openclaw-update-child-");
                const generationStore = (admission?: typeof initialStoreAdmission) =>
                  readConnections.retain(
                    createManagedHandoffLeaseStore({
                      databasePath: authority.databasePath,
                      existingIdentity: authority,
                      initialStoreAdmission: admission,
                      serviceManagerEnv: resolveServiceManagerEnv(),
                      onProcessIdentityWarning: identityWarnings.warn,
                    }),
                  );
                if ((originalOwner || managed) && initialStoreAdmission) {
                  generation = registerUpdateCommandGenerationOwner({
                    fence,
                    runId,
                    authority,
                    assertCurrent,
                    assertPublicationCurrent,
                    initial: () => initialStoreAdmission!,
                    beforeRetire: managed?.beforeRetire.bind(managed),
                    retired: () => {
                      store = generationStore();
                      assertPublicationCurrent();
                    },
                    selected: async (admission, transition) => {
                      // Retain the verified guard for cleanup even if helper selection fails.
                      initialStoreAdmission = admission;
                      initialStores = Object.freeze({
                        protocol: "initial-pair-v1",
                        selection: admission.selection,
                      });
                      store = generationStore(admission);
                      if (managed) {
                        await managed.select(transition, initialStores);
                      }
                      assertPublicationCurrent();
                    },
                  });
                }
                if (originalOwner) {
                  originalFence = fence;
                  cancellation.register(fence);
                }
                if (serviceLease) {
                  retainedOwners.set(fence, serviceLease.key);
                }
                if (enterOptions?.preflight && !borrowed) {
                  preflightReleases.set(fence, () => {
                    assertCurrent();
                    if (!store || !lease || children.pending || slotLease) {
                      throw new UpdateCommandRecoveryPendingError(
                        "Preflight executor release failed.",
                      );
                    }
                    originalFence = undefined;
                    originalCancellations.delete(fence);
                    generation?.closeAdmission();
                    active = false;
                    children.close();
                    childOwners.delete(fence);
                    slotReservations.delete(fence);
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
                      throw new UpdateCommandRecoveryPendingError(
                        "Preflight executor release failed.",
                      );
                    }
                    lease = undefined;
                    readConnections[Symbol.dispose]();
                  });
                }
                if (!enterOptions?.preflight) {
                  reserveUpdateCommandExecutorSlot(fence, root);
                }
                if (enterOptions?.activationTimeoutMs !== undefined) {
                  activation.start(
                    new UpdateActivationTimeoutError(key, enterOptions.activationTimeoutMs),
                    enterOptions.activationTimeoutMs,
                  );
                }
                return fence;
              } catch (cause) {
                admissionComplete = admissionComplete && !managedIssuer;
                throw cause;
              } finally {
                entering = false;
              }
            },
          };
          let outcome = await runUpdateCommandExecutorOperation({
            operation: () => operation(executor),
            managed: () => managed,
            generation: () => generation,
            children,
            assertCurrent: () => {
              if (lease) {
                assertCurrent();
              }
              identityWarnings.flush();
            },
          });
          outcome = await finishManagedUpdateCommandGeneration(
            managed,
            outcome,
            initialStores,
            () => generation?.assertReady(),
          );
          outcome = managed ? await completeManagedUpdateCommandOutcome(managed, outcome) : outcome;
          outcome = cancellation.mergeOutcome(outcome);
          originalFence = undefined;
          originalCancellations.delete(fence);
          generation?.closeAdmission();
          active = false;
          preflightReleases.delete(fence);
          childOwners.delete(fence);
          slotReservations.delete(fence);
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
            if (
              serviceLease &&
              store &&
              !managed &&
              !cancellation.successor &&
              (serviceLease.version === 3 || !store.release(serviceLease))
            ) {
              throw new UpdateCommandRecoveryPendingError(
                "Managed service executor release could not be confirmed.",
              );
            }
            if (legacyTarget && store && !store.release(legacyTarget)) {
              throw new UpdateCommandRecoveryPendingError(
                "Active package generation has not settled.",
              );
            }
            if (legacyChild && store && !store.release(legacyChild)) {
              throw new UpdateCommandRecoveryPendingError("Legacy finalizer has not settled.");
            }
            if (
              lease &&
              store &&
              (lease.version === 3 ||
                (!borrowed && lease.version === 1) ||
                ((!borrowed || slotLease) &&
                  !(cancellation.successor
                    ? cancellation.successor.release(slotLease ? [slotLease] : [])
                    : options?.legacyPackageParent && !borrowed && lease.version !== 1
                      ? releaseLegacyPackageUpdateParent(store, lease, slotLease ? [slotLease] : [])
                      : store.releaseAll([
                          ...(!borrowed && lease.version !== 1 ? [lease] : []),
                          ...(slotLease ? [slotLease] : []),
                        ]))))
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
                  cause: new AggregateError(
                    [outcome.error, cause],
                    "Update executor cleanup failed",
                    {
                      cause: outcome.error,
                    },
                  ),
                },
              );
            }
            throw cause;
          }
          if ("error" in outcome) {
            throw outcome.error;
          }
          return outcome.result;
        }, operationSignal),
      );
    } finally {
      // The native operation, not its bounded deadline caller, owns this guard.
      // It must remain open through later cleanup when the callback ignores abort.
      initialStoreAdmission?.close();
    }
  });
}

export { withDelegatedUpdateCommandExecutor } from "./update-command-executor-delegated.js";
