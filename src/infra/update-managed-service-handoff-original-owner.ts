import { ChildProcess } from "node:child_process";
import fs from "node:fs";
import type { DatabaseSync as HandoffDatabase } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { isChildProcessTreeAlive } from "../process/child-process-tree.js";
import { executeSqliteQuerySync } from "./kysely-sync.js";
import {
  leaseQueries,
  type createManagedHandoffLeaseDatabase,
  type ManagedUpdateLeaseDatabaseIdentity,
} from "./update-managed-service-handoff-database.js";
import type {
  LeaseAcquisition,
  ManagedHandoffLease,
  ManagedHandoffParent,
} from "./update-managed-service-handoff-lease-types.js";
import type { createManagedHandoffProcessIdentityReader } from "./update-managed-service-handoff-process.js";
import type { createManagedHandoffLeaseRows } from "./update-managed-service-handoff-rows.js";
import {
  parseManagedHandoffLeasePayload,
  type ManagedHandoffLeaseAction,
} from "./update-managed-service-handoff-schema.js";

export type ManagedHandoffOriginalAdmission = {
  database: ManagedUpdateLeaseDatabaseIdentity;
  original: ManagedHandoffLease;
  current: ManagedHandoffLease;
  retained?: { original: ManagedHandoffLease; current: ManagedHandoffLease };
  retainedSelection?: string | null;
  child?: { process: ChildProcess; closed: boolean };
};

/** Validate the unchanged acquisition object, never a decoded or copied row. */
export function readManagedHandoffOriginalAdmission(
  original: ManagedHandoffLease,
  admissions: WeakMap<ManagedHandoffLease, ManagedHandoffOriginalAdmission>,
  existingIdentity: ManagedUpdateLeaseDatabaseIdentity | undefined,
  processState: ReturnType<typeof createManagedHandoffProcessIdentityReader>["processState"],
) {
  const receipt = admissions.get(original);
  if (
    !receipt ||
    !existingIdentity ||
    receipt.database.databasePath !== existingIdentity.databasePath ||
    receipt.database.databaseIdentity !== existingIdentity.databaseIdentity ||
    receipt.database.parentIdentity !== existingIdentity.parentIdentity ||
    !isDeepStrictEqual(receipt.original, original) ||
    original.version !== 2 ||
    original.mutationOriginal ||
    original.action.kind !== "update" ||
    original.action.mutationProtocol !== "original-cancellation-v1" ||
    original.key.includes("/.openclaw-update-child-") ||
    original.helper.pid !== process.pid ||
    !isDeepStrictEqual(original.helper, original.executor) ||
    processState(original.helper) !== "live"
  ) {
    return undefined;
  }
  return receipt;
}

/** Marked top-level bound generations retain helper custody until receipt-aware
 * return. Generic release, rebind and process-death reclamation cannot join them. */
export function hasOriginalUpdateExecutorCustody(
  lease: ManagedHandoffLease,
  action: ManagedHandoffLeaseAction = lease.action,
): boolean {
  return (
    lease.version === 2 &&
    lease.action.kind === "update" &&
    lease.action.mutationProtocol === "original-cancellation-v1" &&
    !lease.key.includes("/.openclaw-update-child-") &&
    (!isDeepStrictEqual(lease.helper, lease.executor) ||
      action.kind !== "update" ||
      action.mutationProtocol !== "original-cancellation-v1")
  );
}

/** Query existing native lineage, not a second authority registry. Top-level
 * occupied slots are not child-name aliases and must settle before generation changes. */
export function readOriginalUpdateDependents(
  lease: ManagedHandoffLease,
  db: HandoffDatabase,
): string[] {
  const original = {
    key: lease.key,
    owner: lease.owner,
    payload: lease.payload,
    updatedAt: lease.updatedAt,
  };
  return executeSqliteQuerySync(
    db,
    leaseQueries(db).selectFrom("managed_update_handoffs").select(["install_root", "payload_json"]),
  ).rows.flatMap((entry) => {
    const payload = parseManagedHandoffLeasePayload(entry.payload_json);
    return payload?.version === 2 && isDeepStrictEqual(payload.mutationOriginal, original)
      ? [entry.install_root]
      : [];
  });
}

