import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { resolveServiceManagerEnv } from "../../daemon/service-process-env.js";
import { resolveUpdateInstallRoot } from "../../infra/update-install-root.js";
import {
  captureManagedUpdateLeaseDatabaseIdentity,
  type ManagedUpdateLeaseDatabaseIdentity,
} from "../../infra/update-managed-service-handoff-database.js";
import {
  createManagedHandoffLeaseStore,
  resolveManagedUpdateLeaseDatabasePath,
  type ManagedHandoffLease,
} from "../../infra/update-managed-service-handoff-lease.js";
import { isCurrentManagedServiceUpdateHandoffProcess } from "../../infra/update-managed-service-handoff.js";
import type { UpdateRecoveryFence } from "../../infra/update-run-recovery.js";
import { withCommandProcessScope } from "../../process/exec-spawn.js";
import { createUpdateActivationDeadline } from "./update-command-activation.js";
import {
  childLineageDigest,
  createChildOwner,
  type ChildOperation,
  type UpdateCommandChildGrant,
} from "./update-command-executor-children.js";
import { createUpdateIdentityWarningReporter } from "./update-command-identity-warning.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery.js";

/** A live invocation, never a serialized claim, PID or recovered history row. */
export type UpdateCommandExecutor = {
  /** Acquire only after read-only service admission, before the first mutable phase. */
  enter(
    root: string,
    options?: { preflight?: true; activationTimeoutMs?: number },
  ): Promise<UpdateRecoveryFence>;
};

type ManagedUpdateLeaseAuthority = ManagedUpdateLeaseDatabaseIdentity &
  Readonly<{ installKey: string; owner: string }>;
const admittedAuthorities = new WeakMap<UpdateRecoveryFence, ManagedUpdateLeaseAuthority>();

