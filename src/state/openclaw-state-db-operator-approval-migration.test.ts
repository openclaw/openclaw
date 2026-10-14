// Operator-approval kind migration: exact-legacy fail-closed repair.
import { DatabaseSync, StatementSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { admitSqliteSchema } from "../infra/sqlite-schema-facts.js";
import {
  assertCanonicalOperatorApprovalKinds,
  repairOperatorApprovalSchema,
} from "./openclaw-state-db-operator-approval-migration.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

function canonicalOperatorApprovalCreateSql(): string {
  const marker = "CREATE TABLE IF NOT EXISTS operator_approvals (";
  const tableTerminator = "\n) STRICT;";
  const start = OPENCLAW_STATE_SCHEMA_SQL.indexOf(marker);
  const end = OPENCLAW_STATE_SCHEMA_SQL.indexOf(tableTerminator, start);
  return OPENCLAW_STATE_SCHEMA_SQL.slice(start, end + tableTerminator.length);
}

// Historical fixture deliberately independent of the evolving canonical DDL.
const LEGACY_TWO_KIND_CREATE_SQL = `CREATE TABLE IF NOT EXISTS operator_approvals (
  approval_id TEXT NOT NULL PRIMARY KEY CHECK (
    length(approval_id) > 0 AND approval_id NOT IN ('.', '..')
  ),
  resolution_ref TEXT NOT NULL CHECK (
    length(resolution_ref) = 43 AND resolution_ref NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  kind TEXT NOT NULL CHECK (kind IN ('exec', 'plugin')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'allowed', 'denied', 'expired', 'cancelled')),
  presentation_json TEXT NOT NULL,
  requested_by_device_id TEXT,
  requested_by_client_id TEXT,
  requested_by_device_token_auth INTEGER NOT NULL DEFAULT 0,
  reviewer_device_ids_json TEXT NOT NULL,
  source_agent_id TEXT,
  source_session_key TEXT,
  source_session_id TEXT,
  source_run_id TEXT,
  source_tool_call_id TEXT,
  source_tool_name TEXT,
  audience_session_keys_json TEXT NOT NULL,
  runtime_epoch TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  decision TEXT CHECK (decision IN ('allow-once', 'allow-always', 'deny')),
  terminal_reason TEXT CHECK (
    terminal_reason IN (
      'user',
      'timeout',
      'malformed-verdict',
      'no-route',
      'run-aborted',
      'gateway-restart',
      'storage-corrupt'
    )
  ),
  resolved_at_ms INTEGER,
  resolver_kind TEXT CHECK (resolver_kind IN ('device', 'channel', 'runtime', 'system')),
  resolver_id TEXT,
  consumed_at_ms INTEGER,
  consumed_by TEXT,
  CHECK (expires_at_ms >= created_at_ms),
  CHECK (updated_at_ms >= created_at_ms),
  CHECK (resolved_at_ms IS NULL OR resolved_at_ms >= created_at_ms),
  CHECK (resolved_at_ms IS NULL OR resolved_at_ms <= updated_at_ms),
  CHECK (consumed_at_ms IS NULL OR consumed_at_ms >= resolved_at_ms),
  CHECK (consumed_at_ms IS NULL OR consumed_at_ms <= updated_at_ms),
  CHECK (requested_by_device_token_auth IN (0, 1)),
  CHECK (
    (
      status = 'pending'
      AND decision IS NULL
      AND terminal_reason IS NULL
      AND resolved_at_ms IS NULL
      AND resolver_kind IS NULL
      AND resolver_id IS NULL
      AND consumed_at_ms IS NULL
      AND consumed_by IS NULL
    )
    OR (
      status = 'allowed'
      AND decision IN ('allow-once', 'allow-always')
      AND terminal_reason = 'user'
      AND resolved_at_ms IS NOT NULL
      AND resolver_kind IS NOT NULL
    )
    OR (
      status = 'denied'
      AND decision = 'deny'
      AND terminal_reason IN ('user', 'malformed-verdict', 'no-route', 'storage-corrupt')
      AND resolved_at_ms IS NOT NULL
      AND resolver_kind IS NOT NULL
      AND consumed_at_ms IS NULL
      AND consumed_by IS NULL
    )
    OR (
      status = 'expired'
      AND decision = 'deny'
      AND terminal_reason = 'timeout'
      AND resolved_at_ms IS NOT NULL
      AND resolver_kind IS NOT NULL
      AND consumed_at_ms IS NULL
      AND consumed_by IS NULL
    )
    OR (
      status = 'cancelled'
      AND decision = 'deny'
      AND terminal_reason IN ('run-aborted', 'gateway-restart')
      AND resolved_at_ms IS NOT NULL
      AND resolver_kind IS NOT NULL
      AND consumed_at_ms IS NULL
      AND consumed_by IS NULL
    )
  ),
  CHECK (
    (consumed_at_ms IS NULL AND consumed_by IS NULL)
    OR (
      status = 'allowed'
      AND decision = 'allow-once'
      AND consumed_at_ms IS NOT NULL
      AND consumed_by IS NOT NULL
    )
  )
) STRICT;`;

function legacyTwoKindCreateSql(): string {
  return LEGACY_TWO_KIND_CREATE_SQL.replace(/\) STRICT;$/u, ");");
}

