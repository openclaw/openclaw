import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
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
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery.js";

/** A live invocation, never a serialized claim, PID or recovered history row. */
export type UpdateCommandExecutor = {
  /** Acquire only after read-only service admission, before the first mutable phase. */
  enter(root: string, options?: { preflight?: true }): Promise<UpdateRecoveryFence>;
};

export type ManagedUpdateLeaseAuthority = ManagedUpdateLeaseDatabaseIdentity &
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

const slotReservations = new WeakMap<UpdateRecoveryFence, (root: string) => void>();
/** Reserve a prospective occupied package slot without replacing its original domain. */
export function reserveUpdateCommandExecutorSlot(fence: UpdateRecoveryFence, root: string): void {
  const reserve = slotReservations.get(fence);
  if (!reserve) {
    throw new UpdateCommandRecoveryPendingError("Slot reservation requires its live executor.");
  }
  reserve(root);
}

/** Private correlation sent only to the spawned candidate's inherited pipe. The receiver
 * independently reads both live owners and checks its own PID/start identity. */
export type UpdateCommandChildGrant = {
  runId: string;
  root: string;
  databasePath: string;
  parent: ManagedHandoffLease;
  /** Exact immediate spawner; parent always remains the original realpath lease. */
  spawner?: ManagedHandoffLease;
  /** Same-store prospective slot coverage, retained alongside the original domain. */
  slot?: { parent: ManagedHandoffLease; spawner: ManagedHandoffLease; childKey: string };
  childKey: string;
  databaseIdentity?: ManagedUpdateLeaseDatabaseIdentity;
};
export type UpdateCommandChildBinding = (
  pid: number,
  onBound?: (identity: Readonly<ManagedHandoffLease["executor"]>) => undefined,
) => void;
type ChildOperation<T> = (
  grant: UpdateCommandChildGrant,
  bindChild: UpdateCommandChildBinding,
) => Promise<T>;
const childOwners = new WeakMap<
  UpdateRecoveryFence,
  <T>(operation: ChildOperation<T>) => Promise<T>
>();

export async function withUpdateCommandExecutorChild<T>(
  fence: UpdateRecoveryFence,
  operation: ChildOperation<T>,
): Promise<T> {
  const owner = childOwners.get(fence);
  if (!owner) {
    throw new UpdateCommandRecoveryPendingError("Child continuation requires its live executor.");
  }
  return await owner(operation);
}

