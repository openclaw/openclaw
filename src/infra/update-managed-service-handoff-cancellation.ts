import type { DatabaseSync as HandoffDatabase } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { managedCommandCustody } from "./update-managed-service-handoff-children.js";
import type {
  createManagedHandoffLeaseDatabase,
  ManagedUpdateLeaseDatabaseIdentity,
} from "./update-managed-service-handoff-database.js";
import type {
  ManagedHandoffLease,
  ManagedHandoffParent,
} from "./update-managed-service-handoff-lease-types.js";
import {
  managedHandoffOriginalGeneration,
  readManagedHandoffOriginalAdmission,
  readOriginalUpdateDependents,
  type ManagedHandoffOriginalAdmission,
} from "./update-managed-service-handoff-original-owner.js";
import type { createManagedHandoffProcessIdentityReader } from "./update-managed-service-handoff-process.js";
import {
  managedHandoffLeaseRow,
  type createManagedHandoffLeaseRows,
} from "./update-managed-service-handoff-rows.js";
import { parseManagedHandoffLeasePayload } from "./update-managed-service-handoff-schema.js";

type CancellationDependencies = Pick<
  ReturnType<typeof createManagedHandoffLeaseRows>,
  "row" | "handle" | "descendants" | "updateRow" | "deleteRow"
> & {
  existingIdentity?: ManagedUpdateLeaseDatabaseIdentity;
  originalUpdateAdmissions: WeakMap<ManagedHandoffLease, ManagedHandoffOriginalAdmission>;
  withDatabase: ReturnType<typeof createManagedHandoffLeaseDatabase>;
  transact: <Result>(db: HandoffDatabase, operation: () => Result) => Result;
  mutationCurrent: (lease: ManagedHandoffParent, db: HandoffDatabase) => boolean;
  storedCurrent: (lease: ManagedHandoffParent, db: HandoffDatabase) => boolean;
  childAliases: (key: string, db: HandoffDatabase) => string[];
  canRelease: (lease: ManagedHandoffLease) => boolean;
  processState: ReturnType<typeof createManagedHandoffProcessIdentityReader>["processState"];
};