function withoutResolutionRefColumn(sql: string): string {
  const resolutionRefStart = sql.indexOf("\n  resolution_ref ");
  const followingColumnStart = sql.indexOf("\n  kind ", resolutionRefStart);
  if (resolutionRefStart < 0 || followingColumnStart < 0) {
    throw new Error("resolution_ref column not found");
  }
  return sql.slice(0, resolutionRefStart) + sql.slice(followingColumnStart);
}

function createAlterAppendedLegacyTable(db: DatabaseSync, strict: boolean): void {
  const createSql = withoutResolutionRefColumn(
    strict ? legacyTwoKindCreateSql().replace(/\);$/u, ") STRICT;") : legacyTwoKindCreateSql(),
  );
  db.exec(createSql);
  db.exec("ALTER TABLE operator_approvals ADD COLUMN resolution_ref TEXT;");
}

const RESOLUTION_REF = "ref0000000000000000000000000000000000000000";

function seedRow(
  db: DatabaseSync,
  kind: string,
  resolutionRef: string | null = RESOLUTION_REF,
  approvalId = "a1",
): void {
  db.prepare(`
    INSERT INTO operator_approvals (
      approval_id, resolution_ref, kind, status, presentation_json,
      reviewer_device_ids_json, audience_session_keys_json, runtime_epoch,
      created_at_ms, expires_at_ms, updated_at_ms
    ) VALUES (
      ?, ?, ?, 'pending', '{}', '[]', '[]', 1, 1, 1, 1
    );
  `).run(approvalId, resolutionRef, kind);
}

function expectAlterAppendedLegacyRepair(strict: boolean): void {
  const db = new DatabaseSync(":memory:");
  createAlterAppendedLegacyTable(db, strict);
  seedRow(db, "exec");

  expect(repairOperatorApprovalSchema(db)).toEqual([
    "Migrated shared state operator approvals → OpenClaw system changes",
  ]);

  expect(() => assertCanonicalOperatorApprovalKinds(db, ":memory:")).not.toThrow();
  expect(
    db.prepare("SELECT approval_id, kind, resolution_ref FROM operator_approvals").all(),
  ).toEqual([{ approval_id: "a1", kind: "exec", resolution_ref: RESOLUTION_REF }]);
  expect(
    db.prepare("SELECT strict FROM pragma_table_list WHERE name = 'operator_approvals'").get(),
  ).toEqual({ strict: 1 });
  db.close();
}

