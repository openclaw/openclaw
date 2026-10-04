import { openNodeSqliteDatabase, requireNodeSqlite } from "../infra/node-sqlite.js";
import {
  closeOpenClawAgentDatabaseByPath,
  openOpenClawAgentDatabase,
} from "./openclaw-agent-db.js";
import { clearOpenClawAgentIntegrityVerification } from "./openclaw-quarantine-store.js";

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
  const pageSize = Number(database.db.prepare("PRAGMA page_size").get()?.page_size);
  const rootPage = Number(
    database.db.prepare("SELECT rootpage FROM sqlite_schema WHERE name='auth_profile_store'").get()
      ?.rootpage,
  );
  if (agentId === "interrupted-admission") {
    database.db.exec("ROLLBACK");
    closeOpenClawAgentDatabaseByPath(database.path);
    clearOpenClawAgentIntegrityVerification(database.path);
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

const { DatabaseSync } = requireNodeSqlite();
// oxlint-disable-next-line typescript/unbound-method -- The interceptor always supplies the native receiver with call().
const prepare = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function (sql) {
  const statement = prepare.call(this, sql);
  if (this.location() === interrupted.path && /^PRAGMA integrity_check;?$/i.test(sql.trim())) {
    statement.all = () => {
      // The real owner has claimed its lease but has not completed the mandatory scan.
      process.send?.(fixtures);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)), 0, 0);
      throw new Error("Interrupted integrity admission unexpectedly resumed");
    };
  }
  return statement;
};
openOpenClawAgentDatabase({ agentId: interrupted.agentId });
throw new Error("Crash fixture reopened without entering its mandatory integrity scan");
