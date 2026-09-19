import { createHash, randomUUID } from "node:crypto";
import { resolveUpdateInstallRoot } from "../../infra/update-install-root.js";
import type { ManagedUpdateLeaseDatabaseIdentity } from "../../infra/update-managed-service-handoff-database.js";
import {
  createManagedHandoffLeaseStore,
  type ManagedHandoffLease,
} from "../../infra/update-managed-service-handoff-lease.js";
import { hasCommandProcessCleanupError } from "../../process/exec-result.js";
import { withCommandProcessScope } from "../../process/exec-spawn.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery.js";

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
export type ChildOperation<T> = (
  grant: UpdateCommandChildGrant,
  bindChild: (pid: number, argv?: readonly string[]) => void,
) => Promise<T>;

// Correlate the transported lineage with the spawning owner's recorded child
// names. This is not another credential: live rows and PID/start checks still
// authorize the receiver. A mirror cannot be substituted for its original root.
export function childLineageDigest(
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
export function createChildOwner(params: {
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
      throw new UpdateCommandRecoveryPendingError("The update process is still running.");
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
          throw new UpdateCommandRecoveryPendingError("Update installation ownership changed.");
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
                "Another update executor owns the update installation.",
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
                "Could not reserve the installation for this update.",
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
          const result = await withCommandProcessScope(() =>
            operation(grant, (pid, argv) => {
              assertOwners();
              if (bound || pid === process.pid) {
                throw new UpdateCommandRecoveryPendingError(
                  "Update process can be bound only once.",
                );
              }
              for (let index = 0; index < children.length; index++) {
                const assigned = store.bind(children[index]!, pid, undefined, argv);
                if (!assigned) {
                  throw new UpdateCommandRecoveryPendingError("Update process binding failed.");
                }
                children[index] = assigned;
              }
              bound = true;
            }),
          );
          if (!bound) {
            throw new UpdateCommandRecoveryPendingError(
              "The update worker did not confirm startup.",
            );
          }
          assertOwners();
          outcome = { result };
        } catch (error) {
          outcome = { error };
        }
        if ("error" in outcome && hasCommandProcessCleanupError(outcome.error)) {
          admissionOpen = false;
          throw outcome.error;
        }
        try {
          // Release the active generation before the original lineage, as in
          // the shipped finalizer. A failed release never reactivates the parent.
          if (children.length > 1 && !store.release(children[1]!)) {
            throw new UpdateCommandRecoveryPendingError("The update process has not finished.");
          }
          if (acquiredParent && !store.release(candidateParent)) {
            throw new UpdateCommandRecoveryPendingError("Update installation release failed.");
          }
          if (children.length > 0 && !store.release(children[0]!)) {
            throw new UpdateCommandRecoveryPendingError("The update process has not finished.");
          }
          delegating = false;
        } catch (cause) {
          if ("error" in outcome) {
            throw new AggregateError(
              [outcome.error, cause],
              "Update and its executor cleanup failed",
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
          failure = cause instanceof Error ? cause : new Error("Update failed", { cause });
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
