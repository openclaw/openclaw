import { createHash, randomUUID } from "node:crypto";
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
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery.js";

/** A live invocation, never a serialized claim, PID or recovered history row. */
export type UpdateCommandExecutor = {
  /** Acquire only after read-only service admission, before the first mutable phase. */
  enter(root: string, options?: { preflight?: true }): Promise<UpdateRecoveryFence>;
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

/** Private correlation sent only to the spawned candidate's stdin. The receiver
 * independently reads both live owners and checks its own PID/start identity. */
export type UpdateCommandChildGrant = {
  runId: string;
  root: string;
  databasePath: string;
  parent: ManagedHandoffLease;
  /** Original owner and its lineage survive a package-generation change. */
  originalParent?: ManagedHandoffLease;
  originalChildKey?: string;
  spawner?: ManagedHandoffLease;
  childKey: string;
  databaseIdentity?: ManagedUpdateLeaseDatabaseIdentity;
};
type ChildOperation<T> = (
  grant: UpdateCommandChildGrant,
  bindChild: (pid: number) => void,
) => Promise<T>;
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

// Correlate the transported lineage with the spawning owner's recorded child
// names. This is not another credential: live rows and PID/start checks still
// authorize the receiver. A mirror cannot be substituted for its original root.
function childLineageDigest(
  original: ManagedHandoffLease,
  spawner: ManagedHandoffLease,
  parent: ManagedHandoffLease,
  database: ManagedUpdateLeaseDatabaseIdentity,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        database.databasePath,
        database.databaseIdentity,
        database.parentIdentity,
        [original, spawner, parent].map((lease) => [
          lease.key,
          lease.owner,
          lease.payload,
          lease.updatedAt,
        ]),
      ]),
    )
    .digest("hex");
}

/** One child interval, shared by direct and delegated executors. */
function createChildOwner(params: {
  runId: string;
  binding: () => {
    store: ReturnType<typeof createManagedHandoffLeaseStore>;
    parent: ManagedHandoffLease;
    original: ManagedHandoffLease;
    spawner: ManagedHandoffLease;
    databasePath: string;
    databaseIdentity?: ManagedUpdateLeaseDatabaseIdentity;
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
    run<T>(root: string, operation: ChildOperation<T>): Promise<T> {
      params.assertBase();
      assertIdle();
      if (!admissionOpen) {
        throw new UpdateCommandRecoveryPendingError("Child executor admission is closed.");
      }
      const { store, parent, original, spawner, databasePath, databaseIdentity } = params.binding();
      if (!databaseIdentity) {
        throw new UpdateCommandRecoveryPendingError(
          "Native child requires its pinned lease database.",
        );
      }
      params.onStart?.();
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
          if (candidateRoot !== parent.key) {
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
          const parents =
            candidateParent.key === original.key ? [spawner] : [spawner, candidateParent];
          const childName = `${randomUUID()}-lineage-${childLineageDigest(original, spawner, candidateParent, databaseIdentity)}`;
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
            childKey: children[children.length - 1]!.key,
            databaseIdentity,
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
          if (children.length > 1 && !store.release(children[1]!)) {
            throw new UpdateCommandRecoveryPendingError("Candidate executor has not settled.");
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
  const store = createManagedHandoffLeaseStore({
    databasePath,
    serviceManagerEnv: resolveServiceManagerEnv(),
    existingIdentity: databaseIdentity,
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
      "Candidate executor binding does not match its parent.",
    );
  }
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
        "Candidate executor ownership is no longer current.",
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
  const assertBase = () => {
    if (!active || !store || !lease || !store.owns(lease, "executor")) {
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
        original: lease,
        spawner: lease,
        databasePath,
        databaseIdentity: admittedAuthorities.get(fence),
      };
    },
  });
  childOwners.set(fence, (root, childOperation) => {
    assertCurrent();
    return children.run(root, childOperation);
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
        if (lease.key !== key) {
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
  try {
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
