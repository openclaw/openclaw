import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  buildAcpDatabaseSessionKey,
  upsertAcpSessionMetaRow,
} from "../acp/runtime/session-meta-keys.js";
import { readAcpSessionCommand } from "../acp/runtime/session-meta-read.worker.js";
import { bindAcpSessionMeta } from "../acp/runtime/session-meta-write.kernel.js";
import { createUnattributedExecutionContext } from "../audit/execution-decision-facts.test-support.js";
import { presentExecutionDecisionReceiptsInDatabase } from "../audit/execution-decision-receipts.js";
import type { SessionAcpIdentity } from "../config/sessions/types.js";
import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";
import { listWorkshopChangesInDatabase } from "../skills/workshop/changes.kernel.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import {
  migratePortableIdentityColumnsV22,
  STATE_CURSOR_TABLES_V22,
} from "./openclaw-state-db-schema-v22-columns.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  repairOpenClawStateDatabaseSchema,
} from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

it("preserves local columns, constraints, indexes, and triggers during cursor backfill", () => {
  using db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE skill_workshop_changes (
    change_id TEXT PRIMARY KEY,
    value INTEGER NOT NULL CHECK (value > 0),
    doubled INTEGER GENERATED ALWAYS AS (value * 2) STORED,
    label TEXT AS (change_id || '!')
  ) STRICT;
  CREATE INDEX local_value ON skill_workshop_changes(value);
  CREATE TABLE updates (value INTEGER);
  CREATE TRIGGER local_update AFTER UPDATE ON skill_workshop_changes
    BEGIN INSERT INTO updates VALUES (new.value); END;
  INSERT INTO skill_workshop_changes (rowid, change_id, value) VALUES (7, 'first', 3), (12, 'second', 5);`);
  expect(migratePortableIdentityColumnsV22(db, 21)).toBe(true);
  expect(
    db.prepare("SELECT rowid, * FROM skill_workshop_changes ORDER BY cursor_id").all(),
  ).toEqual([
    { rowid: 7, cursor_id: 7, change_id: "first", value: 3, doubled: 6, label: "first!" },
    { rowid: 12, cursor_id: 12, change_id: "second", value: 5, doubled: 10, label: "second!" },
  ]);
  expect(
    db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE name IN ('local_value', 'local_update') ORDER BY name",
      )
      .all(),
  ).toEqual([{ name: "local_update" }, { name: "local_value" }]);
  db.exec("UPDATE skill_workshop_changes SET value = 4 WHERE cursor_id = 7");
  expect(db.prepare("SELECT * FROM updates").all()).toEqual([{ value: 4 }]);
  expect(() => db.exec("UPDATE skill_workshop_changes SET value = 0")).toThrow(/CHECK/);
});

it("matches string-only writer promotion with the v22 SQL backfill", () => {
  using db = new DatabaseSync(":memory:");
  using writer = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE acp_sessions (session_key TEXT PRIMARY KEY, identity_json TEXT) STRICT");
  writer.exec(
    extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, "acp_sessions", {
      endMarker: "CREATE TABLE IF NOT EXISTS acp_replay_sessions",
      includeEndMarker: false,
    }),
  );
  const whitespace =
    "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";
  const trimmedCodePoints: string[] = [];
  for (let codePoint = 0; codePoint <= 0x10ffff; codePoint++) {
    const character = String.fromCodePoint(codePoint);
    if (character.trim() === "") {
      trimmedCodePoints.push(character);
    }
  }
  expect(trimmedCodePoints).toEqual(Array.from(whitespace));
  const values = [
    "ordinary",
    " leading",
    "trailing ",
    " both ",
    "",
    whitespace,
    `${whitespace}resume${whitespace}`,
    "日本語🙂é",
    "\u0085\u180e\u200bresume\u0085\u180e\u200b",
    ...Array.from(whitespace, (character) => `${character}resume${character}`),
    undefined,
    null,
    0,
    1.5,
    true,
    false,
    [],
    { id: "resume" },
  ];
  const insert = db.prepare("INSERT INTO acp_sessions VALUES (?, ?)");
  const rows = values.map((value, index) => {
    const identity: SessionAcpIdentity = { state: "resolved", source: "ensure", lastUpdatedAt: 1 };
    // Exercise the writer's runtime type guard with non-string field values.
    Object.assign(identity, { agentSessionId: value, acpxSessionId: value });
    const row = bindAcpSessionMeta({
      sessionKey: String(index),
      updatedAt: 1,
      meta: {
        backend: "fixture",
        agent: "main",
        runtimeSessionName: "fixture",
        mode: "persistent",
        state: "idle",
        lastActivityAt: 1,
        identity,
      },
    });
    insert.run(row.session_key, row.identity_json);
    upsertAcpSessionMetaRow(writer, row);
    return row;
  });
  insert.run("invalid", "{");
  insert.run(
    "duplicate",
    '{"agentSessionId":" first ","agentSessionId":"last","acpxSessionId":false,"acpxSessionId":"last"}',
  );
  expect(migratePortableIdentityColumnsV22(db, 21)).toBe(true);
  const sql =
    "SELECT resume_agent_session_id, resume_acpx_session_id FROM acp_sessions WHERE session_key = ?";
  for (const row of rows) {
    expect(db.prepare(sql).get(row.session_key)).toEqual(writer.prepare(sql).get(row.session_key));
  }
  expect(db.prepare(sql).get("invalid")).toEqual({
    resume_agent_session_id: null,
    resume_acpx_session_id: null,
  });
  expect(db.prepare(sql).get("duplicate")).toEqual({
    resume_agent_session_id: "first",
    resume_acpx_session_id: null,
  });
});

describe("v21 upgrade preserves portable cursor and resume identities", () => {
  const directories = useAutoCleanupTempDirTracker((cleanup) => {
    afterAll(async () => {
      await closeOpenClawStateDatabaseAsync();
      cleanup();
    });
  });
  let template: string;
  const resumeRows = [
    { sessionKey: "agent:main:acp:a", session_id: "session-a", updated_at: 100, agent: "main" },
    { sessionKey: "agent:main:acp:b", session_id: "session-b", updated_at: 100, agent: "main" },
  ];

  beforeAll(() => {
    template = path.join(directories.make("v21-portable-template-"), "openclaw.sqlite");
    using db = new DatabaseSync(template);
    db.exec(OPENCLAW_STATE_SCHEMA_SQL);
    // Reconstruct exactly the columns and indexes changed by v22; all other contracts stay current.
    for (const table of STATE_CURSOR_TABLES_V22) {
      const index =
        table === "operator_approvals"
          ? "idx_operator_approvals_cursor_id"
          : `${table}_cursor_id_idx`;
      db.exec(`DROP INDEX ${index}; ALTER TABLE ${table} DROP COLUMN cursor_id`);
    }
    db.exec(`DROP INDEX idx_acp_sessions_resume_agent;
      DROP INDEX idx_acp_sessions_resume_acpx;
      ALTER TABLE acp_sessions DROP COLUMN resume_agent_session_id;
      ALTER TABLE acp_sessions DROP COLUMN resume_acpx_session_id;
      CREATE INDEX idx_acp_sessions_resume_agent ON acp_sessions(trim(json_extract(CASE WHEN json_valid(identity_json) THEN identity_json END, '$.agentSessionId'), char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)));
      CREATE INDEX idx_acp_sessions_resume_acpx ON acp_sessions(trim(json_extract(CASE WHEN json_valid(identity_json) THEN identity_json END, '$.acpxSessionId'), char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)));
      PRAGMA user_version = 21;
      INSERT INTO schema_meta (meta_key, role, schema_version, created_at, updated_at) VALUES ('primary', 'global', 21, 1, 1);`);
    for (const [name, rowId] of [
      ["c", 7],
      ["a", 30],
      ["b", 12],
    ] as const) {
      db.prepare(`INSERT INTO operator_approvals
        (rowid, approval_id, resolution_ref, kind, status, presentation_json, reviewer_device_ids_json,
        source_run_id, audience_session_keys_json, runtime_epoch, created_at_ms, expires_at_ms,
        updated_at_ms, decision, terminal_reason, resolved_at_ms, resolver_kind)
        VALUES (?, ?, ?, 'exec', 'denied', '{}', '[]', 'run-1', '[]', 'epoch', 50, 200, 100, 'deny', 'user', 100, 'system')`).run(
        rowId,
        name,
        name.repeat(43),
      );
      db.prepare(`INSERT INTO cron_run_receipts
        (rowid, receipt_id, store_key, job_id, config_revision, agent_id, request_run_id, status, owner_pid, started_at_ms, finished_at_ms)
        VALUES (?, ?, 'default', ?, 'revision', 'main', 'run-1', 'ok', 1, 100, 110)`).run(
        rowId,
        name,
        name,
      );
      db.prepare(
        "INSERT INTO execution_owner_lifecycle_bindings (owner_kind, owner_id, context_id, execution_id) VALUES ('cron', ?, 'context-1', 'execution-1')",
      ).run(name);
      db.prepare(`INSERT INTO execution_decision_facts
        (rowid, receipt_id, context_id, execution_id, run_id, action_family, decision_outcome, coverage_state, reason_code, owner, source_ref, occurred_at, receipt_bytes, receipt_json)
        VALUES (?, ?, 'context-1', 'execution-1', 'run-1', 'tool', 'denied', 'enforced', 'denied', 'tool-policy', ?, 100, 2, '{}')`).run(
        rowId,
        name,
        name,
      );
      db.prepare(`INSERT INTO skill_workshop_changes
        (rowid, change_id, agent_id, skill_name, action, actor, summary, created_at_ms)
        VALUES (?, ?, 'main', 'synthetic', 'create', 'user', 'created', 100)`).run(rowId, name);
    }
    const insertAcp = db.prepare(`INSERT INTO acp_sessions
      (session_key, session_id, backend, agent, runtime_session_name, identity_json, mode, state, last_activity_at, updated_at)
      VALUES (?, ?, 'synthetic', 'main', 'runtime', ?, 'persistent', 'idle', 100, 100)`);
    insertAcp.run(
      buildAcpDatabaseSessionKey("agent:main:acp:a", "main"),
      "session-a",
      '{"agentSessionId":" \u2000resume\ufeff ","agentSessionId":"wrong"}',
    );
    insertAcp.run(
      buildAcpDatabaseSessionKey("agent:main:acp:b", "main"),
      "session-b",
      '{"acpxSessionId":"resume"}',
    );
    insertAcp.run(
      buildAcpDatabaseSessionKey("agent:main:acp:c", "main"),
      "session-c",
      '{"agentSessionId":"other"}',
    );
    // Persisted opaque cursors name historical rowids, including gaps and non-key insertion order.
    expect(
      db
        .prepare(
          "SELECT approval_id FROM operator_approvals WHERE approval_id > 'a' ORDER BY resolved_at_ms, approval_id",
        )
        .all(),
    ).toEqual([{ approval_id: "b" }, { approval_id: "c" }]);
    expect(
      db
        .prepare(
          "SELECT receipt_id FROM cron_run_receipts WHERE rowid > 7 ORDER BY started_at_ms, rowid",
        )
        .all(),
    ).toEqual([{ receipt_id: "b" }, { receipt_id: "a" }]);
    expect(
      db
        .prepare(`SELECT session_id FROM acp_sessions
      WHERE trim(json_extract(identity_json, '$.agentSessionId'), char(32,8192,65279)) = 'resume'
      OR trim(json_extract(identity_json, '$.acpxSessionId'), char(32,8192,65279)) = 'resume'
      ORDER BY session_id`)
        .all(),
    ).toEqual([{ session_id: "session-a" }, { session_id: "session-b" }]);
  });

  it.each(["runtime", "doctor"] as const)(
    "preserves old cursors and resume results through %s admission",
    async (owner) => {
      const stateDir = directories.make(`v21-portable-${owner}-`);
      const pathname = resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: stateDir });
      fs.mkdirSync(path.dirname(pathname), { recursive: true });
      fs.copyFileSync(template, pathname);
      const options = { env: { OPENCLAW_STATE_DIR: stateDir }, path: pathname };
      if (owner === "doctor") {
        expect(repairOpenClawStateDatabaseSchema(options).warnings).toEqual([]);
      }
      const { db } = openOpenClawStateDatabase(options);
      expect(db.prepare("PRAGMA user_version").get()).toEqual({
        user_version: OPENCLAW_STATE_SCHEMA_VERSION,
      });
      expect(
        db.prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'").get(),
      ).toEqual({ schema_version: OPENCLAW_STATE_SCHEMA_VERSION });
      const context = createUnattributedExecutionContext();
      const schema = { cronRunReceipts: true, executionOwnerLifecycleBindings: true };
      for (const [cursor, expected] of [
        ["a:100:30", ["approval-decision:12", "approval-decision:7"]],
        ["g:100:30", ["decision-fact:12", "decision-fact:7"]],
        ["c:100:7", ["cron-lifecycle:100:12", "cron-lifecycle:100:30"]],
      ] as const) {
        const page = presentExecutionDecisionReceiptsInDatabase(db, {
          schema,
          context,
          decisionCursor: cursor,
          decisionLimit: 2,
          now: 100,
        });
        expect(page.decisionDisplays.map((display) => display.selectorId)).toEqual(expected);
      }
      expect(
        listWorkshopChangesInDatabase(db, { agentId: "main", limit: 3 }).map((change) => change.id),
      ).toEqual(["a", "b", "c"]);
      expect(
        readAcpSessionCommand(db, {
          type: "acpSessions.resume",
          agentId: "main",
          resumeSessionId: "resume",
        }).rows,
      ).toEqual(resumeRows);
      for (const table of STATE_CURSOR_TABLES_V22) {
        expect(db.prepare(`SELECT cursor_id FROM ${table} ORDER BY cursor_id`).all()).toEqual([
          { cursor_id: 7 },
          { cursor_id: 12 },
          { cursor_id: 30 },
        ]);
      }
      await closeOpenClawStateDatabaseAsync();
    },
  );
});
