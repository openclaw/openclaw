import type { DatabaseSync as HandoffDatabase } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { executeSqliteQuerySync } from "./kysely-sync.js";
import { managedCommandCustody } from "./update-managed-service-handoff-children.js";
import {
  createManagedHandoffLeaseDatabase,
  leaseQueries,
} from "./update-managed-service-handoff-database.js";
import type {
  ManagedHandoffLease,
  ManagedHandoffParent,
} from "./update-managed-service-handoff-lease-types.js";
import type { createManagedHandoffProcessIdentityReader } from "./update-managed-service-handoff-process.js";
import {
  managedHandoffLeaseRow,
  type createManagedHandoffLeaseRows,
} from "./update-managed-service-handoff-rows.js";
import { isRetiredManagedHandoffLeasePayload } from "./update-managed-service-handoff-schema.js";

type Rows = ReturnType<typeof createManagedHandoffLeaseRows>;
/** Live row, lineage and process authority over the receiver's existing store. */
export function createManagedHandoffMutationReader(
  deps: Pick<Rows, "row" | "handle" | "sameRow" | "currentLegacyParent"> &
    Pick<
      ReturnType<typeof createManagedHandoffProcessIdentityReader>,
      "isProcessIdentityCurrent" | "acceptSelfIdentity"
    > & {
      withDatabase: ReturnType<typeof createManagedHandoffLeaseDatabase>;
    },
) {
  const {
    row,
    handle,
    sameRow,
    currentLegacyParent,
    withDatabase,
    isProcessIdentityCurrent,
    acceptSelfIdentity,
  } = deps;
  function storedCurrent(lease: ManagedHandoffParent, db: HandoffDatabase): boolean {
    if (lease.version === 1) {
      return currentLegacyParent(lease, db);
    }
    const value = row(db, lease.key);
    return Boolean(
      value &&
      sameRow(managedHandoffLeaseRow(lease), value) &&
      isDeepStrictEqual(handle(lease.key, value), lease),
    );
  }
  function originalAllowsMutation(lease: ManagedHandoffParent, db: HandoffDatabase): boolean {
    if (lease.version !== 2 || !lease.mutationOriginal) {
      return true;
    }
    const original = lease.mutationOriginal;
    return sameRow(managedHandoffLeaseRow(original), row(db, original.key));
  }
  function ancestorsAllowMutation(
    key: string,
    db: HandoffDatabase,
    orphanCommand = false,
  ): boolean {
    let marker = key.indexOf("/.openclaw-update-child-");
    while (marker >= 0) {
      const ancestorKey = key.slice(0, marker);
      const ancestor = row(db, ancestorKey);
      if (!ancestor) {
        if (!orphanCommand) {
          return false;
        }
      } else if (!isRetiredManagedHandoffLeasePayload(ancestor.payload_json)) {
        const lease = handle(ancestorKey, ancestor);
        if (lease.version === 4 || !originalAllowsMutation(lease, db)) {
          return false;
        }
      }
      marker = key.indexOf("/.openclaw-update-child-", marker + 1);
    }
    return true;
  }
  function childAliases(key: string, db: HandoffDatabase): string[] {
    const marker = "/.openclaw-update-child-";
    const index = key.lastIndexOf(marker);
    const childName = index < 0 ? "" : key.slice(index + marker.length);
    if (!/^[a-f0-9-]{36}-(?:lineage-[a-f0-9]{64}|command)$/.test(childName)) {
      return [];
    }
    // Mirrors keep the exact recorded child name. Its restricted alphabet has
    // no LIKE wildcard; no payload or childLineageDigest bytes are rewritten.
    return executeSqliteQuerySync(
      db,
      leaseQueries(db)
        .selectFrom("managed_update_handoffs")
        .select("install_root")
        .where("install_root", "like", `%${marker}${childName}`),
    ).rows.map((entry) => entry.install_root);
  }
  function mutationCurrent(lease: ManagedHandoffParent, db: HandoffDatabase): boolean {
    if (
      lease.version === 4 ||
      !storedCurrent(lease, db) ||
      !originalAllowsMutation(lease, db) ||
      !ancestorsAllowMutation(lease.key, db, Boolean(managedCommandCustody(lease)))
    ) {
      return false;
    }
    return !childAliases(lease.key, db).some(
      (key) => !ancestorsAllowMutation(key, db, Boolean(managedCommandCustody(lease))),
    );
  }
  function current(lease: ManagedHandoffParent) {
    try {
      return withDatabase(false, (db) => mutationCurrent(lease, db));
    } catch {
      return false;
    }
  }
  function ownsProcess(lease: ManagedHandoffLease, role: "helper" | "executor") {
    return (
      !(
        lease.action.kind === "triage" &&
        ["closing", "closed", "uncertain"].includes(lease.action.phase)
      ) &&
      lease[role].pid === process.pid &&
      isProcessIdentityCurrent(lease.helper) &&
      acceptSelfIdentity(lease[role])
    );
  }
  function owns(lease: ManagedHandoffLease, role: "helper" | "executor" = "helper") {
    return current(lease) && ownsProcess(lease, role);
  }
  function ownsDelegation(
    parents: readonly ManagedHandoffParent[],
    receivers: readonly ManagedHandoffLease[],
  ) {
    // Share only this synchronous assertion's snapshot, retaining distinct
    // parent and receiver roles even when they name the same full lease.
    const unique = <T>(leases: readonly T[]) =>
      leases.filter(
        (lease, index) => leases.findIndex((other) => isDeepStrictEqual(other, lease)) === index,
      );
    const parentLeases = unique(parents);
    const receiverLeases = unique(receivers);
    try {
      if (
        !withDatabase(
          false,
          (db) =>
            parentLeases.every((lease) => mutationCurrent(lease, db)) &&
            receiverLeases.every((lease) => mutationCurrent(lease, db)),
        )
      ) {
        return false;
      }
    } catch {
      return false;
    }
    return (
      parentLeases.every(
        (lease) =>
          isProcessIdentityCurrent(lease.helper) && isProcessIdentityCurrent(lease.executor),
      ) && receiverLeases.every((lease) => ownsProcess(lease, "executor"))
    );
  }
  return {
    storedCurrent,
    originalAllowsMutation,
    childAliases,
    mutationCurrent,
    current,
    owns,
    ownsDelegation,
  };
}