/** One actual native descendant row is enough to refuse a new original pair. */
export function readManagedHandoffDescendant(key: string, db: HandoffDatabase) {
  return executeSqliteQuerySync(
    db,
    leaseQueries(db)
      .selectFrom("managed_update_handoffs")
      .select(["install_root", "owner"])
      .where("install_root", ">=", key + "/.openclaw-update-child-")
      .where("install_root", "<", key + "/.openclaw-update-child-\uffff")
      .limit(1),
  ).rows[0];
}

type Rows = ReturnType<typeof createManagedHandoffLeaseRows>;
type Processes = ReturnType<typeof createManagedHandoffProcessIdentityReader>;
export function createManagedHandoffOriginalOwner(deps: {
  existingIdentity?: ManagedUpdateLeaseDatabaseIdentity;
  originalUpdateAdmissions: WeakMap<ManagedHandoffLease, ManagedHandoffOriginalAdmission>;
  withDatabase: ReturnType<typeof createManagedHandoffLeaseDatabase>;
  transact: <T>(db: HandoffDatabase, run: () => T) => T;
  mutationCurrent: (lease: ManagedHandoffParent, db: HandoffDatabase) => boolean;
  hasUnsettledChildren: (lease: ManagedHandoffParent, db?: HandoffDatabase) => boolean;
  processIdentity: Processes["processIdentity"];
  processState: Processes["processState"];
  owns: (lease: ManagedHandoffLease) => boolean;
  row: Rows["row"];
  sameRow: Rows["sameRow"];
  handle: Rows["handle"];
  updateRow: Rows["updateRow"];
  deleteRow: Rows["deleteRow"];
  childAliases: (key: string, db: HandoffDatabase) => string[];
  admitRetained: (
    root: string,
    owner: string,
    payload: string,
    db: HandoffDatabase,
  ) => LeaseAcquisition;
}) {
  const {
    existingIdentity,
    originalUpdateAdmissions,
    withDatabase,
    transact,
    mutationCurrent,
    hasUnsettledChildren,
    processIdentity,
    processState,
    owns,
    row,
    sameRow,
    handle,
    updateRow,
    deleteRow,
    childAliases,
    admitRetained,
  } = deps;
  function admission(original: ManagedHandoffLease, current: ManagedHandoffLease) {
    const receipt = readManagedHandoffOriginalAdmission(
      original,
      originalUpdateAdmissions,
      existingIdentity,
      processState,
    );
    return receipt && isDeepStrictEqual(receipt.current, current) ? receipt : undefined;
  }
  function hasDescendantRows(key: string, db: HandoffDatabase) {
    return Boolean(readManagedHandoffDescendant(key, db));
  }
  /** Complete only this receipt's exact joined pair; no caller-supplied release list. */
  function releaseOriginalUpdate(original: ManagedHandoffLease, current: ManagedHandoffLease) {
    const receipt = admission(original, current);
    if (!receipt || receipt.child) {
      return false;
    }
    const pair = [receipt.current, ...(receipt.retained ? [receipt.retained.current] : [])];
    return withDatabase(true, (db) =>
      transact(db, () => {
        if (
          pair.some(
            (lease) =>
              !mutationCurrent(lease, db) ||
              hasDescendantRows(lease.key, db) ||
              readOriginalUpdateDependents(lease, db).length > 0 ||
              childAliases(lease.key, db).length > 0,
          )
        ) {
          return false;
        }
        for (const lease of pair) {
          if (
            !deleteRow(db, lease.key, {
              owner: lease.owner,
              payload_json: lease.payload,
              updated_at: lease.updatedAt,
            })
          ) {
            throw new Error("Original helper pair changed during final release");
          }
        }
        return true;
      }),
    );
  }

  function transition(
    receipt: ManagedHandoffOriginalAdmission,
    executor: ManagedHandoffLease["executor"],
    assertExecutor: () => boolean,
  ) {
    const previous = [receipt.current, ...(receipt.retained ? [receipt.retained.current] : [])];
    // Prepare every immutable next-generation fact before the first row mutation.
    const next = previous.map((lease) => {
      const payload = JSON.stringify({
        version: 2,
        helper: lease.helper,
        executor,
        action: lease.action,
      });
      return handle(lease.key, {
        owner: lease.owner,
        payload_json: payload,
        updated_at: Math.max(Date.now(), lease.updatedAt + 1),
      });
    });
    const recorded = next.map((lease) => structuredClone(lease));
    const committed = withDatabase(true, (db) =>
      transact(db, () => {
        if (
          !assertExecutor() ||
          previous.some(
            (lease) =>
              lease.version !== 2 ||
              !mutationCurrent(lease, db) ||
              hasUnsettledChildren(lease, db) ||
              // A dead process is not a join receipt. Retained descendant rows
              // must be explicitly settled before advancing the original pair.
              hasDescendantRows(lease.key, db) ||
              readOriginalUpdateDependents(lease, db).length > 0,
          )
        ) {
          return false;
        }
        for (let index = 0; index < previous.length; index++) {
          if (
            !updateRow(db, previous[index]!, {
              payload_json: next[index]!.payload,
              updated_at: next[index]!.updatedAt,
            })
          ) {
            throw new Error("Original executor pair changed during binding");
          }
        }
        return true;
      }),
    );
    if (!committed) {
      return null;
    }
    receipt.current = recorded[0]!;
    if (receipt.retained) {
      receipt.retained.current = recorded[1]!;
    }
    return { lease: next[0]!, retainedLease: next[1] };
  }

  /** The read-only target planner supplies its service root before enter returns a
   * mutation fence. Only the retained original helper can acquire this selection;
   * the child never acquires a service row or supplies an acquisition receipt. */
  function selectOriginalUpdateRetainedRoot(
    original: ManagedHandoffLease,
    current: ManagedHandoffLease,
    root: string | null,
  ): { lease: ManagedHandoffLease; retainedLease?: ManagedHandoffLease } | null {
    const receipt = admission(original, current);
    if (
      !receipt ||
      (root !== null &&
        (root === original.key ||
          root.includes("/.openclaw-update-child-") ||
          fs.realpathSync(root) !== root)) ||
      (receipt.retained && root !== receipt.retained.current.key) ||
      (receipt.retainedSelection !== undefined && receipt.retainedSelection !== root)
    ) {
      return null;
    }
    let selected: ManagedHandoffOriginalAdmission["retained"];
    const committed = withDatabase(true, (db) =>
      transact(db, () => {
        if (
          !mutationCurrent(receipt.current, db) ||
          hasUnsettledChildren(receipt.current, db) ||
          hasDescendantRows(receipt.current.key, db) ||
          readOriginalUpdateDependents(receipt.current, db).length > 0 ||
          (receipt.child &&
            (receipt.child.closed ||
              !receipt.child.process.connected ||
              processState(receipt.current.executor) !== "live")) ||
          (receipt.retained &&
            (!mutationCurrent(receipt.retained.current, db) ||
              hasUnsettledChildren(receipt.retained.current, db) ||
              hasDescendantRows(receipt.retained.current.key, db) ||
              readOriginalUpdateDependents(receipt.retained.current, db).length > 0))
        ) {
          return false;
        }
        if (root !== null && !receipt.retained) {
          if (hasDescendantRows(root, db)) {
            return false;
          }
          const acquired = admitRetained(root, original.owner, receipt.current.payload, db);
          if (acquired.kind !== "acquired") {
            return false;
          }
          selected = {
            original: structuredClone(acquired.lease),
            current: structuredClone(acquired.lease),
          };
        }
        return true;
      }),
    );
    if (!committed) {
      return null;
    }
    if (selected) {
      receipt.retained = selected;
    }
    receipt.retainedSelection = root;
    return {
      lease: structuredClone(receipt.current),
      retainedLease: receipt.retained ? structuredClone(receipt.retained.current) : undefined,
    };
  }

  /** Only the actual gated IPC child becomes executor; the helper keeps the receipt. */
  function bindOriginalUpdateExecutor(
    original: ManagedHandoffLease,
    current: ManagedHandoffLease,
    child: ChildProcess,
    argv?: readonly string[],
  ) {
    const receipt = admission(original, current);
    if (
      !receipt ||
      receipt.child ||
      !(child instanceof ChildProcess) ||
      !child.pid ||
      !child.connected ||
      child.exitCode !== null ||
      child.signalCode !== null ||
      !isDeepStrictEqual(current.executor, original.helper)
    ) {
      return null;
    }
    const executor = processIdentity(child.pid, argv);
    const custody = { process: child, closed: false };
    const closed = () => {
      custody.closed = true;
    };
    child.once("close", closed);
    try {
      const result = transition(
        receipt,
        executor,
        () => !custody.closed && child.connected && processState(executor) === "live",
      );
      if (result) {
        receipt.child = custody;
        return result;
      }
    } catch (error) {
      child.removeListener("close", closed);
      throw error;
    }
    child.removeListener("close", closed);
    return null;
  }

  /** The caller joins its control work; native custody additionally observes real child close. */
  function returnOriginalUpdateExecutor(
    original: ManagedHandoffLease,
    current: ManagedHandoffLease,
  ) {
    const receipt = admission(original, current);
    if (!receipt?.child?.closed || receipt.child.process.pid !== current.executor.pid) {
      return null;
    }
    const result = transition(
      receipt,
      original.helper,
      () =>
        processState(current.executor) === "dead" &&
        (process.platform === "win32" || !isChildProcessTreeAlive(current.executor)),
    );
    if (result) {
      receipt.child = undefined;
    }
    return result;
  }
  // Paired original-root/occupied-slot child rows must become bound atomically.
  // A parent dying between separate binds must not expose either installation.
  function bindUpdateChildren(
    leases: ManagedHandoffLease[],
    pid: number,
    argv?: readonly string[],
  ) {
    if (
      !leases.length ||
      new Set(leases.map((lease) => lease.key)).size !== leases.length ||
      leases.some(
        (lease) =>
          lease.version !== 2 ||
          lease.action.kind !== "update" ||
          !lease.key.includes("/.openclaw-update-child-") ||
          !owns(lease) ||
          !isDeepStrictEqual(lease.helper, lease.executor),
      )
    ) {
      return null;
    }
    const executor = processIdentity(pid, argv);
    return withDatabase(true, (db) =>
      transact(db, () => {
        if (
          leases.some(
            (lease) =>
              !sameRow(row(db, lease.key), {
                owner: lease.owner,
                payload_json: lease.payload,
                updated_at: lease.updatedAt,
              }) || hasUnsettledChildren(lease, db),
          )
        ) {
          return null;
        }
        return leases.map((lease) => {
          const payload = JSON.stringify({
            version: 2,
            helper: lease.helper,
            executor,
            action: lease.action,
          });
          const updatedAt = Math.max(Date.now(), lease.updatedAt + 1);
          if (!updateRow(db, lease, { payload_json: payload, updated_at: updatedAt })) {
            throw new Error("Candidate process binding changed.");
          }
          return handle(lease.key, {
            owner: lease.owner,
            payload_json: payload,
            updated_at: updatedAt,
          });
        });
      }),
    );
  }

  return {
    bindOriginalUpdateExecutor,
    returnOriginalUpdateExecutor,
    selectOriginalUpdateRetainedRoot,
    releaseOriginalUpdate,
    bindUpdateChildren,
  };
}
