import type { DatabaseSync } from "node:sqlite";
import { withDaemonRuntimePinStore } from "../daemon/runtime-pin-store.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";

export function writeDaemonRuntimePinMigrationReceipt(
  db: DatabaseSync,
  sourceState: string,
  phase: "copied" | "complete",
): void {
  const result = db
    .prepare(`
      INSERT INTO daemon_runtime_pin_migration VALUES (1, ?, ?, ?)
      ON CONFLICT(version) DO UPDATE SET source_state=excluded.source_state,
        phase=excluded.phase, updated_at=excluded.updated_at
      WHERE daemon_runtime_pin_migration.phase != 'copied'
        OR daemon_runtime_pin_migration.source_state = excluded.source_state
    `)
    .run(sourceState, phase, Date.now());
  if (result.changes === 0) {
    throw new Error(
      "Runtime pin migration source changed; both stores were retained. Restore the original source and run openclaw doctor.",
    );
  }
}

/** The schema owner calls this only for an empty or recognized native-only source. */
export function initializeFreshDaemonRuntimePinMigration(
  env: NodeJS.ProcessEnv,
  sourceState: string,
): void {
  // A custom database open must not complete migration for the profile's canonical source.
  if (sourceState !== resolveOpenClawStateSqlitePath(env)) {
    return;
  }
  withDaemonRuntimePinStore(env, true, (db) => {
    // Retain copied and other-source receipts, including after source loss or restoration.
    if (!db.prepare("SELECT 1 FROM daemon_runtime_pin_migration WHERE version = 1").get()) {
      writeDaemonRuntimePinMigrationReceipt(db, sourceState, "complete");
    }
  });
}
