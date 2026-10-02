import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { executeSqliteQuerySync } from "./kysely-sync.js";
import type { createManagedHandoffBootIdentityReader } from "./update-managed-service-handoff-boot.js";
import {
  managedCommandCustody,
  managedCommandUnsettled,
} from "./update-managed-service-handoff-children.js";
import {
  canCleanupLegacyManagedHandoff,
} from "./update-managed-service-handoff-cleanup.js";
import {
  leaseQueries,
  type LeaseRow,
} from "./update-managed-service-handoff-database.js";
import type { ManagedHandoffLease } from "./update-managed-service-handoff-lease-types.js";
import type { createManagedHandoffProcessIdentityReader } from "./update-managed-service-handoff-process.js";
import { managedHandoffLeaseText as text } from "./update-managed-service-handoff-rows.js";
import type { createManagedHandoffLeaseRows } from "./update-managed-service-handoff-rows.js";
import { parseManagedHandoffLeasePayload } from "./update-managed-service-handoff-schema.js";

type Rows = ReturnType<typeof createManagedHandoffLeaseRows>;

/** Retire dead command claims and original mirrors with the replacing admission.
 * A shipped parent cannot settle candidate custody after Doctor dies. Retained
 * bound claims must not survive successful repair and fence an older reader. */
export function observeManagedHandoffReclamation(
  root: string,
  original: ManagedHandoffLease | undefined,
  db: DatabaseSync,
  deps: Pick<Rows, "handle" | "deleteRow"> & {
    reclaimable: (lease: ManagedHandoffLease, db: DatabaseSync) => boolean;
    hasUnsettledChildren: (lease: ManagedHandoffLease, db: DatabaseSync) => boolean;
    readCommandChildren: (roots: readonly string[], db?: DatabaseSync) => ManagedHandoffLease[];
    processState: ReturnType<typeof createManagedHandoffProcessIdentityReader>["processState"];
  },
): () => boolean {
  const generation =
    original?.version === 2 &&
    !original.mutationOriginal &&
    original.action.kind === "update" &&
    original.action.mutationProtocol === "original-cancellation-v1"
      ? {
          key: original.key,
          owner: original.owner,
          payload: original.payload,
          updatedAt: original.updatedAt,
        }
      : undefined;
  const readPairs = () =>
    generation
      ? executeSqliteQuerySync(
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
        })
      : [];
  const observed = readPairs();
  const roots = [root, ...observed.map(({ lease }) => lease.key)];
  const readCommands = () =>
    deps.readCommandChildren(roots, db).toSorted((a, b) => a.key.localeCompare(b.key));
  const commands = readCommands();
  const commandSettled = (lease: ManagedHandoffLease) =>
    managedCommandCustody(lease) === "bound" &&
    deps.processState(lease.helper) === "dead" &&
    !managedCommandUnsettled(lease);
  const dead =
    observed.every(({ lease }) => deps.reclaimable(lease, db)) && commands.every(commandSettled);
  // The caller runs this only after revalidating the exact original observation
  // and its descendants, inside the same transaction that replaces that row.
  return () => {
    const current = readPairs();
    if (
      !dead ||
      !isDeepStrictEqual(current, observed) ||
      !isDeepStrictEqual(readCommands(), commands) ||
      !commands.every(commandSettled) ||
      current.some(({ lease }) => deps.hasUnsettledChildren(lease, db))
    ) {
      return false;
    }
    for (const lease of commands) {
      if (
        !deps.deleteRow(db, lease.key, {
          owner: lease.owner,
          payload_json: lease.payload,
          updated_at: lease.updatedAt,
        })
      ) {
        throw new Error("Managed command custody changed during reclamation");
      }
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
