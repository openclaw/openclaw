import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { prepareSqliteReadOnlyLocationFromOwnedDatabase } from "./sqlite-readonly-location.js";
import type { PreparedSqliteReadOnlyLocation } from "./sqlite-readonly-location.types.js";
import {
  emitSqliteSnapshotTelemetry,
  sqliteSnapshotSourceFileSize,
} from "./sqlite-snapshot-policy.js";
import { prepareSingleFlightSqliteSnapshot } from "./sqlite-snapshot-single-flight.js";
import { readDatabasePathIdentitySync } from "./sqlite-worker-identity.js";

type LiveSnapshotOwner = {
  assertCurrent: () => void;
  database: DatabaseSync;
  owner: string;
};

const liveOwners = resolveGlobalSingleton(
  Symbol.for("openclaw.sqliteLiveSnapshotOwners"),
  () => new Map<string, LiveSnapshotOwner>(),
);

export function registerLiveSqliteSnapshotOwner(options: {
  assertCurrent: () => void;
  database: DatabaseSync;
  databasePath: string;
  owner: string;
}): () => void {
  const identity = readDatabasePathIdentitySync(options.databasePath);
  const registration: LiveSnapshotOwner = {
    assertCurrent: options.assertCurrent,
    database: options.database,
    owner: options.owner,
  };
  liveOwners.set(identity.key, registration);
  return () => {
    if (liveOwners.get(identity.key) === registration) {
      liveOwners.delete(identity.key);
    }
  };
}

export function prepareSqliteSnapshotFromLiveOwner(
  databasePath: string,
  signal?: AbortSignal,
): Promise<PreparedSqliteReadOnlyLocation> | undefined {
  signal?.throwIfAborted();
  const identity = readDatabasePathIdentitySync(databasePath);
  const owner = liveOwners.get(identity.key);
  if (!owner) {
    return undefined;
  }
  owner.assertCurrent();
  return prepareSingleFlightSqliteSnapshot(
    identity.canonicalPath,
    `live-owner:${owner.owner}`,
    async (flightSignal) => {
      const sizes = {
        sourceMainBytes: sqliteSnapshotSourceFileSize(identity.canonicalPath),
        sourceWalBytes: sqliteSnapshotSourceFileSize(`${identity.canonicalPath}-wal`),
      };
      const started = performance.now();
      const report = (outcome: "error" | "success", copiedBytes: number, error?: unknown) =>
        emitSqliteSnapshotTelemetry(
          {
            ...sizes,
            attempt: 1,
            copiedBytes,
            durationMs: Math.max(0, performance.now() - started),
            operation: "online-backup",
            outcome,
            owner: owner.owner,
            waitMs: 0,
          },
          error,
        );
      try {
        const prepared = await prepareSqliteReadOnlyLocationFromOwnedDatabase(
          owner.database,
          owner.assertCurrent,
          flightSignal,
        );
        report("success", fs.statSync(prepared.location).size);
        return prepared;
      } catch (error) {
        report("error", 0, error);
        throw error;
      }
    },
    signal,
  );
}
