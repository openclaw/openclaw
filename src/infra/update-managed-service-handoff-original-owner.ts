import type { DatabaseSync as HandoffDatabase } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { executeSqliteQuerySync } from "./kysely-sync.js";
import {
  leaseQueries,
  type ManagedUpdateLeaseDatabaseIdentity,
} from "./update-managed-service-handoff-database.js";
import type { ManagedHandoffLease } from "./update-managed-service-handoff-lease-types.js";
import type { createManagedHandoffProcessIdentityReader } from "./update-managed-service-handoff-process.js";
import {
  parseManagedHandoffLeasePayload,
  type ManagedHandoffLeaseAction,
} from "./update-managed-service-handoff-schema.js";

export type ManagedHandoffOriginalAdmission = {
  database: ManagedUpdateLeaseDatabaseIdentity;
  original: ManagedHandoffLease;
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

/** Generic release, rebind and process-death reclamation cannot erase a bound
 * original generation or remove its cancellation protocol. */
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
