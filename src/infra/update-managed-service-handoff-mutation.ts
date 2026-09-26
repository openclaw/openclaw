import type { DatabaseSync as HandoffDatabase } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { executeSqliteQuerySync } from "./kysely-sync.js";
import {
  createManagedHandoffLeaseDatabase,
  leaseQueries,
} from "./update-managed-service-handoff-database.js";
import type { ManagedHandoffParent } from "./update-managed-service-handoff-lease-types.js";
import type { createManagedHandoffLeaseRows } from "./update-managed-service-handoff-rows.js";
import { isRetiredManagedHandoffLeasePayload } from "./update-managed-service-handoff-schema.js";

type Rows = ReturnType<typeof createManagedHandoffLeaseRows>;
/** Original cancellation's row/lineage checks over the receiver's existing store. */
export function createManagedHandoffMutationReader(
  deps: Pick<Rows, "row" | "handle" | "sameRow" | "currentLegacyParent"> & {
    withDatabase: ReturnType<typeof createManagedHandoffLeaseDatabase>;
  },
) {
  const { row, handle, sameRow, currentLegacyParent, withDatabase } = deps;
  function storedCurrent(lease: ManagedHandoffParent, db: HandoffDatabase): boolean {
    if (lease.version === 1) {
      return currentLegacyParent(lease, db);
    }
    const value = row(db, lease.key);
    return Boolean(value && isDeepStrictEqual(handle(lease.key, value), lease));
  }
  function originalAllowsMutation(lease: ManagedHandoffParent, db: HandoffDatabase): boolean {
    if (lease.version !== 2 || !lease.mutationOriginal) {
      return true;
    }
    const original = lease.mutationOriginal;
    return sameRow(
      { owner: original.owner, payload_json: original.payload, updated_at: original.updatedAt },
      row(db, original.key),
    );
  }
  function ancestorsAllowMutation(key: string, db: HandoffDatabase): boolean {
    let marker = key.indexOf("/.openclaw-update-child-");
    while (marker >= 0) {
      const ancestorKey = key.slice(0, marker);
      const ancestor = row(db, ancestorKey);
      if (!ancestor) {
        return false;
      }
      if (!isRetiredManagedHandoffLeasePayload(ancestor.payload_json)) {
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
    if (!/^[a-f0-9-]{36}(?:-stores-v1)?-lineage-[a-f0-9]{64}$/.test(childName)) {
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
      !ancestorsAllowMutation(lease.key, db)
    ) {
      return false;
    }
    if (childAliases(lease.key, db).some((key) => !ancestorsAllowMutation(key, db))) {
      return false;
    }
    return true;
  }
  function current(lease: ManagedHandoffParent) {
    try {
      return withDatabase(false, (db) => mutationCurrent(lease, db));
    } catch {
      return false;
    }
  }
  return { storedCurrent, originalAllowsMutation, childAliases, mutationCurrent, current };
}
