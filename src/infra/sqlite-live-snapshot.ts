import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { getChildLogger } from "../logging/logger.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { hasErrnoCode } from "./errno.js";
import { prepareSqliteReadOnlyLocationFromOwnedDatabase } from "./sqlite-readonly-location.js";
import type { PreparedSqliteReadOnlyLocation } from "./sqlite-readonly-location.types.js";
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

function readSourceSizes(pathname: string): { sourceMainBytes: number; sourceWalBytes: number } {
  const size = (candidate: string) => {
    try {
      const stat = fs.statSync(candidate);
      return stat.isFile() ? stat.size : 0;
    } catch (error) {
      if (hasErrnoCode(error, "ENOENT")) {
        return 0;
      }
      throw error;
    }
  };
  return {
    sourceMainBytes: size(pathname),
    sourceWalBytes: size(`${pathname}-wal`),
  };
}

function emitLiveSnapshotTelemetry(
  fields: {
    attempt: number;
    copiedBytes: number;
    durationMs: number;
    operation: "online-backup";
    outcome: "error" | "success";
    owner: string;
    sourceMainBytes: number;
    sourceWalBytes: number;
    waitMs: number;
  },
  error?: unknown,
): void {
  try {
    getChildLogger({ subsystem: "infra/sqlite-snapshot" }).debug(
      {
        ...fields,
        errorCode:
          error && typeof error === "object" && "code" in error ? String(error.code) : undefined,
      },
      "SQLite snapshot operation completed.",
    );
  } catch {
    // Snapshot diagnostics must not replace the operation result.
  }
}

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
      const sizes = readSourceSizes(identity.canonicalPath);
      const started = performance.now();
      try {
        const prepared = await prepareSqliteReadOnlyLocationFromOwnedDatabase(
          owner.database,
          owner.assertCurrent,
          flightSignal,
        );
        emitLiveSnapshotTelemetry({
          ...sizes,
          attempt: 1,
          copiedBytes: fs.statSync(prepared.location).size,
          durationMs: Math.max(0, performance.now() - started),
          operation: "online-backup",
          outcome: "success",
          owner: owner.owner,
          waitMs: 0,
        });
        return prepared;
      } catch (error) {
        emitLiveSnapshotTelemetry(
          {
            ...sizes,
            attempt: 1,
            copiedBytes: 0,
            durationMs: Math.max(0, performance.now() - started),
            operation: "online-backup",
            outcome: "error",
            owner: owner.owner,
            waitMs: 0,
          },
          error,
        );
        throw error;
      }
    },
    signal,
  );
}