/** One child interval, shared by direct and delegated executors. */
function createChildOwner(params: {
  runId: string;
  binding: () => {
    store: ReturnType<typeof createManagedHandoffLeaseStore>;
    parent: ManagedHandoffLease;
    spawner: ManagedHandoffLease;
    databasePath: string;
    databaseIdentity?: ManagedUpdateLeaseDatabaseIdentity;
    slot?: { parent: ManagedHandoffLease; spawner: ManagedHandoffLease };
  };
  assertBase: () => void;
  onStart?: () => void;
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
    get unsettled() {
      return delegating;
    },
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
    run<T>(operation: ChildOperation<T>): Promise<T> {
      params.assertBase();
      assertIdle();
      if (!admissionOpen) {
        throw new UpdateCommandRecoveryPendingError("Child executor admission is closed.");
      }
      const { store, parent, spawner, databasePath, databaseIdentity, slot } = params.binding();
      params.onStart?.();
      // Nested keys remain under the root and their immediate spawner, so
      // neither can release/reactivate while a deeper descendant survives.
      const acquired = store.acquire(
        `${spawner.key}/.openclaw-update-child-${randomUUID()}`,
        params.runId,
        { kind: "update" },
      );
      if (acquired.kind !== "acquired") {
        throw new UpdateCommandRecoveryPendingError("Candidate lifetime could not be acquired.");
      }
      let childLeases = [acquired.lease];
      let slotGrant: UpdateCommandChildGrant["slot"];
      try {
        if (slot) {
          const paired = store.acquire(
            `${slot.spawner.key}/.openclaw-update-child-${randomUUID()}`,
            params.runId,
            { kind: "update" },
          );
          if (paired.kind !== "acquired") {
            throw new UpdateCommandRecoveryPendingError(
              "Candidate slot lifetime could not be acquired.",
            );
          }
          childLeases.push(paired.lease);
          slotGrant = { ...slot, childKey: paired.lease.key };
        }
      } catch (error) {
        try {
          if (!store.releaseAll(childLeases)) {
            throw new UpdateCommandRecoveryPendingError("Candidate reservation did not settle");
          }
        } catch (cause) {
          delegating = true;
          throw new AggregateError([error, cause], "Candidate reservation and settlement failed", {
            cause,
          });
        }
        throw error;
      }
      let bound = false;
      let bindingAttempted = false;
      delegating = true;
      const grant: UpdateCommandChildGrant = {
        runId: params.runId,
        root: parent.key,
        databasePath,
        databaseIdentity,
        parent,
        spawner,
        childKey: acquired.lease.key,
        ...(slotGrant ? { slot: slotGrant } : {}),
      };
      const running = async () => {
        let outcome: { result: T } | { error: unknown };
        try {
          const result = await operation(grant, (pid, onBound) => {
            params.assertBase();
            if (bindingAttempted || pid === process.pid) {
              throw new UpdateCommandRecoveryPendingError(
                "Candidate process can be bound only once.",
              );
            }
            bindingAttempted = true;
            const assigned = store.bindUpdateChildren(childLeases, pid);
            const assignedChild = assigned?.[0];
            if (!assigned || !assignedChild) {
              throw new UpdateCommandRecoveryPendingError("Candidate process binding failed.");
            }
            childLeases = assigned;
            bound = true;
            if (isPromiseLike(onBound?.(Object.freeze({ ...assignedChild.executor })))) {
              throw new TypeError("Candidate binding observation must be synchronous.");
            }
            params.assertBase();
            if (childLeases.some((lease) => !store.current(lease))) {
              throw new UpdateCommandRecoveryPendingError("Candidate process binding changed.");
            }
          });
          if (!bound) {
            throw new UpdateCommandRecoveryPendingError(
              "Candidate continuation did not bind a process.",
            );
          }
          params.assertBase();
          outcome = { result };
        } catch (error) {
          outcome = { error };
        }
        try {
          // A lease row is not a join receipt. This also refuses a surviving
          // process group after its bound leader exits.
          if (!store.releaseAll(childLeases)) {
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
  const store = createManagedHandoffLeaseStore({
    databasePath: grant.databasePath,
    serviceManagerEnv: resolveServiceManagerEnv(),
    existingIdentity: grant.databaseIdentity,
  });
  // The receiver root is independently resolved. A grant only correlates exact
  // rows; it cannot redirect admission to a different original domain.
  const receiverRoot = resolveUpdateInstallRoot(root);
  const parent = store.read(grant.root);
  const spawner = grant.spawner ?? grant.parent;
  const child = store.read(grant.childKey);
  const childPrefix = `${grant.root}/.openclaw-update-child-`;
  if (
    grant.runId !== runId ||
    (receiverRoot !== grant.root && receiverRoot !== grant.slot?.parent.key) ||
    path.resolve(grant.root) !== grant.root ||
    parent.kind !== "current" ||
    !isDeepStrictEqual(parent.lease, grant.parent) ||
    parent.lease.action.kind !== "update" ||
    parent.lease.version === 3 ||
    !store.current(spawner) ||
    spawner.action.kind !== "update" ||
    spawner.version === 3 ||
    (spawner.key !== parent.lease.key &&
      (!spawner.key.startsWith(childPrefix) || spawner.owner !== runId)) ||
    process.ppid !== spawner.executor.pid ||
    !grant.childKey.startsWith(`${spawner.key}/.openclaw-update-child-`) ||
    child.kind !== "current" ||
    child.lease.owner !== runId ||
    child.lease.action.kind !== "update" ||
    child.lease.version === 3 ||
    !isDeepStrictEqual(child.lease.helper, spawner.executor)
  ) {
    throw new UpdateCommandRecoveryPendingError(
      "Candidate executor binding does not match its parent.",
    );
  }
  const slot = grant.slot;
  const slotChild = slot ? store.read(slot.childKey) : undefined;
  if (
    slot &&
    (slot.parent.key === parent.lease.key ||
      path.resolve(slot.parent.key) !== slot.parent.key ||
      !store.current(slot.parent) ||
      slot.parent.version !== 2 ||
      slot.parent.action.kind !== "update" ||
      slot.parent.owner !== parent.lease.owner ||
      !isDeepStrictEqual(slot.parent.helper, parent.lease.executor) ||
      !isDeepStrictEqual(slot.parent.executor, parent.lease.executor) ||
      !store.current(slot.spawner) ||
      slot.spawner.version !== 2 ||
      slot.spawner.action.kind !== "update" ||
      !isDeepStrictEqual(slot.spawner.executor, spawner.executor) ||
      (slot.spawner.key !== slot.parent.key &&
        (!slot.spawner.key.startsWith(`${slot.parent.key}/.openclaw-update-child-`) ||
          slot.spawner.owner !== runId)) ||
      !slot.childKey.startsWith(`${slot.spawner.key}/.openclaw-update-child-`) ||
      slotChild?.kind !== "current" ||
      slotChild.lease.version !== 2 ||
      slotChild.lease.action.kind !== "update" ||
      slotChild.lease.owner !== runId ||
      !isDeepStrictEqual(slotChild.lease.helper, slot.spawner.executor) ||
      !isDeepStrictEqual(slotChild.lease.executor, child.lease.executor))
  ) {
    throw new UpdateCommandRecoveryPendingError(
      "Candidate slot binding does not match its parent.",
    );
  }
  const coveredChild = slotChild?.kind === "current" ? slotChild.lease : undefined;
  let active = true;
  const isLive = (identity: ManagedHandoffLease["executor"]) =>
    store.isPidAlive(identity.pid) &&
    store.readProcessStartIdentity(identity.pid) === identity.startIdentity;
  const assertBase = () => {
    if (
      !active ||
      !store.current(parent.lease) ||
      !isLive(parent.lease.helper) ||
      !isLive(parent.lease.executor) ||
      !store.current(spawner) ||
      !isLive(spawner.helper) ||
      !isLive(spawner.executor) ||
      !store.owns(child.lease, "executor") ||
      (slot &&
        (!store.current(slot.parent) ||
          !store.current(slot.spawner) ||
          !isLive(slot.parent.helper) ||
          !isLive(slot.parent.executor) ||
          !isLive(slot.spawner.helper) ||
          !isLive(slot.spawner.executor) ||
          !coveredChild ||
          !store.owns(coveredChild, "executor")))
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
      parent: parent.lease,
      spawner: child.lease,
      databasePath: grant.databasePath,
      databaseIdentity: grant.databaseIdentity,
      ...(slot && coveredChild ? { slot: { parent: slot.parent, spawner: coveredChild } } : {}),
    }),
    assertBase,
  });
  const fence = {
    assertCurrent() {
      assertBase();
      owner.assertIdle();
    },
  };
  childOwners.set(fence, (childOperation) => owner.run(childOperation));
  slotReservations.set(fence, (slotRoot) => {
    fence.assertCurrent();
    const absolute = path.resolve(slotRoot);
    const key = path.join(fs.realpathSync.native(path.dirname(absolute)), path.basename(absolute));
    if (key !== parent.lease.key && key !== slot?.parent.key) {
      throw new UpdateCommandRecoveryPendingError(
        "Candidate cannot reserve an ungranted installation slot.",
      );
    }
  });
  let outcome: { result: T } | { error: unknown };
  try {
    fence.assertCurrent();
    if (grant.databaseIdentity) {
      admittedAuthorities.set(
        fence,
        Object.freeze({
          ...grant.databaseIdentity,
          installKey: parent.lease.key,
          owner: parent.lease.owner,
        }),
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
    slotReservations.delete(fence);
    admittedAuthorities.delete(fence);
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
  let slotLease: ManagedHandoffLease | undefined;
  const assertBase = () => {
    if (
      !active ||
      !store ||
      !lease ||
      !store.owns(lease, "executor") ||
      (slotLease && !store.owns(slotLease, "executor"))
    ) {
      throw new UpdateCommandRecoveryPendingError(
        "Update executor ownership is no longer current.",
      );
    }
  };
  const assertCurrent = () => {
    assertBase();
    if (lease?.version === 3) {
      throw new UpdateCommandRecoveryPendingError("Parent executor has unresolved native custody.");
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
        spawner: lease,
        databasePath,
        databaseIdentity: admittedAuthorities.get(fence),
        ...(slotLease ? { slot: { parent: slotLease, spawner: slotLease } } : {}),
      };
    },
  });
  childOwners.set(fence, (childOperation) => {
    assertCurrent();
    return children.run(childOperation);
  });
  slotReservations.set(fence, (root) => {
    assertCurrent();
    if (!store || !lease) {
      throw new UpdateCommandRecoveryPendingError("Slot reservation requires its live executor.");
    }
    const absolute = path.resolve(root);
    if (absolute === lease.key) {
      return;
    }
    const key = path.join(fs.realpathSync.native(path.dirname(absolute)), path.basename(absolute));
    if (key === lease.key) {
      return;
    }
    if (slotLease) {
      if (slotLease.key !== key) {
        throw new UpdateCommandRecoveryPendingError("Update executor occupied slot changed.");
      }
      return;
    }
    // Reserve the prospective directory spelling before the symlink is moved.
    // Do not acquire authority for an unrelated target or silently use a fallback.
    if (fs.realpathSync.native(key) !== lease.key) {
      throw new UpdateCommandRecoveryPendingError(
        "Occupied slot does not resolve to its original installation.",
      );
    }
    const acquired = store.acquire(key, lease.owner, { kind: "update" });
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
      if (!active || entering) {
        throw new UpdateCommandRecoveryPendingError("Update executor admission is closed or busy.");
      }
      // A missing canonical package is a recorded publication state, not an
      // invitation to resolve a different installation through the current cwd.
      const key = options?.existingAuthority?.installKey ?? resolveUpdateInstallRoot(root);
      if (options?.existingAuthority && root !== key) {
        throw new UpdateCommandRecoveryPendingError("Recovery installation key changed.");
      }
      if (lease) {
        assertCurrent();
        if (lease.key !== key && slotLease?.key !== key) {
          throw new UpdateCommandRecoveryPendingError("Update executor installation changed.");
        }
        if (!enterOptions?.preflight) {
          reserveUpdateCommandExecutorSlot(fence, root);
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
        if (enterOptions?.preflight && !borrowed) {
          preflightReleases.set(fence, () => {
            assertCurrent();
            if (!store || !lease || children.pending || slotLease || !store.release(lease)) {
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
        if (!enterOptions?.preflight) {
          reserveUpdateCommandExecutorSlot(fence, root);
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
  slotReservations.delete(fence);
  try {
    if (
      lease &&
      store &&
      (lease.version === 3 ||
        children.unsettled ||
        ((!borrowed || slotLease) &&
          !store.releaseAll([...(!borrowed ? [lease] : []), ...(slotLease ? [slotLease] : [])])))
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
}
