import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync as HandoffDatabase } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { executeSqliteQuerySync } from "./kysely-sync.js";
import {
  assertManagedHandoffPath,
  assertSameManagedHandoffPath,
  assertManagedUpdateLeaseDatabaseIdentity,
  leaseQueries,
  type LeaseTable,
  type ManagedUpdateLeaseDatabaseIdentity,
} from "./update-managed-service-handoff-database.js";
import { createManagedHandoffProcessIdentityReader } from "./update-managed-service-handoff-process.js";
import { managedHandoffLeaseText } from "./update-managed-service-handoff-rows.js";
import { parseManagedHandoffLeasePayload } from "./update-managed-service-handoff-schema.js";

/** Explicit cold repair of one installation's executor journal; normal readers never replay it. */
export async function recoverManagedUpdateLeaseJournal(params: {
  existingIdentity: ManagedUpdateLeaseDatabaseIdentity;
  installKey: string;
  serviceManagerEnv: NodeJS.ProcessEnv;
}): Promise<void> {
  const { existingIdentity, installKey } = params;
  if (path.resolve(installKey) !== installKey || installKey.includes("/.openclaw-update-child-")) {
    throw new Error("Managed update journal recovery requires its original installation key.");
  }
  assertManagedUpdateLeaseDatabaseIdentity(existingIdentity);
  const [{ acquireFileLock }, { prepareSqliteRollbackRecovery }] = await Promise.all([
    import("./file-lock.js"),
    import("./sqlite-rollback-recovery.js"),
  ]);
  assertManagedUpdateLeaseDatabaseIdentity(existingIdentity);
  const lock = await acquireFileLock(existingIdentity.databasePath, {
    retries: { retries: 0, factor: 1, minTimeout: 0, maxTimeout: 0 },
    stale: 30_000,
    staleRecovery: "remove-if-definitely-stale",
  });
  let active = true;
  try {
    const lockIdentity = fs.lstatSync(lock.lockPath, { bigint: true });
    assertManagedHandoffPath(lockIdentity, "file");
    const lockBytes = fs.readFileSync(lock.lockPath);
    const assertBootstrap = () => {
      if (!active) {
        throw new Error("Managed update journal bootstrap authority has closed.");
      }
      assertManagedUpdateLeaseDatabaseIdentity(existingIdentity);
      assertSameManagedHandoffPath(
        fs.lstatSync(lock.lockPath, { bigint: true }),
        lockIdentity,
        "file",
      );
      if (!fs.readFileSync(lock.lockPath).equals(lockBytes)) {
        throw new Error("Managed update journal bootstrap lock changed.");
      }
    };
    assertBootstrap();
    const { processState } = createManagedHandoffProcessIdentityReader({
      env: params.serviceManagerEnv,
    });
    const assertDeadOwner = (rows: LeaseTable[]) => {
      if (!rows.length) {
        return;
      }
      const row = rows[0]!;
      const payload = parseManagedHandoffLeasePayload(row.payload_json);
      if (
        rows.length !== 1 ||
        row.install_root !== installKey ||
        !managedHandoffLeaseText.safeParse(row.owner).success ||
        !Number.isSafeInteger(row.updated_at) ||
        row.updated_at < 0 ||
        row.recovery_json !== null ||
        !payload ||
        payload.version !== 2 ||
        payload.mutationOriginal ||
        payload.action.kind !== "update" ||
        payload.action.mutationProtocol !== "original-cancellation-v1" ||
        payload.action.custody !== undefined ||
        !isDeepStrictEqual(payload.helper, payload.executor)
      ) {
        throw new Error(
          "Managed update journal recovery refuses foreign or retained executor custody.",
        );
      }
      if (processState(payload.helper) !== "dead" || processState(payload.executor) !== "dead") {
        throw new Error(
          "Managed update journal recovery requires a definitely dead original executor.",
        );
      }
    };
    const read = (db: HandoffDatabase): LeaseTable[] => {
      // Recovery admission accepts exactly the current dedicated lease schema,
      // never a future writer, trigger, mirror table or unknown retained payload.
      const objects = db // sqlite-allow-raw -- Explicit cold-recovery schema admission before any source journal replay.
        .prepare(
          "SELECT type, name FROM sqlite_schema WHERE name <> 'sqlite_autoindex_managed_update_handoffs_1'",
        )
        .all();
      const table = db // sqlite-allow-raw -- Native STRICT-table facts belong to one recovery admission.
        .prepare("PRAGMA table_list('managed_update_handoffs')")
        .all()
        .find((entry) => entry.schema === "main");
      const columns = db // sqlite-allow-raw -- Validate the exact lease schema; recovery performs no migration.
        .prepare("PRAGMA table_info('managed_update_handoffs')")
        .all();
      const expectedColumns = [
        ["install_root", "TEXT", 1, 1],
        ["owner", "TEXT", 1, 0],
        ["payload_json", "TEXT", 1, 0],
        ["updated_at", "INTEGER", 1, 0],
        ["recovery_json", "TEXT", 0, 0],
      ];
      if (
        objects.length !== 1 ||
        objects[0]?.type !== "table" ||
        objects[0]?.name !== "managed_update_handoffs" ||
        table?.type !== "table" ||
        table.strict !== 1 ||
        table.wr !== 0 ||
        table.ncol !== 5 ||
        columns.length !== expectedColumns.length ||
        columns.some((column, index) => {
          const expected = expectedColumns[index]!;
          return (
            column.name !== expected[0] ||
            column.type !== expected[1] ||
            column.notnull !== expected[2] ||
            column.pk !== expected[3] ||
            column.dflt_value !== null
          );
        })
      ) {
        throw new Error("Managed update journal recovery refuses an unknown lease schema.");
      }
      const sizes = executeSqliteQuerySync(
        db,
        leaseQueries(db)
          .selectFrom("managed_update_handoffs")
          .select((eb) => [
            eb.fn<number>("length", [eb.cast("payload_json", "blob")]).as("payloadBytes"),
            eb.fn<number>("length", [eb.cast("owner", "blob")]).as("ownerBytes"),
            eb.fn<number>("length", [eb.cast("install_root", "blob")]).as("keyBytes"),
            eb.fn<number | null>("length", [eb.cast("recovery_json", "blob")]).as("recoveryBytes"),
          ])
          .limit(2),
      ).rows;
      if (
        sizes.length > 1 ||
        sizes.some(
          (size) =>
            size.payloadBytes > 16_384 ||
            size.ownerBytes > 4096 ||
            size.keyBytes > 4096 ||
            size.recoveryBytes !== null,
        )
      ) {
        throw new Error(
          "Managed update journal recovery refuses foreign or retained executor custody.",
        );
      }
      const rows = executeSqliteQuerySync(
        db,
        leaseQueries(db).selectFrom("managed_update_handoffs").selectAll().limit(2),
      ).rows;
      assertDeadOwner(rows);
      return rows;
    };
    const recovery = await prepareSqliteRollbackRecovery({
      path: existingIdentity.databasePath,
      scratchRoot: path.dirname(existingIdentity.databasePath),
      assertIdentity: assertBootstrap,
      assertFileSafe: (_file, stat) => assertManagedHandoffPath(stat, "file"),
      read,
    });
    recovery.admit(() => {
      assertBootstrap();
      assertDeadOwner(recovery.record);
    });
  } finally {
    active = false;
    await lock.release();
  }
}
