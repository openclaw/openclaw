import fs from "node:fs";
import { isStatePostgres } from "../state/openclaw-state-db-engine.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import {
  readOpenClawStateLease,
  releaseOpenClawStateLeaseInTransaction,
} from "../state/openclaw-state-lease-store.js";
import { gatewayOwnerKey, decodeGatewayOwnerLease } from "./gateway-owner-lease.read.js";
import type { StateDatabaseSchemaLease } from "./gateway-state-owner.js";
import { openNodeSqliteDatabase, resolveExistingSqliteFileUri } from "./node-sqlite.js";
import { runWithSqliteAsyncCleanup } from "./sqlite-lifecycle-errors.js";
import { prepareSqliteReadOnlyLocation } from "./sqlite-snapshot-source.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";

export type RecoveryLease = NonNullable<ReturnType<typeof readOpenClawStateLease>>;

/** Recovery inspects a private snapshot without borrowing the unverified owner's authority. */
export async function inspectGatewayRecoveryLease(
  databasePath: string,
): Promise<RecoveryLease | null> {
  if (isStatePostgres()) {
    throw new Error("Gateway lock recovery requires a local SQLite state database.");
  }
  if (!fs.existsSync(databasePath)) {
    return null;
  }
  const snapshot = await prepareSqliteReadOnlyLocation(databasePath, {
    allowLiveOwner: true,
    preserveSourceArtifacts: true,
  });
  return runWithSqliteAsyncCleanup(
    {
      async close() {
        if (!(await snapshot.cleanupAsync())) {
          throw new Error("Gateway recovery inspection snapshot cleanup did not finish.");
        }
      },
    },
    "Gateway recovery inspection or cleanup failed.",
    () => {
      const db = openNodeSqliteDatabase(snapshot.location, { readOnly: true });
      try {
        return tableExists(db, "state_leases")
          ? (readOpenClawStateLease(db, gatewayOwnerKey) ?? null)
          : null;
      } finally {
        db.close();
      }
    },
  );
}

export function assertGatewayRecoveryLeaseNotLive(lease: RecoveryLease | null): void {
  if (lease && decodeGatewayOwnerLease(lease)?.state === "live") {
    throw new Error(
      "Gateway owner lease is still live; stop the holder before recovering its lock.",
    );
  }
}

/** CLI-only repair: physical custody and the exact reviewed row guard this deletion. */
export function removeGatewayRecoveryLease(
  databasePath: string,
  expected: RecoveryLease | null,
  custody: StateDatabaseSchemaLease,
): void {
  custody.assertDatabaseAccess(databasePath);
  if (!fs.existsSync(databasePath)) {
    if (expected) {
      throw new Error("Gateway state database changed; inspect the lock again.");
    }
    return;
  }
  const db = openNodeSqliteDatabase(resolveExistingSqliteFileUri(databasePath));
  try {
    runSqliteImmediateTransactionSync(
      db,
      () => {
        custody.assertDatabaseAccess(databasePath);
        const actual = tableExists(db, "state_leases")
          ? (readOpenClawStateLease(db, gatewayOwnerKey) ?? null)
          : null;
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          throw new Error("Gateway owner lease changed; inspect the lock again.");
        }
        assertGatewayRecoveryLeaseNotLive(actual);
        if (actual) {
          releaseOpenClawStateLeaseInTransaction(db, { ...gatewayOwnerKey, owner: actual.owner });
        }
      },
      { databaseLabel: databasePath, operationLabel: "gateway.lock-recovery" },
    );
  } finally {
    db.close();
  }
}
