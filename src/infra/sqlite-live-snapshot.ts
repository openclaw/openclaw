import type { DatabaseSync } from "node:sqlite";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
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
    (flightSignal) =>
      prepareSqliteReadOnlyLocationFromOwnedDatabase(
        owner.database,
        owner.assertCurrent,
        flightSignal,
      ),
    signal,
  );
}
