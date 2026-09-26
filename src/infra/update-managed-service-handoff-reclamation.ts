import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { executeSqliteQuerySync } from "./kysely-sync.js";
import { canCleanupLegacyManagedHandoff } from "./update-managed-service-handoff-cleanup.js";
import type { LeaseRow } from "./update-managed-service-handoff-database.js";
import { leaseQueries } from "./update-managed-service-handoff-database.js";
import type { ManagedHandoffLease } from "./update-managed-service-handoff-lease-types.js";
import type { createManagedHandoffProcessIdentityReader } from "./update-managed-service-handoff-process.js";
import { managedHandoffLeaseText as text } from "./update-managed-service-handoff-rows.js";
import type { createManagedHandoffLeaseRows } from "./update-managed-service-handoff-rows.js";
import { parseManagedHandoffLeasePayload } from "./update-managed-service-handoff-schema.js";

type Rows = ReturnType<typeof createManagedHandoffLeaseRows>;

/** Observe dead original-generation mirrors before the admission write lock.
 * Commit their removal with the original row, never strand a slot whose
 * mutationOriginal would immediately become stale. Cancellation/native custody
 * is not reclaimable and all existing mutation predicates remain unchanged. */
export function observeManagedHandoffOriginalReclamation(
  original: ManagedHandoffLease | undefined,
  db: DatabaseSync,
  deps: Pick<Rows, "handle" | "deleteRow"> & {
    reclaimable: (lease: ManagedHandoffLease, db: DatabaseSync) => boolean;
    hasUnsettledChildren: (lease: ManagedHandoffLease, db: DatabaseSync) => boolean;
  },
): () => boolean {
  if (
    !original ||
    original.version !== 2 ||
    original.mutationOriginal ||
    original.action.kind !== "update" ||
    original.action.mutationProtocol !== "original-cancellation-v1"
  ) {
    return () => true;
  }
  const generation = {
    key: original.key,
    owner: original.owner,
    payload: original.payload,
    updatedAt: original.updatedAt,
  };
  const readPairs = () =>
    executeSqliteQuerySync(
      db,
      leaseQueries(db)
        .selectFrom("managed_update_handoffs")
        .select(["install_root", "owner", "payload_json", "updated_at"])
        .orderBy("install_root"),
    ).rows.flatMap((row) => {
      const payload = parseManagedHandoffLeasePayload(row.payload_json);
      return payload?.version === 2 && isDeepStrictEqual(payload.mutationOriginal, generation)
        ? [{ row, lease: deps.handle(row.install_root, row) }]
        : [];
    });
  const observed = readPairs();
  const dead = observed.every(({ lease }) => deps.reclaimable(lease, db));
  // The caller runs this only after revalidating the exact original observation
  // and its descendants, inside the same transaction that replaces that row.
  return () => {
    const current = readPairs();
    if (
      !dead ||
      !isDeepStrictEqual(current, observed) ||
      current.some(({ lease }) => deps.hasUnsettledChildren(lease, db))
    ) {
      return false;
    }
    for (const { row } of current) {
      if (!deps.deleteRow(db, row.install_root, row)) {
        throw new Error("Original update mirror changed during reclamation");
      }
    }
    return true;
  };
}

export function readManagedHandoffAdmissionLease(
  root: string,
  value: LeaseRow | undefined,
  handle: Rows["handle"],
  processState: ReturnType<typeof createManagedHandoffProcessIdentityReader>["processState"],
) {
  // Only admission may retire a positively dead legacy row. Keep its complete
  // observation for the transaction CAS; read/handles require a supported strict schema.
  const legacyDead =
    value &&
    text.safeParse(value.owner).success &&
    Number.isSafeInteger(value.updated_at) &&
    value.updated_at >= 0 &&
    canCleanupLegacyManagedHandoff(value.payload_json, processState);
  return value && !legacyDead ? handle(root, value) : null;
}