describe("repairOperatorApprovalKinds", () => {
  it("migrates the pre-v22 legacy schema and preserves issued cursor identities", () => {
    const db = openNodeSqliteDatabase(":memory:");
    db.exec(legacyTwoKindCreateSql());
    seedRow(db, "exec", RESOLUTION_REF, "z-first");
    seedRow(db, "exec", RESOLUTION_REF, "deleted-middle");
    const lastResolutionRef = "last".padEnd(43, "0");
    seedRow(db, "plugin", lastResolutionRef, "a-last");
    db.exec("DELETE FROM operator_approvals WHERE approval_id = 'deleted-middle'");
    admitSqliteSchema(db);
    expect(() => assertCanonicalOperatorApprovalKinds(db, ":memory:")).toThrow(
      "legacy operator approval schema",
    );

    expect(repairOperatorApprovalSchema(db)).toEqual([
      "Migrated shared state operator approvals → OpenClaw system changes",
    ]);

    expect(() => assertCanonicalOperatorApprovalKinds(db, ":memory:")).not.toThrow();
    const rows = db
      .prepare(
        "SELECT cursor_id, approval_id, kind, resolution_ref FROM operator_approvals ORDER BY cursor_id",
      )
      .all();
    expect(rows).toEqual([
      { cursor_id: 1, approval_id: "z-first", kind: "exec", resolution_ref: RESOLUTION_REF },
      { cursor_id: 3, approval_id: "a-last", kind: "plugin", resolution_ref: lastResolutionRef },
    ]);
    expect(() =>
      db.exec("UPDATE operator_approvals SET cursor_id = 1 WHERE approval_id = 'a-last'"),
    ).toThrow("UNIQUE constraint failed: operator_approvals.cursor_id");
    expect(
      db.prepare("SELECT strict FROM pragma_table_list WHERE name = 'operator_approvals'").get(),
    ).toEqual({ strict: 1 });
    db.close();
  });

  it("migrates the ALTER-appended non-STRICT legacy shape", () => {
    expectAlterAppendedLegacyRepair(false);
  });

  it("migrates the ALTER-appended STRICT legacy shape", () => {
    expectAlterAppendedLegacyRepair(true);
  });

  it("drops pre-ref rows that violate the canonical resolution_ref shape", () => {
    const db = new DatabaseSync(":memory:");
    createAlterAppendedLegacyTable(db, false);
    seedRow(db, "exec");
    seedRow(db, "exec", null, "a2-null-ref");
    seedRow(db, "plugin", "short", "a3-bad-ref");
    // Non-STRICT legacy tables can hold a BLOB in the TEXT column; it must be
    // filtered out or the STRICT destination insert aborts the whole repair.
    db.prepare(`
      INSERT INTO operator_approvals (
        approval_id, resolution_ref, kind, status, presentation_json,
        reviewer_device_ids_json, audience_session_keys_json, runtime_epoch,
        created_at_ms, expires_at_ms, updated_at_ms
      ) VALUES ('a4-blob-ref', ?, 'exec', 'pending', '{}', '[]', '[]', 1, 1, 1, 1);
    `).run(Buffer.from("ref0000000000000000000000000000000000000000"));

    expect(repairOperatorApprovalSchema(db)).toEqual([
      "Migrated shared state operator approvals → OpenClaw system changes",
    ]);

    expect(() => assertCanonicalOperatorApprovalKinds(db, ":memory:")).not.toThrow();
    expect(db.prepare("SELECT approval_id, resolution_ref FROM operator_approvals").all()).toEqual([
      { approval_id: "a1", resolution_ref: RESOLUTION_REF },
    ]);
    db.close();
  });

  it("reuses admitted canonical definitions without querying SQLite", () => {
    using db = openNodeSqliteDatabase(":memory:");
    db.exec(canonicalOperatorApprovalCreateSql());
    admitSqliteSchema(db);
    const observation = observeSqliteReadSql(StatementSync.prototype);
    try {
      expect(repairOperatorApprovalSchema(db)).toEqual([]);
      expect(() => assertCanonicalOperatorApprovalKinds(db, ":memory:")).not.toThrow();
      expect(observation.queries).toEqual([]);
      db.exec(`BEGIN; DROP TABLE operator_approvals; ${legacyTwoKindCreateSql()}`);
      expect(() => assertCanonicalOperatorApprovalKinds(db, ":memory:")).toThrow(
        "legacy operator approval schema",
      );
      db.exec("ROLLBACK");
      expect(() => assertCanonicalOperatorApprovalKinds(db, ":memory:")).not.toThrow();
    } finally {
      observation.restore();
    }
  });

  it("refuses to replace an arbitrarily different table", () => {
    const db = new DatabaseSync(":memory:");
    // Same column names, but a different (non-canonical) kind constraint — the
    // fail-closed guard must not copy its rows under today's schema.
    db.exec(
      legacyTwoKindCreateSql().replace(/'exec',\s*'plugin'/, "'exec', 'plugin', 'custom-thing'"),
    );
    seedRow(db, "custom-thing");

    expect(repairOperatorApprovalSchema(db)).toEqual([]);

    // The unrecognized table is left untouched.
    const rows = db.prepare("SELECT approval_id, kind FROM operator_approvals").all();
    expect(rows).toEqual([{ approval_id: "a1", kind: "custom-thing" }]);
    db.close();
  });
});
