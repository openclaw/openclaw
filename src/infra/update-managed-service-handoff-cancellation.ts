import type { DatabaseSync as HandoffDatabase } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { isChildProcessTreeAlive } from "../process/child-process-tree.js";
import { executeSqliteQuerySync } from "./kysely-sync.js";
import {
  createManagedHandoffLeaseDatabase,
  leaseQueries,
  type LeaseRow,
  type LeaseTable,
  type ManagedUpdateLeaseDatabaseIdentity,
} from "./update-managed-service-handoff-database.js";
import type {
  ManagedHandoffLease,
  ManagedHandoffParent,
} from "./update-managed-service-handoff-lease-types.js";
import {
  readManagedHandoffOriginalAdmission,
  readOriginalUpdateDependents,
  type ManagedHandoffOriginalAdmission,
} from "./update-managed-service-handoff-original-owner.js";
import type { createManagedHandoffProcessIdentityReader } from "./update-managed-service-handoff-process.js";
import { parseManagedHandoffLeasePayload } from "./update-managed-service-handoff-schema.js";

type CancellationDependencies = {
  existingIdentity?: ManagedUpdateLeaseDatabaseIdentity;
  originalUpdateAdmissions: WeakMap<ManagedHandoffLease, ManagedHandoffOriginalAdmission>;
  withDatabase: ReturnType<typeof createManagedHandoffLeaseDatabase>;
  transact: <Result>(db: HandoffDatabase, operation: () => Result) => Result;
  mutationCurrent: (lease: ManagedHandoffParent, db: HandoffDatabase) => boolean;
  storedCurrent: (lease: ManagedHandoffParent, db: HandoffDatabase) => boolean;
  childAliases: (key: string, db: HandoffDatabase) => string[];
  canRelease: (lease: ManagedHandoffLease) => boolean;
  handle: (root: string, value: LeaseRow) => ManagedHandoffLease;
  updateRow: (
    db: HandoffDatabase,
    lease: ManagedHandoffLease,
    values: Pick<LeaseTable, "payload_json" | "updated_at"> &
      Partial<Pick<LeaseTable, "install_root">>,
  ) => boolean;
  deleteRow: (db: HandoffDatabase, root: string, value: LeaseRow) => boolean;
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
    handle,
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
  function cancelUpdate(original: ManagedHandoffLease, requestedRetained?: ManagedHandoffLease) {
    const admission = readManagedHandoffOriginalAdmission(
      original,
      originalUpdateAdmissions,
      existingIdentity,
      processState,
    );
    if (
      !admission ||
      (admission.retained &&
        requestedRetained &&
        !isDeepStrictEqual(admission.retained.original, requestedRetained)) ||
      (admission.child && requestedRetained && !admission.retained)
    ) {
      return null;
    }
    const lease = admission.current;
    const retained = admission.retained?.current ?? requestedRetained;
    // Direct-original callers keep their synchronous paired cancellation path.
    // A bound helper can revoke only the pair captured at its own acquisition.
    if (
      !admission.retained &&
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
    const descendants = (db: HandoffDatabase, parent: ManagedHandoffLease) => {
      const prefix = `${parent.key}/.openclaw-update-child-`;
      return executeSqliteQuerySync(
        db,
        leaseQueries(db)
          .selectFrom("managed_update_handoffs")
          .select(["install_root", "owner", "payload_json", "updated_at"])
          .where("install_root", ">=", prefix)
          .where("install_root", "<", prefix + "\uffff"),
      ).rows;
    };
    const transitioned = withDatabase(true, (db) =>
      transact(db, () => {
        if (!mutationCurrent(lease, db) || (retained && !mutationCurrent(retained, db))) {
          return null;
        }
        const originalChildren = descendants(db, lease);
        // Old admitted receivers cannot safely race cancellation with nested
        // admission. Only marked original lineage and its known mirrors qualify.
        if (
          originalChildren.some((entry) => {
            const child = handle(entry.install_root, entry);
            return (
              child.version !== 2 ||
              child.action.kind !== "update" ||
              child.action.mutationProtocol !== "original-cancellation-v1"
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
            cancellation: {
              key: currentRow.key,
              owner: currentRow.owner,
              payload: currentRow.payload,
              updatedAt: currentRow.updatedAt,
            },
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
              (admission.child &&
                (!admission.child.closed ||
                  processState(lease.executor) !== "dead" ||
                  (process.platform !== "win32" && isChildProcessTreeAlive(lease.executor)))) ||
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
                  !isDeepStrictEqual(item.mutationOriginal, {
                    key: lease.key,
                    owner: lease.owner,
                    payload: lease.payload,
                    updatedAt: lease.updatedAt,
                  }) ||
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
              if (
                !deleteRow(db, generation.key, {
                  owner: generation.owner,
                  payload_json: generation.payload,
                  updated_at: generation.updatedAt,
                })
              ) {
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
