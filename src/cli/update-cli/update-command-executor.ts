import { randomUUID } from "node:crypto";
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
import {
  childLineageDigest,
  resolveUpdateCommandChildBinding,
  type UpdateCommandChildGrant,
} from "./update-command-executor-grant.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery.js";

export type { UpdateCommandChildGrant } from "./update-command-executor-grant.js";

/** A live invocation, never a serialized claim, PID or recovered history row. */
export type UpdateCommandExecutor = {
  /** Acquire only after read-only service admission, before the first mutable phase. */
  enter(
    root: string,
    options?: { preflight?: true; serviceRoot?: string },
  ): Promise<UpdateRecoveryFence>;
};

type ManagedUpdateLeaseAuthority = ManagedUpdateLeaseDatabaseIdentity &
  Readonly<{ installKey: string; owner: string }>;
const admittedAuthorities = new WeakMap<UpdateRecoveryFence, ManagedUpdateLeaseAuthority>();
const retainedOwners = new WeakSet<UpdateRecoveryFence>();

/** Compatibility requirement from a live admission, never a serialized claim. */
export function requiresRetainedUpdateCommandOwner(fence: UpdateRecoveryFence): boolean {
  captureUpdateCommandExecutorAuthority(fence);
  return retainedOwners.has(fence);
}

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

type ChildPurpose = { auxiliaryPreflight?: true };
type ChildOperation<T> = (
  grant: UpdateCommandChildGrant,
  bindChild: (pid: number) => void,
) => Promise<T>;
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

