import fs from "node:fs";
import type { DatabaseSync as HandoffDatabase } from "node:sqlite";
import { z } from "zod";
import { executeSqliteQuerySync, prepareSqliteQueryTakeFirstSync } from "./kysely-sync.js";
import {
  leaseQueries,
  type createManagedHandoffLeaseDatabase,
  type LeaseRow,
  type LeaseTable,
  type ManagedUpdateLeaseDatabaseIdentity,
} from "./update-managed-service-handoff-database.js";
import type { ManagedHandoffLease } from "./update-managed-service-handoff-lease-types.js";
import {
  readBorrowedLegacyHandoffParent,
  isBorrowedLegacyHandoffParentCurrent,
  type BorrowedLegacyHandoffParent,
} from "./update-managed-service-handoff-legacy-parent.js";
import {
  parseManagedHandoffLeasePayload,
  type HandoffProcessIdentity,
} from "./update-managed-service-handoff-schema.js";
import { isManagedHandoffSchemaEmpty } from "./update-managed-service-handoff-source-inspection.js";

export const managedHandoffLeaseText = z.string().min(1).max(4096);
export const triageFailureSchema = z.strictObject({
  kind: z.enum(["update", "gateway-startup"]),
  phase: z.string().max(120),
  error: z.string().max(800),
  installationRoot: managedHandoffLeaseText.optional(),
  expectedVersion: z.string().max(100).optional(),
  gateway: z.enum(["verify-running", "preserve"]),
});
const text = managedHandoffLeaseText;

type LeaseRead =
  | { kind: "absent" | "unreadable" }
  | { kind: "current"; lease: ManagedHandoffLease };

export function createManagedHandoffLeaseRows(
  options: { databasePath: string; existingIdentity?: ManagedUpdateLeaseDatabaseIdentity },
  withDatabase: ReturnType<typeof createManagedHandoffLeaseDatabase>,
  processes: Parameters<typeof isBorrowedLegacyHandoffParentCurrent>[2],
) {
  const { databasePath } = options;
  const rowReaders = new WeakMap<HandoffDatabase, (root: string) => LeaseRow | undefined>();
  function row(db: HandoffDatabase, root: string) {
    let readRow = rowReaders.get(db);
    if (!readRow) {
      readRow = prepareSqliteQueryTakeFirstSync<string, LeaseRow>(db, (parameter) =>
        leaseQueries(db)
          .selectFrom("managed_update_handoffs")
          .select(["owner", "payload_json", "updated_at"])
          .where(
            "install_root",
            "=",
            parameter((key) => key),
          ),
      );
      rowReaders.set(db, readRow);
    }
    return readRow(root);
  }
  function handle(root: string, value: LeaseRow): ManagedHandoffLease {
    const payload = parseManagedHandoffLeasePayload(value.payload_json);
    if (
      !payload ||
      !text.safeParse(value.owner).success ||
      (payload.version === 2 &&
        payload.mutationOriginal &&
        (payload.mutationOriginal.key === root || root.includes("/.openclaw-update-child-"))) ||
      (payload.version === 4 &&
        (payload.cancellation.key !== root ||
          payload.cancellation.owner !== value.owner ||
          payload.cancellation.updatedAt >= value.updated_at))
    ) {
      throw new Error(
        "existing managed handoff lease is incompatible; retain diagnostics and run openclaw triage manually",
      );
    }
    return {
      key: root,
      owner: value.owner,
      payload: value.payload_json,
      updatedAt: value.updated_at,
      ...payload,
    };
  }
  function deleteRow(db: HandoffDatabase, root: string, value: LeaseRow) {
    return (
      executeSqliteQuerySync(
        db,
        leaseQueries(db)
          .deleteFrom("managed_update_handoffs")
          .where("install_root", "=", root)
          .where("owner", "=", value.owner)
          .where("payload_json", "=", value.payload_json)
          .where("updated_at", "=", value.updated_at),
      ).numAffectedRows === 1n
    );
  }
  function updateRow(
    db: HandoffDatabase,
    lease: ManagedHandoffLease,
    values: Pick<LeaseTable, "payload_json" | "updated_at"> &
      Partial<Pick<LeaseTable, "install_root">>,
  ) {
    return (
      executeSqliteQuerySync(
        db,
        leaseQueries(db)
          .updateTable("managed_update_handoffs")
          .set(values)
          .where("install_root", "=", lease.key)
          .where("owner", "=", lease.owner)
          .where("payload_json", "=", lease.payload)
          .where("updated_at", "=", lease.updatedAt),
      ).numAffectedRows === 1n
    );
  }
  function read(root: string): LeaseRead {
    try {
      if (!options.existingIdentity && !fs.existsSync(databasePath)) {
        return { kind: "absent" };
      }
      return withDatabase(false, (db) => {
        if (!options.existingIdentity && isManagedHandoffSchemaEmpty(db)) {
          return { kind: "absent" };
        }
        const value = row(db, root);
        return value ? { kind: "current", lease: handle(root, value) } : { kind: "absent" };
      });
    } catch {
      return { kind: "unreadable" };
    }
  }
  function readLegacyParent(
    root: string,
    executor?: HandoffProcessIdentity,
  ): BorrowedLegacyHandoffParent | null {
    return withDatabase(false, (db) =>
      readBorrowedLegacyHandoffParent(root, row(db, root), executor),
    );
  }
  function currentLegacyParent(parent: BorrowedLegacyHandoffParent, db: HandoffDatabase) {
    return isBorrowedLegacyHandoffParentCurrent(parent, () => row(db, parent.key), processes);
  }
  const sameRow = (a: LeaseRow | undefined, b: LeaseRow | undefined) =>
    a?.owner === b?.owner && a?.payload_json === b?.payload_json && a?.updated_at === b?.updated_at;
  return {
    row,
    handle,
    deleteRow,
    updateRow,
    read,
    readLegacyParent,
    currentLegacyParent,
    sameRow,
  };
}
