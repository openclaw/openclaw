import { createHash, randomUUID } from "node:crypto";
import {
  snapshotUpdateInitialStoreTransport,
  type UpdateInitialStoreTransport,
} from "../../infra/update-initial-store-transport.js";
import { resolveUpdateInstallRoot } from "../../infra/update-install-root.js";
import type { ManagedUpdateLeaseDatabaseIdentity } from "../../infra/update-managed-service-handoff-database.js";
import {
  createManagedHandoffLeaseStore,
  type ManagedHandoffLease,
  type ManagedHandoffParent,
} from "../../infra/update-managed-service-handoff-lease.js";
import { hasCommandProcessCleanupError } from "../../process/exec-result.js";
import { withCommandProcessScope } from "../../process/exec-spawn.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery-error.js";

/** Private correlation sent only to the spawned candidate's stdin. The receiver
 * independently reads both live owners and checks its own PID/start identity. */
export type UpdateCommandChildGrant = {
  runId: string;
  root: string;
  initialStores?: UpdateInitialStoreTransport;
  databasePath: string;
  parent: ManagedHandoffParent;
  /** Original owner and its lineage survive a package-generation change. */
  originalParent?: ManagedHandoffParent;
  originalChildKey?: string;
  spawner?: ManagedHandoffLease;
  slot?: {
    parent: ManagedHandoffLease;
    spawner: ManagedHandoffLease;
    /** The live legacy bridge that reserved this slot, retained through descendants. */
    reserver?: ManagedHandoffLease;
    childKey: string;
  };
  retainedParent?: ManagedHandoffLease;
  retainedChildKey?: string;
  childKey: string;
  databaseIdentity?: ManagedUpdateLeaseDatabaseIdentity;
};
export type ChildPurpose = { auxiliaryPreflight?: true };
export type ChildOperation<T> = (
  grant: UpdateCommandChildGrant,
  bindChild: (pid: number, argv?: readonly string[]) => void,
) => Promise<T>;

// Correlate the transported lineage with the spawning owner's recorded child
// names. This is not another credential: live rows and PID/start checks still
// authorize the receiver. A mirror cannot be substituted for its original root.
export function childLineageDigest(
  original: ManagedHandoffParent,
  spawner: ManagedHandoffParent,
  parent: ManagedHandoffParent,
  database: ManagedUpdateLeaseDatabaseIdentity,
  retained?: ManagedHandoffLease,
  slot?: Omit<NonNullable<UpdateCommandChildGrant["slot"]>, "childKey">,
  initialStores?: UpdateInitialStoreTransport,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        database.databasePath,
        database.databaseIdentity,
        database.parentIdentity,
        ...(initialStores ? [["initial-pair-v1", initialStores.selection]] : []),
        [original, spawner, parent].map((lease) =>
          // v1 stores only its runner; bind the borrowed updater too. Shipped
          // v2/v3 payloads already carry both identities and keep their bytes.
          lease.version === 1
            ? [lease.key, lease.owner, lease.payload, lease.updatedAt, lease.helper, lease.executor]
            : [lease.key, lease.owner, lease.payload, lease.updatedAt],
        ),
        ...(slot
          ? [
              [
                "occupied-slot-v1",
                ...[slot.parent, slot.spawner].map((lease) => [
                  lease.key,
                  lease.owner,
                  lease.payload,
                  lease.updatedAt,
                ]),
                ...(slot.reserver
                  ? [
                      [
                        "legacy-slot-reserver-v1",
                        slot.reserver.key,
                        slot.reserver.owner,
                        slot.reserver.payload,
                        slot.reserver.updatedAt,
                      ],
                    ]
                  : []),
              ],
            ]
          : []),
        // Absent retention preserves the shipped single-root digest bytes.
        ...(retained
          ? [
              [
                "retained-owner-v1",
                retained.key,
                retained.owner,
                retained.payload,
                retained.updatedAt,
              ],
            ]
          : []),
      ]),
    )
    .digest("hex");
}

