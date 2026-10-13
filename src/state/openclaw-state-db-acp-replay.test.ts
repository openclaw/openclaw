import fs from "node:fs";
import path from "node:path";
import { constants, DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectAcpReplayUtf8Accounting } from "../acp/event-ledger.test-support.js";
import * as nodeSqlite from "../infra/node-sqlite.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  repairOpenClawStateDatabaseSchema,
  prepareOpenClawStateDatabaseSchema,
} from "./openclaw-state-db.js";

function seedLegacyReplay(db: DatabaseSync) {
  const session = db.prepare(`INSERT INTO acp_replay_sessions
    (session_id, session_key, cwd, complete, created_at, updated_at, next_seq, estimated_bytes)
    VALUES (?, ?, ?, 1, 123, 456, 5, ?)`);
  const event = db.prepare(`INSERT INTO acp_replay_events
    (session_id, seq, at, session_key, run_id, update_json, estimated_bytes)
    VALUES (?, ?, 321, ?, ?, ?, ?)`);
  for (const [index, estimate] of [0, 17, 9000].entries()) {
    const id = `session-${index}-漢\0\ud800`;
    session.run(id, "key😀", "/é/e\u0301/台\0😀", estimate);
    for (let seq = 1; seq <= 3; seq++) {
      event.run(
        id,
        seq,
        "key😀\0",
        seq % 2 ? null : "run-\udc00",
        '{ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "漢😀\\u0000\\ud800" } }  ',
        estimate,
      );
    }
  }
  // Even already-correct event estimates must contribute to a repaired aggregate.
  event.run("session-0-漢\0\ud800", 4, "ascii", null, "{}", 56);
  db.exec(
    "UPDATE schema_meta SET app_version = 'synthetic-previous-build' WHERE meta_key = 'primary'",
  );
}

function canonicalReplay(db: DatabaseSync) {
  return {
    sessions: db
      .prepare(
        "SELECT session_id, session_key, cwd, complete, created_at, updated_at, next_seq FROM acp_replay_sessions ORDER BY session_id",
      )
      .all(),
    events: db
      .prepare(
        "SELECT session_id, seq, at, session_key, run_id, update_json FROM acp_replay_events ORDER BY session_id, seq",
      )
      .all(),
  };
}

function estimates(db: DatabaseSync) {
  return {
    sessions: db
      .prepare("SELECT estimated_bytes FROM acp_replay_sessions ORDER BY session_id")
      .all(),
    events: db
      .prepare("SELECT estimated_bytes FROM acp_replay_events ORDER BY session_id, seq")
      .all(),
    version: db.prepare("SELECT app_version FROM schema_meta WHERE meta_key = 'primary'").get(),
  };
}

async function withoutHistoricalPayloadReads<T>(
  pathname: string,
  operation: () => T | Promise<T>,
): Promise<T> {
  const open = nodeSqlite.openNodeSqliteDatabase;
  const databaseLocation = path.toNamespacedPath(fs.realpathSync(pathname));
  const opened = new Set<DatabaseSync>();
  const historicalReads: string[] = [];
  const historicalColumns = new Set([
    "acp_replay_events.update_json",
    "acp_replay_sessions.estimated_bytes",
    "subagent_runs.payload_json",
    "task_runs.delivery_status",
    "operator_approvals.resolution_ref",
    "cron_jobs.job_json",
    "delivery_queue_entries.entry_json",
  ]);
  const spy = vi.spyOn(nodeSqlite, "openNodeSqliteDatabase").mockImplementation((...args) => {
    const database = open(...args);
    const location = database.location();
    if (location !== null && path.toNamespacedPath(location) === databaseLocation) {
      opened.add(database);
      database.setAuthorizer((action, table, column) => {
        const field = `${table}.${column}`;
        if (action === constants.SQLITE_READ && historicalColumns.has(field)) {
          historicalReads.push(field);
          return constants.SQLITE_DENY;
        }
        return constants.SQLITE_OK;
      });
    }
    return database;
  });
  try {
    const result = await operation();
    expect(opened.size).toBeGreaterThan(0);
    expect(historicalReads).toEqual([]);
    return result;
  } finally {
    spy.mockRestore();
    for (const database of opened) {
      if (database.isOpen) {
        database.setAuthorizer(null);
      }
    }
  }
}

