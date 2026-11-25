import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { sqliteReaderDatabasePathKey } from "../infra/sqlite-reader-lifecycle.js";
import { onSqliteWalCheckpoint } from "../infra/sqlite-wal-checkpoint.js";
import { observeSqliteWalPeriodicWork } from "../infra/sqlite-wal-scheduler.test-support.js";
import type { SqliteWorkerPreparedBackend } from "../infra/sqlite-worker-contract.js";
import { openClawStateDatabaseCache } from "./openclaw-state-db-cache.js";
import type { OpenClawStateWorkerOperations } from "./openclaw-state-worker-contract.js";
import { createSqliteWorkerBackend as createSharedStateBackend } from "./openclaw-state.worker.js";

type Snapshot = { actor: string; digest: string; checkpoints: number };
export type SharedStateWalFixtureOperations = {
  "database.walMaintenance": {
    input: OpenClawStateWorkerOperations["database.walMaintenance"]["input"];
    output: undefined;
  };
  "fixture.seed": { input: undefined; output: Snapshot };
  "fixture.tick": { input: undefined; output: Snapshot };
  "fixture.snapshot": { input: undefined; output: Snapshot };
};

/** Dispatch the canonical backend's real WAL tick without waiting for wall-clock time. */
export function createSqliteWorkerBackend(
  input: undefined,
  context: { databasePath: string },
): SqliteWorkerPreparedBackend<SharedStateWalFixtureOperations> {
  const scheduled = observeSqliteWalPeriodicWork(() => true, "tick");
  let backend: ReturnType<typeof createSharedStateBackend>;
  try {
    backend = createSharedStateBackend(input, context);
  } finally {
    scheduled.restore();
  }
  const database = openClawStateDatabaseCache.getCachedOpenClawStateDatabase(context.databasePath);
  if (!database) {
    throw new Error("Shared-state fixture did not retain its native database");
  }
  const tick = scheduled.periodic;
  const actor = randomUUID();
  let checkpoints = 0;
  let sequence = 0;
  const databasePath = sqliteReaderDatabasePathKey(database.path);
  database.db.exec("PRAGMA wal_autocheckpoint=0; CREATE TABLE fixture_tick(value INTEGER);");
  const stopObserving = onSqliteWalCheckpoint((observation) => {
    if (observation.databasePath === databasePath) {
      checkpoints++;
    }
  });
  const snapshot = (): Snapshot => ({
    actor,
    digest: createHash("sha256").update(fs.readFileSync(context.databasePath)).digest("hex"),
    checkpoints,
  });
  return {
    async prepare(command) {
      if (command.type === "fixture.tick") {
        await tick();
      }
    },
    execute(command) {
      if (command.type === "database.walMaintenance") {
        backend.execute(command);
        return undefined;
      }
      if (command.type === "fixture.seed") {
        database.db.prepare("PRAGMA wal_checkpoint(TRUNCATE);").get();
        database.db.prepare("INSERT INTO fixture_tick(value) VALUES (?);").run(++sequence);
        checkpoints = 0;
      }
      return snapshot();
    },
    assertSettled: () => backend.assertSettled?.(),
    async close() {
      stopObserving();
      await backend.close();
    },
  };
}
