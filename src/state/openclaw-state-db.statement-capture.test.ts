import { channel } from "node:diagnostics_channel";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { threadId } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import { revokeSqliteDatabaseAdmissionsForPath } from "../infra/sqlite-database-admission.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { withOpenClawStateReadOnlyLocation } from "./openclaw-state-db-read-connection.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";

// Opt-in migration proof: the external baseline is captured on the unchanged base.
const output = process.env.OPENCLAW_STATE_SQL_CAPTURE;
const baseline = process.env.OPENCLAW_STATE_SQL_BASELINE;

it.skipIf(!output)(
  "preserves raw SQLite execution bytes across the state-owner cutover",
  async () => {
    if (!output) {
      throw new Error("Set OPENCLAW_STATE_SQL_CAPTURE to the external capture JSON path");
    }
    const phases = {
      cold: [] as Array<{ method: string; sql: string }>,
      restart: [] as Array<{ method: string; sql: string }>,
      write: [] as Array<{ method: string; sql: string }>,
      read: [] as Array<{ method: string; sql: string }>,
      close: [] as Array<{ method: string; sql: string }>,
    };
    let phase: keyof typeof phases = "cold";
    const sqlByStatement = new WeakMap<StatementSync, string>();
    const diagnostics: { source: string; phase: string; engine: unknown; threadId: unknown }[] = [];
    const observations = channel("openclaw.database.statement");
    const nativeObservations = channel("sqlite.db.query");
    const observe = (message: unknown) => {
      if (message && typeof message === "object" && "engine" in message && "threadId" in message) {
        const { engine, threadId: observedThread } = message;
        diagnostics.push({ source: "engine", phase, engine, threadId: observedThread });
      }
    };
    const observeNative = () =>
      diagnostics.push({ source: "native", phase, engine: "sqlite", threadId });
    const root = path.join(path.dirname(output), "sqlite-statement-fixture");
    fs.mkdirSync(path.dirname(output), { recursive: true });
    // The path is task-owned and reused so interpolated SQL paths cannot differ between runs.
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root);
    const options = { env: { OPENCLAW_STATE_DIR: root } };
    // oxlint-disable-next-line typescript/unbound-method -- Native receiver is preserved below.
    const nativePrepare = DatabaseSync.prototype.prepare;
    // oxlint-disable-next-line typescript/unbound-method -- Native receiver is preserved below.
    const nativeExec = DatabaseSync.prototype.exec;
    vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
      this: DatabaseSync,
      sql,
    ) {
      const statement = nativePrepare.call(this, sql);
      sqlByStatement.set(statement, sql);
      return statement;
    });
    vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql) {
      phases[phase].push({ method: "exec", sql });
      return nativeExec.call(this, sql);
    });
    for (const method of ["run", "get", "all", "iterate"] as const) {
      const native = StatementSync.prototype[method];
      vi.spyOn(StatementSync.prototype, method).mockImplementation(function (
        this: StatementSync,
        ...bindings
      ) {
        const sql = sqlByStatement.get(this);
        if (sql === undefined) {
          throw new Error("Native execution escaped SQL capture");
        }
        phases[phase].push({ method, sql });
        return Reflect.apply(native, this, bindings);
      });
    }
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    vi.spyOn(performance, "now").mockReturnValue(1_000);
    observations.subscribe(observe);
    nativeObservations.subscribe(observeNative);
    try {
      const first = openOpenClawStateDatabase(options);
      expect(first.db.prepare("PRAGMA user_version").get()).toEqual({
        user_version: OPENCLAW_STATE_SCHEMA_VERSION,
      });
      expect(first.db.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
      phase = "restart";
      await closeOpenClawStateDatabaseAsync();
      revokeSqliteDatabaseAdmissionsForPath(first.path);
      const reopened = openOpenClawStateDatabase(options);
      expect(reopened.db).not.toBe(first.db);
      phase = "write";
      runOpenClawStateWriteTransaction(({ db }) => {
        db.prepare(
          "INSERT INTO diagnostic_events (scope, event_key, payload_json, created_at) VALUES (?, ?, ?, ?)",
        ).run("statement-proof", "persisted", '{"value":7}', 1_800_000_000_000);
      }, options);
      phase = "read";
      const rows = withOpenClawStateReadOnlyLocation(
        ({ db }) => {
          db.exec("BEGIN");
          try {
            return db
              .prepare("SELECT event_key, payload_json FROM diagnostic_events WHERE scope = ?")
              .all("statement-proof");
          } finally {
            db.exec("ROLLBACK");
          }
        },
        reopened.path,
        reopened.path,
      );
      expect(rows).toEqual([{ event_key: "persisted", payload_json: '{"value":7}' }]);
      phase = "close";
      await closeOpenClawStateDatabaseAsync();
      const capture = { phases, diagnostics, threadId };
      fs.writeFileSync(output, `${JSON.stringify(capture, null, 2)}\n`);
      if (baseline) {
        expect(phases).toEqual(JSON.parse(fs.readFileSync(baseline, "utf8")).phases);
      }
    } finally {
      await closeOpenClawStateDatabaseAsync();
      observations.unsubscribe(observe);
      nativeObservations.unsubscribe(observeNative);
      vi.restoreAllMocks();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