export function createManagedHandoffCancellation(deps: CancellationDependencies) {
  const {
    existingIdentity,
    originalUpdateAdmissions,
    withDatabase,
    transact,
    mutationCurrent,
    storedCurrent,
    childAliases,
    canRelease,
    row,
    handle,
    descendants,
    updateRow,
    deleteRow,
    processState,
  } = deps;
  const cancellations = new WeakMap<
    ManagedHandoffLease,
    {
      lease: ManagedHandoffLease;
      retained?: ManagedHandoffLease;
      retainedOriginal?: ManagedHandoffLease;
      release: (paired?: ManagedHandoffLease[]) => boolean;
    }
  >();
  function cancelUpdate(original: ManagedHandoffLease, retained?: ManagedHandoffLease) {
    const admission = readManagedHandoffOriginalAdmission(
      original,
      originalUpdateAdmissions,
      existingIdentity,
      processState,
    );
    if (!admission) {
      return null;
    }
    const lease = admission.original;
    if (
      retained &&
      (retained.key === lease.key ||
        retained.key.includes("/.openclaw-update-child-") ||
        retained.version !== 2 ||
        retained.mutationOriginal ||
        retained.action.kind !== "update" ||
        retained.helper.pid !== process.pid ||
        !isDeepStrictEqual(retained.helper, retained.executor) ||
        processState(retained.helper) !== "live")
    ) {
      return null;
    }
    const previous = cancellations.get(original);
    if (previous) {
      return withDatabase(true, (db) =>
        transact(
          db,
          () =>
            isDeepStrictEqual(previous.retainedOriginal, retained) &&
            storedCurrent(previous.lease, db) &&
            (!previous.retained || storedCurrent(previous.retained, db)),
        ),
      )
        ? previous
        : null;
    }
    const nativeCommand = (child: ManagedHandoffLease, db: HandoffDatabase) => {
      // Pending spawns still need their live root generation to publish a late PID binding.
      if (
        managedCommandCustody(child) !== "bound" ||
        !/\/\.openclaw-update-child-[a-f0-9-]{36}-command$/.test(child.key)
      ) {
        return false;
      }
      const aliases = childAliases(child.key, db);
      if (!aliases.includes(child.key)) {
        return false;
      }
      return aliases.every((key) => {
        const entry = row(db, key);
        if (!entry) {
          return false;
        }
        const peer = handle(key, entry);
        return (
          peer.version === 2 &&
          peer.owner === child.owner &&
          isDeepStrictEqual(peer.action, child.action) &&
          isDeepStrictEqual(peer.helper, child.helper) &&
          isDeepStrictEqual(peer.executor, child.executor)
        );
      });
    };
    const transitioned = withDatabase(true, (db) =>
      transact(db, () => {
        if (!mutationCurrent(lease, db) || (retained && !mutationCurrent(retained, db))) {
          return null;
        }
        const originalChildren = descendants(db, lease);
        // Raw commands do not poll cancellation. Their native claims survive the
        // root fence until physical joins and complete alias retirement finish.
        if (
          originalChildren.some((entry) => {
            const child = handle(entry.install_root, entry);
            return (
              child.version !== 2 ||
              child.action.kind !== "update" ||
              (managedCommandCustody(child)
                ? !nativeCommand(child, db)
                : child.action.mutationProtocol !== "original-cancellation-v1")
            );
          })
        ) {
          return null;
        }
        const originalKeys = new Set(originalChildren.map((entry) => entry.install_root));
        if (
          retained &&
          descendants(db, retained).some((entry) => {
            const child = handle(entry.install_root, entry);
            return (
              child.version !== 2 ||
              child.action.kind !== "update" ||
              (managedCommandCustody(child) && !nativeCommand(child, db)) ||
              !childAliases(child.key, db).some((key) => originalKeys.has(key))
            );
          })
        ) {
          return null;
        }
        const transition = (currentRow: ManagedHandoffLease) => {
          const payload = JSON.stringify({
            version: 4,
            helper: currentRow.helper,
            executor: currentRow.executor,
            action: currentRow.action,
            cancellation: managedHandoffOriginalGeneration(currentRow),
          });
          if (!parseManagedHandoffLeasePayload(payload)) {
            throw new Error("Original cancellation payload is invalid");
          }
          const updatedAt = Math.max(Date.now(), currentRow.updatedAt + 1);
          if (!updateRow(db, currentRow, { payload_json: payload, updated_at: updatedAt })) {
            throw new Error("Original cancellation generation changed");
          }
          return handle(currentRow.key, {
            owner: currentRow.owner,
            payload_json: payload,
            updated_at: updatedAt,
          });
        };
        // Change both CAS generations atomically. Even a previously admitted
        // strict service writer can no longer commit against its old payload.
        return { lease: transition(lease), retained: retained ? transition(retained) : undefined };
      }),
    );
    if (!transitioned) {
      return null;
    }
    const generations = [
      transitioned.lease,
      ...(transitioned.retained ? [transitioned.retained] : []),
    ];
    // Never exposed by the public request. The owner invokes final release only
    // after callback, child and command joins; both generations settle together.
    const successor = {
      ...transitioned,
      retainedOriginal: retained ? structuredClone(retained) : undefined,
      release: (paired: ManagedHandoffLease[] = []) =>
        withDatabase(true, (db) =>
          transact(db, () => {
            if (
              processState(lease.helper) !== "live" ||
              [lease, ...(retained ? [retained] : [])].some((parent) =>
                readOriginalUpdateDependents(parent, db).some(
                  (key) => !paired.some((item) => item.key === key),
                ),
              ) ||
              new Set([...generations, ...paired].map((item) => item.key)).size !==
                generations.length + paired.length ||
              paired.some(
                (item) =>
                  item.version !== 2 ||
                  !isDeepStrictEqual(
                    item.mutationOriginal,
                    managedHandoffOriginalGeneration(lease),
                  ) ||
                  !canRelease(item) ||
                  !storedCurrent(item, db) ||
                  descendants(db, item).length > 0 ||
                  readOriginalUpdateDependents(item, db).length > 0,
              ) ||
              generations.some(
                (generation) =>
                  !storedCurrent(generation, db) || descendants(db, generation).length > 0,
              )
            ) {
              return false;
            }
            for (const generation of [...generations, ...paired]) {
              if (!deleteRow(db, generation.key, managedHandoffLeaseRow(generation))) {
                // Roll back the paired release rather than commit half a settlement.
                throw new Error("Original cancellation settlement changed");
              }
            }
            return true;
          }),
        ),
    };
    cancellations.set(original, successor);
    return successor;
  }
  return cancelUpdate;
}