export function captureUpdateCommandExecutorAuthority(
  fence: UpdateRecoveryFence,
): ManagedUpdateLeaseAuthority {
  fence.assertCurrent();
  const authority = admittedAuthorities.get(fence);
  if (!authority) {
    throw new UpdateCommandRecoveryPendingError("Package recovery requires its admitted executor.");
  }
  return authority;
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
  <T>(root: string, operation: ChildOperation<T>) => Promise<T>
>();

export async function withUpdateCommandExecutorChild<T>(
  fence: UpdateRecoveryFence,
  root: string,
  operation: ChildOperation<T>,
): Promise<T> {
  const owner = childOwners.get(fence);
  if (!owner) {
    throw new UpdateCommandRecoveryPendingError("Child continuation requires its live executor.");
  }
  return await owner(root, operation);
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
  const activation = createUpdateActivationDeadline();
  return await activation.run(() =>
    withCommandProcessScope(async () => {
      const original = grant.originalParent ?? grant.parent;
      const spawner = grant.spawner ?? original;
      const childPrefix = `${original.key}/.openclaw-update-child-`;
      const childName = grant.childKey.slice(
        grant.childKey.lastIndexOf("/.openclaw-update-child-") + "/.openclaw-update-child-".length,
      );
      // v2026.9.4 sent this exact private-stdin format. Pin its existing database
      // before reading/admitting the live parent and registered receiver. Modern
      // names cannot downgrade by stripping their lineage or supplied physical pin.
      const legacyGrant =
        !grant.originalParent &&
        !grant.spawner &&
        !grant.originalChildKey &&
        !grant.databaseIdentity &&
        grant.childKey === `${grant.parent.key}/.openclaw-update-child-${childName}` &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(childName);
      const databaseIdentity = legacyGrant
        ? captureManagedUpdateLeaseDatabaseIdentity(grant.databasePath)
        : grant.databaseIdentity;
      const databasePath = databaseIdentity?.databasePath ?? grant.databasePath;
      const identityWarnings = createUpdateIdentityWarningReporter(runId);
      const store = createManagedHandoffLeaseStore({
        databasePath,
        serviceManagerEnv: resolveServiceManagerEnv(),
        existingIdentity: databaseIdentity,
        onProcessIdentityWarning: identityWarnings.warn,
      });
      const parent = store.read(resolveUpdateInstallRoot(root));
      const originalChild = store.read(grant.originalChildKey ?? grant.childKey);
      const child = store.read(grant.childKey);
      const lineageBound = Boolean(
        grant.originalParent &&
        grant.databaseIdentity &&
        grant.spawner &&
        grant.originalChildKey &&
        grant.originalChildKey === `${spawner.key}/.openclaw-update-child-${childName}` &&
        grant.childKey ===
          `${grant.parent.key === original.key ? spawner.key : grant.parent.key}/.openclaw-update-child-${childName}` &&
        /^[0-9a-f-]{36}-lineage-[0-9a-f]{64}$/.test(childName) &&
        childName.endsWith(
          `-lineage-${childLineageDigest(original, spawner, grant.parent, grant.databaseIdentity)}`,
        ),
      );
      if (
        (!lineageBound && !legacyGrant) ||
        (!legacyGrant && databasePath !== grant.databasePath) ||
        grant.runId !== runId ||
        grant.root !== resolveUpdateInstallRoot(root) ||
        parent.kind !== "current" ||
        !isDeepStrictEqual(parent.lease, grant.parent) ||
        parent.lease.action.kind !== "update" ||
        parent.lease.version === 3 ||
        !store.current(original) ||
        original.action.kind !== "update" ||
        original.version === 3 ||
        !store.current(spawner) ||
        spawner.action.kind !== "update" ||
        spawner.version === 3 ||
        (spawner.key !== original.key &&
          (!spawner.key.startsWith(childPrefix) || spawner.owner !== runId)) ||
        process.ppid !== spawner.executor.pid ||
        !(grant.originalChildKey ?? grant.childKey).startsWith(
          `${spawner.key}/.openclaw-update-child-`,
        ) ||
        !grant.childKey.startsWith(`${parent.lease.key}/.openclaw-update-child-`) ||
        originalChild.kind !== "current" ||
        originalChild.lease.owner !== runId ||
        originalChild.lease.action.kind !== "update" ||
        originalChild.lease.version === 3 ||
        !isDeepStrictEqual(originalChild.lease.helper, spawner.executor) ||
        child.kind !== "current" ||
        child.lease.owner !== runId ||
        child.lease.action.kind !== "update" ||
        child.lease.version === 3 ||
        !isDeepStrictEqual(child.lease.helper, spawner.executor)
      ) {
        throw new UpdateCommandRecoveryPendingError(
          "The update process does not match its parent.",
        );
      }
      let active = true;
      const isLive = (identity: ManagedHandoffLease["executor"]) =>
        store.isProcessIdentityCurrent(identity);
      if (
        !store.acceptParentBoundExecutor(originalChild.lease) ||
        !store.acceptParentBoundExecutor(child.lease)
      ) {
        throw new UpdateCommandRecoveryPendingError(
          "The update process no longer has permission to continue.",
        );
      }
      const assertBase = () => {
        activation.assertCurrent();
        if (
          !active ||
          !store.current(original) ||
          !isLive(original.helper) ||
          !isLive(original.executor) ||
          !store.current(parent.lease) ||
          !isLive(parent.lease.helper) ||
          !isLive(parent.lease.executor) ||
          !store.current(spawner) ||
          !isLive(spawner.helper) ||
          !isLive(spawner.executor) ||
          !store.owns(originalChild.lease, "executor") ||
          !store.owns(child.lease, "executor")
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
          parent: parent.lease,
          original,
          spawner: originalChild.lease,
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
      childOwners.set(fence, (childRoot, childOperation) => owner.run(childRoot, childOperation));
      let outcome: { result: T } | { error: unknown };
      try {
        fence.assertCurrent();
        if (databaseIdentity) {
          admittedAuthorities.set(
            fence,
            Object.freeze({
              ...databaseIdentity,
              installKey: original.key,
              owner: original.owner,
            }),
          );
        }
        if (options) {
          activation.start(root, options.activationTimeoutMs);
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
      } finally {
        active = false;
        childOwners.delete(fence);
        admittedAuthorities.delete(fence);
      }
      if ("error" in outcome) {
        throw outcome.error;
      }
      return outcome.result;
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
      }
    | {
        existingAuthority?: never;
        legacyManagedParent: { runId: string; handoffId: string; root: string };
      },
): Promise<T> {
  const activation = createUpdateActivationDeadline();
  return await activation.run(() =>
    withCommandProcessScope(async () => {
      let active = true;
      let entering = false;
      let databasePath: string | undefined;
      let store: ReturnType<typeof createManagedHandoffLeaseStore> | undefined;
      let lease: ManagedHandoffLease | undefined;
      let borrowed = false;
      let legacyChild: ManagedHandoffLease | undefined;
      const identityWarnings = createUpdateIdentityWarningReporter(runId);
      const assertBase = () => {
        activation.assertCurrent();
        if (
          !active ||
          !store ||
          !lease ||
          (legacyChild
            ? !store.current(lease) ||
              lease.executor.pid !== process.ppid ||
              !store.isProcessIdentityCurrent(lease.helper) ||
              !store.isProcessIdentityCurrent(lease.executor) ||
              !store.owns(legacyChild, "executor")
            : !store.owns(lease, "executor"))
        ) {
          throw new UpdateCommandRecoveryPendingError(
            "Update executor ownership is no longer current.",
          );
        }
      };
      const assertCurrent = () => {
        assertBase();
        if (lease?.version === 3) {
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
        onStart: () => preflightReleases.delete(fence),
        binding: () => {
          if (!store || !lease || !databasePath) {
            throw new UpdateCommandRecoveryPendingError("Child executor admission is closed.");
          }
          return {
            store,
            parent: lease,
            original: lease,
            spawner: legacyChild ?? lease,
            databasePath,
            databaseIdentity: admittedAuthorities.get(fence),
          };
        },
      });
      activation.signal.addEventListener("abort", () => children.close(), { once: true });
      childOwners.set(fence, (root, childOperation) => {
        assertCurrent();
        return children.run(root, childOperation);
      });
      const executor: UpdateCommandExecutor = {
        async enter(root, enterOptions) {
          activation.assertCurrent();
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
          if (lease) {
            assertCurrent();
            identityWarnings.flush();
            if (lease.key !== key) {
              throw new UpdateCommandRecoveryPendingError("Update executor installation changed.");
            }
            if (!enterOptions?.preflight) {
              preflightReleases.delete(fence);
            }
            if (enterOptions?.activationTimeoutMs !== undefined) {
              activation.start(key, enterOptions.activationTimeoutMs);
            }
            return fence;
          }
          entering = true;
          try {
            databasePath =
              options?.existingAuthority?.databasePath ?? resolveManagedUpdateLeaseDatabasePath();
            store = createManagedHandoffLeaseStore({
              databasePath,
              serviceManagerEnv: resolveServiceManagerEnv(),
              existingIdentity: options?.existingAuthority,
              onProcessIdentityWarning: identityWarnings.warn,
            });
            const found = store.read(key);
            if (found.kind === "unreadable") {
              throw new UpdateCommandRecoveryPendingError("Update executor state is unreadable.");
            }
            if (options?.legacyManagedParent) {
              const parent = options.legacyManagedParent;
              if (
                found.kind !== "current" ||
                parent.runId !== runId ||
                parent.root !== key ||
                found.lease.owner !== parent.handoffId ||
                found.lease.version !== 2 ||
                found.lease.action.kind !== "update" ||
                found.lease.executor.pid !== process.ppid ||
                !store.isProcessIdentityCurrent(found.lease.helper) ||
                !store.isProcessIdentityCurrent(found.lease.executor) ||
                store.hasUnsettledChildren(found.lease)
              ) {
                throw new UpdateCommandRecoveryPendingError(
                  "Legacy finalizer does not match its live managed parent.",
                );
              }
              lease = found.lease;
              borrowed = true;
              const child = store.acquire(`${key}/.openclaw-update-child-${randomUUID()}`, runId, {
                kind: "update",
              });
              if (child.kind !== "acquired") {
                throw new UpdateCommandRecoveryPendingError(
                  "Legacy finalizer lifetime could not be acquired.",
                );
              }
              legacyChild = child.lease;
            } else if (
              found.kind === "current" &&
              !options?.existingAuthority &&
              found.lease.helper.pid !== process.pid &&
              found.lease.executor.pid === process.pid
            ) {
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
            } else {
              const acquired = store.acquire(key, randomUUID(), { kind: "update" });
              if (acquired.kind !== "acquired") {
                throw new UpdateCommandRecoveryPendingError(
                  "Another update executor owns this installation.",
                );
              }
              lease = acquired.lease;
            }
            assertCurrent();
            const authority = Object.freeze({
              ...(options?.existingAuthority ??
                captureManagedUpdateLeaseDatabaseIdentity(databasePath)),
              installKey: key,
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
              !store.owns(lease, "executor") &&
              !(process.connected && store.acceptParentBoundExecutor(lease))
            ) {
              throw new UpdateCommandRecoveryPendingError(
                "Managed update executor changed during admission.",
              );
            }
            assertCurrent();
            admittedAuthorities.set(fence, authority);
            if (enterOptions?.preflight && !borrowed) {
              preflightReleases.set(fence, () => {
                assertCurrent();
                if (!store || !lease || children.pending || !store.release(lease)) {
                  throw new UpdateCommandRecoveryPendingError("Preflight executor release failed.");
                }
                // Never reactivate this fence; the supervised helper must acquire its own.
                active = false;
                lease = undefined;
                children.close();
                childOwners.delete(fence);
                admittedAuthorities.delete(fence);
                preflightReleases.delete(fence);
              });
            }
            if (enterOptions?.activationTimeoutMs !== undefined) {
              activation.start(key, enterOptions.activationTimeoutMs);
            }
            return fence;
          } finally {
            entering = false;
          }
        },
      };
      let outcome: { result: T } | { error: Error };
      try {
        const result = await operation(executor);
        children.close();
        await children.settle();
        if (lease) {
          assertCurrent();
        }
        identityWarnings.flush();
        outcome = { result };
      } catch (cause) {
        outcome = {
          error: cause instanceof Error ? cause : new Error("Update execution failed", { cause }),
        };
      }
      children.close();
      try {
        await children.settle();
      } catch (cause) {
        outcome = {
          error:
            "error" in outcome && outcome.error !== cause
              ? new AggregateError([outcome.error, cause], "Update cleanup failed", {
                  cause,
                })
              : cause instanceof Error
                ? cause
                : new Error("Update settlement failed", { cause }),
        };
      }
      active = false;
      preflightReleases.delete(fence);
      childOwners.delete(fence);
      admittedAuthorities.delete(fence);
      try {
        if (legacyChild && store && !store.release(legacyChild)) {
          throw new UpdateCommandRecoveryPendingError("Legacy finalizer has not settled.");
        }
        if (lease && store && (lease.version === 3 || (!borrowed && !store.release(lease)))) {
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
