import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import { invalidateOpenClawAgentDatabaseIntegrityBeforeMutation } from "./openclaw-agent-db-lease.js";
import {
  closeOpenClawAgentDatabaseByPath,
  openOpenClawAgentDatabase,
} from "./openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "./openclaw-state-db.js";

const fixtures = process.argv.slice(2).map((agentId) => {
  const created = openOpenClawAgentDatabase({ agentId });
  closeOpenClawAgentDatabaseByPath(created.path);
  // Reopen a created file so the owner records its actual inode provenance.
  const database = openOpenClawAgentDatabase({ agentId });
  database.db.exec(`
    PRAGMA wal_autocheckpoint=0;
    INSERT INTO auth_profile_store VALUES ('preserved', '{"ok":true}', 1);
    PRAGMA wal_checkpoint(TRUNCATE);
    INSERT INTO auth_profile_state VALUES ('committed-wal', '{}', 1);
    BEGIN IMMEDIATE;
    INSERT INTO auth_profile_state VALUES ('killed-write', '{}', 2);
  `);
  if (agentId === "checkpointed-wal") {
    database.db.exec(
      "ROLLBACK; PRAGMA wal_checkpoint(TRUNCATE); BEGIN IMMEDIATE; INSERT INTO auth_profile_state VALUES ('killed-write', '{}', 2)",
    );
  }
  const pageSize = Number(database.db.prepare("PRAGMA page_size").get()?.page_size);
  const rootPage = Number(
    database.db.prepare("SELECT rootpage FROM sqlite_schema WHERE name='auth_profile_store'").get()
      ?.rootpage,
  );
  if (agentId === "interrupted-admission") {
    database.db.exec("ROLLBACK");
    closeOpenClawAgentDatabaseByPath(database.path);
    invalidateOpenClawAgentDatabaseIntegrityBeforeMutation(database.path);
  }
  return { agentId, path: database.path, corruptionOffset: (rootPage - 1) * pageSize };
});

const interrupted = fixtures.at(-1);
if (interrupted?.agentId !== "interrupted-admission") {
  throw new Error("Crash fixture requires its interrupted admission case last");
}
// Keep genuine committed WAL frames without lending this raw writer an admission receipt.
const wal = openNodeSqliteDatabase(interrupted.path);
wal.exec("UPDATE auth_profile_state SET updated_at=3 WHERE state_key='committed-wal'");

const state = requireNativeSqliteDatabase(openOpenClawStateDatabase().db);
state.function("pause_interrupted_admission", () => {
  // The lease claim is committed; admission's required-verification receipt is still in flight.
  process.send?.(fixtures);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)), 0, 0);
  throw new Error("Interrupted integrity admission unexpectedly resumed");
});
state.exec(`CREATE TEMP TRIGGER pause_interrupted_admission
  BEFORE UPDATE OF opened_at ON agent_database_leases
  WHEN NEW.agent_id = 'interrupted-admission'
  BEGIN SELECT pause_interrupted_admission(); END;`);
openOpenClawAgentDatabase({ agentId: interrupted.agentId });
throw new Error("Crash fixture reopened without entering its mandatory integrity scan");