/** One child interval, shared by direct and delegated executors. */
export function createChildOwner(params: {
  runId: string;
  binding: () => {
    store: ReturnType<typeof createManagedHandoffLeaseStore>;
    parent: ManagedHandoffParent;
    original: ManagedHandoffParent;
    spawner: ManagedHandoffLease;
    slot?: Omit<NonNullable<UpdateCommandChildGrant["slot"]>, "childKey">;
    retainedParent?: ManagedHandoffLease;
    databasePath: string;
    databaseIdentity?: ManagedUpdateLeaseDatabaseIdentity;
    initialStores?: UpdateInitialStoreTransport;
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
    run<T>(root: string, operation: ChildOperation<T>, purpose?: ChildPurpose): Promise<T> {
      params.assertBase();
      assertIdle();
      if (!admissionOpen) {
        throw new UpdateCommandRecoveryPendingError("Child executor admission is closed.");
      }
      const {
        store,
        parent,
        original,
        spawner,
        slot,
        retainedParent,
        databasePath,
        databaseIdentity,
        initialStores: inputStores,
      } = params.binding();
      const initialStores =
        inputStores === undefined ? undefined : snapshotUpdateInitialStoreTransport(inputStores);
      if (!databaseIdentity) {
        throw new UpdateCommandRecoveryPendingError(
          "Native child requires its pinned lease database.",
        );
      }
      params.onStart?.(purpose);
      const candidateRoot = resolveUpdateInstallRoot(root);
      if (
        initialStores &&
        (candidateRoot !== initialStores.selection.installation.path ||
          databasePath !== initialStores.selection.handoff.databasePath ||
          databaseIdentity.databaseIdentity !== initialStores.selection.handoff.databaseIdentity ||
          databaseIdentity.parentIdentity !== initialStores.selection.handoff.parentIdentity)
      ) {
        throw new UpdateCommandRecoveryPendingError(
          "Child requires its explicitly selected installation and stores.",
        );
      }
      let candidateParent = parent;
      let acquiredParent = false;
      let children: ManagedHandoffLease[] = [];
      let bindingAttempted = false;
      let bound = false;
      delegating = true;
      const assertOwners = () => {
        params.assertBase();
        if (
          !store.current(candidateParent) ||
          (slot && (!store.current(slot.parent) || !store.current(slot.spawner))) ||
          (retainedParent && !store.current(retainedParent)) ||
          (resolveUpdateInstallRoot(root) !== candidateParent.key &&
            !(
              slot &&
              candidateParent.key === original.key &&
              resolveUpdateInstallRoot(root) === slot.parent.key
            ))
        ) {
          throw new UpdateCommandRecoveryPendingError("Update installation ownership changed.");
        }
      };
      const running = async () => {
        let outcome: { result: T } | { error: unknown };
        try {
          params.assertBase();
          if (retainedParent && candidateRoot === retainedParent.key) {
            throw new UpdateCommandRecoveryPendingError(
              "Retained service root is not a candidate executor.",
            );
          }
          if (slot && candidateRoot === slot.parent.key) {
            candidateParent = slot.parent;
          } else if (candidateRoot !== parent.key) {
            const acquired = store.acquire(
              candidateRoot,
              randomUUID(),
              { kind: "update" },
              false,
              undefined,
              original,
            );
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
          const parents = [
            ...new Map(
              [
                spawner,
                ...(slot ? [slot.spawner] : []),
                ...(retainedParent ? [retainedParent] : []),
                ...(candidateParent.key === original.key || candidateParent.key === slot?.parent.key
                  ? []
                  : [candidateParent]),
              ].map((owner) => [owner.key, owner]),
            ).values(),
          ];
          const candidateChildIndex =
            candidateParent.key === original.key
              ? 0
              : parents.findIndex(
                  (owner) =>
                    owner.key ===
                    (candidateParent.key === slot?.parent.key
                      ? slot.spawner.key
                      : candidateParent.key),
                );
          const childName = `${randomUUID()}${initialStores ? "-stores-v1" : ""}-lineage-${childLineageDigest(original, spawner, candidateParent, databaseIdentity, retainedParent, slot, initialStores)}`;
          for (const childParent of parents) {
            const acquired = store.acquire(
              `${childParent.key}/.openclaw-update-child-${childName}`,
              params.runId,
              {
                kind: "update",
                ...((childParent.key === original.key ||
                  childParent.key.startsWith(`${original.key}/.openclaw-update-child-`)) &&
                original.version === 2 &&
                original.action.kind === "update" &&
                original.action.mutationProtocol
                  ? { mutationProtocol: original.action.mutationProtocol }
                  : {}),
              },
              false,
              original.version === 1 &&
                childParent.key.startsWith(`${original.key}/.openclaw-update-child-`)
                ? original
                : undefined,
              original,
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
            childKey: children[candidateChildIndex]!.key,
            databaseIdentity,
            ...(initialStores ? { initialStores } : {}),
            ...(slot
              ? {
                  slot: {
                    ...slot,
                    childKey:
                      children[parents.findIndex((owner) => owner.key === slot.spawner.key)]!.key,
                  },
                }
              : {}),
            ...(retainedParent
              ? {
                  retainedParent,
                  retainedChildKey:
                    children[parents.findIndex((owner) => owner.key === retainedParent.key)]!.key,
                }
              : {}),
          };
          const result = await withCommandProcessScope(() =>
            operation(grant, (pid, argv) => {
              assertOwners();
              if (bindingAttempted || pid === process.pid) {
                throw new UpdateCommandRecoveryPendingError(
                  "Update process can be bound only once.",
                );
              }
              bindingAttempted = true;
              const assigned = store.bindUpdateChildren(children, pid, argv);
              if (!assigned) {
                throw new UpdateCommandRecoveryPendingError("Update process binding failed.");
              }
              children = assigned;
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
          // Preserve current-main's destination-before-original release order.
          // A failed destination release must retain the original lineage; its
          // paired occupied-slot lineage is released in the same transaction.
          const lineageCount = slot ? 2 : 1;
          const destinations = children.slice(lineageCount);
          if (destinations.length > 0 && !store.releaseAll(destinations)) {
            throw new UpdateCommandRecoveryPendingError("The update process has not finished.");
          }
          if (
            acquiredParent &&
            (candidateParent.version === 1 || !store.release(candidateParent))
          ) {
            throw new UpdateCommandRecoveryPendingError("Update installation release failed.");
          }
          const lineage = children.slice(0, lineageCount);
          if (lineage.length > 0 && !store.releaseAll(lineage)) {
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