/** One child interval, shared by direct and delegated executors. */
function createChildOwner(params: {
  runId: string;
  binding: () => {
    store: ReturnType<typeof createManagedHandoffLeaseStore>;
    parent: ManagedHandoffLease;
    original: ManagedHandoffLease;
    spawner: ManagedHandoffLease;
    /** A cross-root updater retains its original service owner through every child. */
    retainedParent?: ManagedHandoffLease;
    databasePath: string;
    databaseIdentity?: ManagedUpdateLeaseDatabaseIdentity;
  };
  assertBase: () => void;
  onStart?: (purpose?: ChildPurpose) => void;
}) {
  let admissionOpen = true;
  let delegating = false;
  let pending: Promise<unknown> | undefined;
  let failure: Error | undefined;
  const assertIdle = () => {
    if (delegating) {
      throw new UpdateCommandRecoveryPendingError(
        "Parent executor is suspended for its candidate.",
      );
    }
  };
  return {
    assertIdle,
    get pending() {
      return pending;
    },
    close() {
      admissionOpen = false;
    },
    async settle() {
      await pending;
      if (failure) {
        throw failure;
      }
    },
    run<T>(root: string, operation: ChildOperation<T>, purpose?: ChildPurpose): Promise<T> {
      params.assertBase();
      assertIdle();
      if (!admissionOpen) {
        throw new UpdateCommandRecoveryPendingError("Child executor admission is closed.");
      }
      const { store, parent, original, spawner, retainedParent, databasePath, databaseIdentity } =
        params.binding();
      if (!databaseIdentity) {
        throw new UpdateCommandRecoveryPendingError(
          "Native child requires its pinned lease database.",
        );
      }
      params.onStart?.(purpose);
      const candidateRoot = resolveUpdateInstallRoot(root);
      let candidateParent = parent;
      let acquiredParent = false;
      const children: ManagedHandoffLease[] = [];
      let bound = false;
      delegating = true;
      const assertOwners = () => {
        params.assertBase();
        if (
          !store.current(candidateParent) ||
          resolveUpdateInstallRoot(root) !== candidateParent.key
        ) {
          throw new UpdateCommandRecoveryPendingError("Candidate installation ownership changed.");
        }
      };
      const running = async () => {
        let outcome: { result: T } | { error: unknown };
        try {
          params.assertBase();
          if (candidateRoot === original.key) {
            candidateParent = original;
          } else if (retainedParent && candidateRoot === retainedParent.key) {
            candidateParent = retainedParent;
          } else if (candidateRoot !== parent.key) {
            const acquired = store.acquire(candidateRoot, randomUUID(), { kind: "update" });
            if (acquired.kind !== "acquired") {
              throw new UpdateCommandRecoveryPendingError(
                "Another update executor owns the candidate installation.",
              );
            }
            candidateParent = acquired.lease;
            acquiredParent = true;
          }
          assertOwners();
          // Keep the full original spawner lineage AND the active generation.
          // Neither root may be reclaimed while a nested process group survives.
          const parents = [
            ...new Map(
              [
                spawner,
                ...(retainedParent ? [retainedParent] : []),
                ...(candidateParent.key === original.key ? [] : [candidateParent]),
              ].map((owner) => [owner.key, owner]),
            ).values(),
          ];
          const candidateChildIndex =
            candidateParent.key === original.key
              ? 0
              : parents.findIndex((owner) => owner.key === candidateParent.key);
          const childName = `${randomUUID()}-lineage-${childLineageDigest(original, spawner, candidateParent, databaseIdentity, retainedParent)}`;
          for (const childParent of parents) {
            const acquired = store.acquire(
              `${childParent.key}/.openclaw-update-child-${childName}`,
              params.runId,
              { kind: "update" },
            );
            if (acquired.kind !== "acquired") {
              throw new UpdateCommandRecoveryPendingError(
                "Candidate lifetime could not be acquired.",
              );
            }
            children.push(acquired.lease);
          }
          const grant: UpdateCommandChildGrant = {
            runId: params.runId,
            root: candidateParent.key,
            databasePath,
            parent: candidateParent,
            originalParent: original,
            spawner,
            originalChildKey: children[0]!.key,
            childKey: children[candidateChildIndex]!.key,
            databaseIdentity,
            ...(retainedParent
              ? {
                  retainedParent,
                  retainedChildKey:
                    children[parents.findIndex((owner) => owner.key === retainedParent.key)]!.key,
                }
              : {}),
          };
          const result = await operation(grant, (pid) => {
            assertOwners();
            if (bound || pid === process.pid) {
              throw new UpdateCommandRecoveryPendingError(
                "Candidate process can be bound only once.",
              );
            }
            for (let index = 0; index < children.length; index++) {
              const assigned = store.bind(children[index]!, pid);
              if (!assigned) {
                throw new UpdateCommandRecoveryPendingError("Candidate process binding failed.");
              }
              children[index] = assigned;
            }
            bound = true;
          });
          if (!bound) {
            throw new UpdateCommandRecoveryPendingError(
              "Candidate continuation did not bind a process.",
            );
          }
          assertOwners();
          outcome = { result };
        } catch (error) {
          outcome = { error };
        }
        try {
          // Release the active generation before the original lineage, as in
          // the shipped finalizer. A failed release never reactivates the parent.
          for (let index = children.length - 1; index > 0; index--) {
            if (!store.release(children[index]!)) {
              throw new UpdateCommandRecoveryPendingError("Candidate executor has not settled.");
            }
          }
          if (acquiredParent && !store.release(candidateParent)) {
            throw new UpdateCommandRecoveryPendingError("Candidate installation release failed.");
          }
          if (children.length > 0 && !store.release(children[0]!)) {
            throw new UpdateCommandRecoveryPendingError("Candidate executor has not settled.");
          }
          delegating = false;
        } catch (cause) {
          if ("error" in outcome) {
            throw new AggregateError(
              [outcome.error, cause],
              "Candidate and its executor cleanup failed",
              { cause },
            );
          }
          throw cause;
        }
        if ("error" in outcome) {
          throw outcome.error;
        }
        return outcome.result;
      };
      const work = Promise.resolve().then(running);
      pending = work;
      void work
        .catch((cause: unknown) => {
          failure = cause instanceof Error ? cause : new Error("Candidate failed", { cause });
        })
        .finally(() => {
          if (pending === work) {
            pending = undefined;
          }
        });
      return work;
    },
  };
}