describe("ACP replay accounting repair", () => {
  afterEach(() => closeOpenClawStateDatabaseForTest());

  it.each(["runtime", "automatic"])(
    "populates newly added accounting columns through %s without changing canonical rows",
    async (entrance) => {
      await withTestDir({ prefix: "openclaw-acp-additive-" }, async (dir) => {
        const options = { path: path.join(dir, "state.sqlite") };
        const initial = openOpenClawStateDatabase(options).db;
        seedLegacyReplay(initial);
        const before = canonicalReplay(initial);
        initial.exec(`
          ALTER TABLE acp_replay_events DROP COLUMN estimated_bytes;
          ALTER TABLE acp_replay_sessions DROP COLUMN estimated_bytes;
        `);
        closeOpenClawStateDatabaseForTest();

        if (entrance === "automatic") {
          expect((await prepareOpenClawStateDatabaseSchema(options)).warnings).toEqual([]);
        }
        const upgraded = openOpenClawStateDatabase(options).db;
        expectAcpReplayUtf8Accounting(upgraded);
        expect(canonicalReplay(upgraded)).toEqual(before);
        closeOpenClawStateDatabaseForTest();

        const reopened = (
          await withoutHistoricalPayloadReads(options.path, () =>
            openOpenClawStateDatabase(options),
          )
        ).db;
        expect(reopened.prepare("SELECT total_changes() AS count").get()?.count).toBe(0);
        expectAcpReplayUtf8Accounting(reopened);
        expect(canonicalReplay(reopened)).toEqual(before);
      });
    },
  );

  it.each(
    ["UTF-8", "UTF-16le"].flatMap((encoding) =>
      [
        "current",
        "missing-column",
        "ordered-column",
        "sandbox-column",
        "cron-description",
        "index-drift",
      ].flatMap((schema) =>
        ["runtime", "automatic"].map((entrance) => ({ encoding, schema, entrance })),
      ),
    ),
  )(
    "leaves $encoding replay repair to Doctor through $entrance with $schema schema",
    async ({ encoding, schema, entrance }) => {
      await withTestDir({ prefix: "openclaw-acp-repair-" }, async (dir) => {
        const options = { path: path.join(dir, "state.sqlite") };
        const seed = new DatabaseSync(options.path);
        seed.exec(
          `PRAGMA encoding = '${encoding}'; CREATE TABLE encoding_seed (id INTEGER); DROP TABLE encoding_seed;`,
        );
        seed.close();
        const initial = openOpenClawStateDatabase(options).db;
        seedLegacyReplay(initial);
        const before = canonicalReplay(initial);
        const oldEstimates = estimates(initial);
        if (schema === "missing-column") {
          initial.exec("ALTER TABLE claw_installs DROP COLUMN bootstrap_source_path");
        } else if (schema === "ordered-column") {
          initial.exec("ALTER TABLE worktrees DROP COLUMN provisioned_paths_json");
        } else if (schema === "sandbox-column") {
          initial.exec("ALTER TABLE sandbox_registry_entries DROP COLUMN image");
        } else if (schema === "cron-description") {
          initial.exec("ALTER TABLE cron_jobs DROP COLUMN description");
        } else if (schema === "index-drift") {
          initial.exec(`DROP INDEX idx_plugin_state_listing;
            CREATE INDEX idx_plugin_state_listing
              ON plugin_state_entries(plugin_id, namespace, created_at, entry_key);`);
        }
        closeOpenClawStateDatabaseForTest();
        if (entrance === "automatic") {
          expect(
            (
              await withoutHistoricalPayloadReads(options.path, () =>
                prepareOpenClawStateDatabaseSchema(options),
              )
            ).warnings,
          ).toEqual([]);
        } else {
          await withoutHistoricalPayloadReads(options.path, () =>
            openOpenClawStateDatabase(options),
          );
          closeOpenClawStateDatabaseForTest();
        }
        const inspected = new DatabaseSync(options.path, { readOnly: true });
        try {
          expect(estimates(inspected)).toMatchObject({
            sessions: oldEstimates.sessions,
            events: oldEstimates.events,
          });
          expect(canonicalReplay(inspected)).toEqual(before);
        } finally {
          inspected.close();
        }
        const runtime = (
          await withoutHistoricalPayloadReads(options.path, () =>
            openOpenClawStateDatabase(options),
          )
        ).db;
        expect(estimates(runtime)).toMatchObject({
          sessions: oldEstimates.sessions,
          events: oldEstimates.events,
        });
        expect(canonicalReplay(runtime)).toEqual(before);
        closeOpenClawStateDatabaseForTest();

        expect(repairOpenClawStateDatabaseSchema(options).warnings).toEqual([]);
        const repaired = openOpenClawStateDatabase(options).db;
        expectAcpReplayUtf8Accounting(repaired);
        expect(canonicalReplay(repaired)).toEqual(before);
        const repairedEstimates = estimates(repaired);
        closeOpenClawStateDatabaseForTest();

        const reopened = (
          await withoutHistoricalPayloadReads(options.path, () =>
            openOpenClawStateDatabase(options),
          )
        ).db;
        expect(reopened.prepare("SELECT total_changes() AS count").get()?.count).toBe(0);
        expect(estimates(reopened)).toEqual(repairedEstimates);
      });
    },
  );

  it("rolls back event repairs and the release checkpoint when a later session repair fails, then doctor retries atomically", async () => {
    await withTestDir({ prefix: "openclaw-acp-repair-" }, async (dir) => {
      const options = { path: path.join(dir, "state.sqlite") };
      const initial = openOpenClawStateDatabase(options).db;
      seedLegacyReplay(initial);
      const before = canonicalReplay(initial);
      const oldEstimates = estimates(initial);
      initial.exec(`CREATE TRIGGER reject_acp_session_repair BEFORE UPDATE OF estimated_bytes ON acp_replay_sessions
        BEGIN SELECT RAISE(ABORT, 'synthetic ACP repair failure'); END`);
      closeOpenClawStateDatabaseForTest();
      const failed = repairOpenClawStateDatabaseSchema(options);
      expect(failed.warnings.join(" ")).toContain("synthetic ACP repair failure");
      const inspect = new DatabaseSync(options.path);
      try {
        expect(canonicalReplay(inspect)).toEqual(before);
        expect(estimates(inspect)).toEqual(oldEstimates);
        inspect.exec("DROP TRIGGER reject_acp_session_repair");
      } finally {
        inspect.close();
      }
      expect(repairOpenClawStateDatabaseSchema(options).warnings).toEqual([]);
      const repaired = openOpenClawStateDatabase(options).db;
      expectAcpReplayUtf8Accounting(repaired);
      expect(canonicalReplay(repaired)).toEqual(before);
    });
  });
});