/** A delegated executor retains both its original root and immediate spawner.
 * Neither the transported grant nor a lease row without live identity grants effects. */
export async function withDelegatedUpdateCommandExecutor<T>(
  grant: UpdateCommandChildGrant,
  runId: string,
  root: string,
  operation: (fence: UpdateRecoveryFence) => Promise<T>,
): Promise<T> {
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
  } = resolveUpdateCommandChildBinding(grant, runId, root);
  let active = true;
  const isLive = (identity: ManagedHandoffLease["executor"]) =>
    store.isPidAlive(identity.pid) &&
    store.readProcessStartIdentity(identity.pid) === identity.startIdentity;
  const assertBase = () => {
    if (
      !active ||
      !store.current(original) ||
      !isLive(original.helper) ||
      !isLive(original.executor) ||
      !store.current(parent) ||
      !isLive(parent.helper) ||
      !isLive(parent.executor) ||
      !store.current(spawner) ||
      !isLive(spawner.helper) ||
      !isLive(spawner.executor) ||
      !store.owns(originalChild, "executor") ||
      !store.owns(child, "executor") ||
      (retained &&
        (!retainedChild ||
          !store.current(retained) ||
          !isLive(retained.helper) ||
          !isLive(retained.executor) ||
          !store.owns(retainedChild, "executor")))
    ) {
      throw new UpdateCommandRecoveryPendingError(
        "Candidate executor ownership is no longer current.",
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
  const fence = {
    assertCurrent() {
      assertBase();
      owner.assertIdle();
    },
  };
  childOwners.set(fence, (childRoot, childOperation, purpose) =>
    owner.run(childRoot, childOperation, purpose),
  );
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
    if (retained) {
      retainedOwners.add(fence);
    }
    outcome = { result: await operation(fence) };
  } catch (error) {
    outcome = { error };
  }
  owner.close();
  try {
    await owner.settle();
    fence.assertCurrent();
  } catch (cause) {
    outcome = {
      error:
        "error" in outcome && outcome.error !== cause
          ? new AggregateError(
              [outcome.error, cause],
              "Candidate and descendant settlement failed",
              { cause },
            )
          : cause,
    };
  } finally {
    active = false;
    childOwners.delete(fence);
    admittedAuthorities.delete(fence);
    retainedOwners.delete(fence);
  }
  if ("error" in outcome) {
    throw outcome.error;
  }
  return outcome.result;
}

/**
 * Reuse the native handoff owner for direct invocations too. Its database is
 * outside the canonical state family, so checking this fence never opens a
 * displaced/migrated source. Physical source exclusion remains a separate duty.
 */
export async function withUpdateCommandExecutor<T>(
  runId: string,
  operation: (executor: UpdateCommandExecutor) => Promise<T>,
  options?: { existingAuthority: Omit<ManagedUpdateLeaseAuthority, "owner"> },
): Promise<T> {
  let active = true;
  let entering = false;
  let databasePath: string | undefined;
  let store: ReturnType<typeof createManagedHandoffLeaseStore> | undefined;
  let lease: ManagedHandoffLease | undefined;
  let borrowed = false;
  let serviceLease: ManagedHandoffLease | undefined;
  let serviceKey: string | undefined;
  let admissionComplete = false;
  const assertBase = () => {
    if (
      !active ||
      !admissionComplete ||
      !store ||
      !lease ||
      !store.owns(lease, "executor") ||
      (serviceLease && !store.owns(serviceLease, "executor"))
    ) {
      throw new UpdateCommandRecoveryPendingError(
        "Update executor ownership is no longer current.",
      );
    }
  };
  const assertCurrent = () => {
    assertBase();
    if (lease?.version === 3 || serviceLease?.version === 3) {
      throw new UpdateCommandRecoveryPendingError("Parent executor has unresolved native custody.");
    }
    children.assertIdle();
  };
  const fence = { assertCurrent };
  const children = createChildOwner({
    runId,
    assertBase,
    onStart: (purpose) => {
      // Preserve only an existing eligibility entry. Nothing can re-arm it.
      if (!purpose?.auxiliaryPreflight) {
        preflightReleases.delete(fence);
      }
    },
    binding: () => {
      if (!store || !lease || !databasePath) {
        throw new UpdateCommandRecoveryPendingError("Child executor admission is closed.");
      }
      return {
        store,
        parent: lease,
        original: lease,
        spawner: lease,
        ...(serviceLease ? { retainedParent: serviceLease } : {}),
        databasePath,
        databaseIdentity: admittedAuthorities.get(fence),
      };
    },
  });
  childOwners.set(fence, async (root, childOperation, purpose) => {
    try {
      assertCurrent();
      return await children.run(root, childOperation, purpose);
    } catch (error) {
      // Failure revokes eligibility before a catching caller can attempt handoff.
      preflightReleases.delete(fence);
      throw error;
    }
  });
  const executor: UpdateCommandExecutor = {
    async enter(root, enterOptions) {
      if (!active || entering) {
        throw new UpdateCommandRecoveryPendingError("Update executor admission is closed or busy.");
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
        throw new UpdateCommandRecoveryPendingError("Recovery cannot acquire a new service root.");
      }
      if (lease) {
        assertCurrent();
        if (lease.key !== key || serviceKey !== distinctServiceKey) {
          throw new UpdateCommandRecoveryPendingError("Update executor installation changed.");
        }
        if (!enterOptions?.preflight) {
          preflightReleases.delete(fence);
        }
        return fence;
      }
      entering = true;
      try {
        databasePath =
          options?.existingAuthority.databasePath ?? resolveManagedUpdateLeaseDatabasePath();
        store = createManagedHandoffLeaseStore({
          databasePath,
          serviceManagerEnv: resolveServiceManagerEnv(),
          existingIdentity: options?.existingAuthority,
        });
        const found = store.read(key);
        if (found.kind === "unreadable") {
          throw new UpdateCommandRecoveryPendingError("Update executor state is unreadable.");
        }
        if (
          found.kind === "current" &&
          !options?.existingAuthority &&
          found.lease.helper.pid !== process.pid &&
          found.lease.executor.pid === process.pid
        ) {
          const handedOff = await isCurrentManagedServiceUpdateHandoffProcess({ root: key, runId });
          // Retain the exact row observed before the await. Matching the run in
          // a later metadata read cannot authorize a different lease generation.
          if (
            !active ||
            !handedOff ||
            found.lease.action.kind !== "update" ||
            !store.owns(found.lease, "executor")
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
        });
        assertCurrent();
        admittedAuthorities.set(fence, authority);
        if (serviceLease) {
          retainedOwners.add(fence);
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
            if (!store.release(lease)) {
              throw new UpdateCommandRecoveryPendingError("Preflight executor release failed.");
            }
            // The supervised helper must acquire its own owners.
            lease = undefined;
          });
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
          ? new AggregateError([outcome.error, cause], "Update and candidate settlement failed", {
              cause,
            })
          : cause instanceof Error
            ? cause
            : new Error("Candidate settlement failed", { cause }),
    };
  }
  active = false;
  preflightReleases.delete(fence);
  childOwners.delete(fence);
  admittedAuthorities.delete(fence);
  retainedOwners.delete(fence);
  try {
    if (serviceLease && store && (serviceLease.version === 3 || !store.release(serviceLease))) {
      throw new UpdateCommandRecoveryPendingError(
        "Managed service executor release could not be confirmed.",
      );
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
}
