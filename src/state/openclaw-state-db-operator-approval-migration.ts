// Doctor-only repair for the operator approval kind constraint.
import type { DatabaseSync } from "node:sqlite";
import { getAdmittedSqliteSchemaFacts } from "../infra/sqlite-schema-facts.js";
import { SqliteSchemaMismatchError } from "../infra/sqlite-schema-issues.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

const COLUMNS = [
  "approval_id",
  "resolution_ref",
  "kind",
  "status",
  "presentation_json",
  "requested_by_device_id",
  "requested_by_client_id",
  "requested_by_device_token_auth",
  "reviewer_device_ids_json",
  "source_agent_id",
  "source_session_key",
  "source_session_id",
  "source_run_id",
  "source_tool_call_id",
  "source_tool_name",
  "audience_session_keys_json",
  "runtime_epoch",
  "created_at_ms",
  "expires_at_ms",
  "updated_at_ms",
  "decision",
  "terminal_reason",
  "resolved_at_ms",
  "resolver_kind",
  "resolver_id",
  "consumed_at_ms",
  "consumed_by",
] as const;

// Pinned pre-v22 shape: canonical DDL evolves, but destructive repair must
// continue to recognize only the historical schemas it was written for.
const LEGACY_OPERATOR_APPROVAL_CREATE_SQL = `CREATE TABLE operator_approvals (
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
  terminal_reason TEXT CHECK ( terminal_reason IN (
    'user', 'timeout', 'malformed-verdict', 'no-route', 'run-aborted',
    'gateway-restart', 'storage-corrupt' ) ),
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
    ( status = 'pending' AND decision IS NULL AND terminal_reason IS NULL AND resolved_at_ms IS NULL AND resolver_kind IS NULL AND resolver_id IS NULL AND consumed_at_ms IS NULL AND consumed_by IS NULL )
    OR ( status = 'allowed' AND decision IN ('allow-once', 'allow-always') AND terminal_reason = 'user' AND resolved_at_ms IS NOT NULL AND resolver_kind IS NOT NULL )
    OR ( status = 'denied' AND decision = 'deny' AND terminal_reason IN ('user', 'malformed-verdict', 'no-route', 'storage-corrupt') AND resolved_at_ms IS NOT NULL AND resolver_kind IS NOT NULL AND consumed_at_ms IS NULL AND consumed_by IS NULL )
    OR ( status = 'expired' AND decision = 'deny' AND terminal_reason = 'timeout' AND resolved_at_ms IS NOT NULL AND resolver_kind IS NOT NULL AND consumed_at_ms IS NULL AND consumed_by IS NULL )
    OR ( status = 'cancelled' AND decision = 'deny' AND terminal_reason IN ('run-aborted', 'gateway-restart') AND resolved_at_ms IS NOT NULL AND resolver_kind IS NOT NULL AND consumed_at_ms IS NULL AND consumed_by IS NULL )
  ),
  CHECK (
    (consumed_at_ms IS NULL AND consumed_by IS NULL)
    OR ( status = 'allowed' AND decision = 'allow-once' AND consumed_at_ms IS NOT NULL AND consumed_by IS NOT NULL )
  )
) STRICT;`;

function tableSql(db: DatabaseSync): string | undefined {
  const schema = getAdmittedSqliteSchemaFacts(db);
  if (schema) {
    return schema.tableSql.get("operator_approvals") ?? undefined;
  }
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'operator_approvals'")
    .get();
  return typeof row?.sql === "string" ? row.sql : undefined;
}

function hasCanonicalOperatorApprovalKinds(db: DatabaseSync): boolean {
  if (!tableExists(db, "operator_approvals")) {
    return true;
  }
  return /kind\s+text\s+not\s+null\s+check\s*\(\s*kind\s+in\s*\(\s*'exec'\s*,\s*'plugin'\s*,\s*'system-agent'\s*\)\s*\)/.test(
    tableSql(db)?.toLowerCase() ?? "",
  );
}

export function assertCanonicalOperatorApprovalKinds(db: DatabaseSync, pathname: string): void {
  if (!hasCanonicalOperatorApprovalKinds(db)) {
    throw new SqliteSchemaMismatchError(
      `OpenClaw state database ${pathname} has a legacy operator approval schema; run openclaw doctor --fix to migrate it.`,
    );
  }
}

export function isCanonicalOperatorApprovalKind(
  value: unknown,
): value is "exec" | "plugin" | "system-agent" {
  return value === "exec" || value === "plugin" || value === "system-agent";
}

export function detectOperatorApprovalSchemaMigration(db: DatabaseSync, path: string) {
  return hasCanonicalOperatorApprovalKinds(db)
    ? []
    : [{ kind: "operator-approvals-system-agent" as const, path }];
}

function normalizeDdl(sql: string): string {
  // sqlite_master stores the CREATE statement without a trailing semicolon.
  return sql.replace(/\s+/g, " ").trim().replace(/;$/, "");
}

function canonicalOperatorApprovalCreateSql(): string {
  const marker = "CREATE TABLE IF NOT EXISTS operator_approvals (";
  const tableTerminator = "\n) STRICT;";
  const start = OPENCLAW_STATE_SCHEMA_SQL.indexOf(marker);
  const end = OPENCLAW_STATE_SCHEMA_SQL.indexOf(tableTerminator, start);
  if (start < 0 || end < 0) {
    throw new Error("canonical operator approval schema is unavailable");
  }
  return OPENCLAW_STATE_SCHEMA_SQL.slice(start, end + tableTerminator.length);
}

function alterAppendedResolutionRefCreateSql(sql: string): string {
  const resolutionRefStart = sql.indexOf("\n  resolution_ref ");
  const followingColumnStart = sql.indexOf("\n  kind ", resolutionRefStart);
  const tailColumn = "\n  consumed_by TEXT,";
  const tailColumnStart = sql.indexOf(tailColumn, followingColumnStart);
  if (resolutionRefStart < 0 || followingColumnStart < 0 || tailColumnStart < 0) {
    throw new Error("canonical operator approval resolution reference schema is unavailable");
  }
  const withoutResolutionRef = sql.slice(0, resolutionRefStart) + sql.slice(followingColumnStart);
  return withoutResolutionRef.replace(tailColumn, `${tailColumn} resolution_ref TEXT,`);
}

// The only legacy shapes this repair may destructively replace are the exact
// prior canonical table with the two-kind constraint (before 'system-agent')
// and its shipped ALTER-appended resolution_ref variant.
// Matching column names alone is not fail-closed: a table with the same names
// but different constraints/defaults/types would get its rows copied under a
// schema that silently discards those semantics.
function hasExactLegacyOperatorApprovalSchema(db: DatabaseSync): boolean {
  const live = tableSql(db);
  if (!live) {
    return false;
  }
  const exactStrictLegacy = LEGACY_OPERATOR_APPROVAL_CREATE_SQL;
  const normalizedLive = normalizeDdl(live);
  const alterAppendedStrictLegacy = alterAppendedResolutionRefCreateSql(exactStrictLegacy);
  return [exactStrictLegacy, alterAppendedStrictLegacy].some((strictLegacy) =>
    [strictLegacy, strictLegacy.replace(/\) STRICT;$/u, ");")]
      .map(normalizeDdl)
      .includes(normalizedLive),
  );
}

function canonicalCreateSql(): string {
  return canonicalOperatorApprovalCreateSql().replace(
    "CREATE TABLE IF NOT EXISTS operator_approvals (",
    "CREATE TABLE operator_approvals_migration_new (",
  );
}

// Rebuilding the table drops its indexes. Replay only the operator-approval
// index statements: executing the full schema here fails on many-versions-
// behind databases whose other tables still lack columns the later additive
// and STRICT repairs add (e.g. "no such column: agent_id").
function operatorApprovalIndexSql(): string {
  const statements = OPENCLAW_STATE_SCHEMA_SQL.split(";")
    .map((statement) => statement.trim())
    .filter((statement) =>
      /^CREATE (?:UNIQUE )?INDEX IF NOT EXISTS idx_operator_approvals_/.test(statement),
    );
  if (statements.length === 0) {
    throw new Error("canonical operator approval index schema is unavailable");
  }
  return `${statements.join(";\n")};`;
}

function repairOperatorApprovalKinds(db: DatabaseSync): boolean {
  if (
    hasCanonicalOperatorApprovalKinds(db) ||
    tableExists(db, "operator_approvals_migration_new") ||
    !hasExactLegacyOperatorApprovalSchema(db)
  ) {
    return false;
  }
  const columns = COLUMNS.join(", ");
  // The copy/drop/rename must be atomic: a crash after DROP but before RENAME
  // would strand the rows in the temp table, and the next schema bootstrap would
  // recreate an empty canonical table and abandon them.
  runSqliteImmediateTransactionSync(db, () => {
    db.exec(canonicalCreateSql());
    // The ALTER-appended variant is nullable, so pre-ref rows can hold NULL or
    // junk that violates the canonical NOT NULL/shape CHECK. Approvals are
    // transient runtime state: drop nonconforming rows instead of aborting the
    // whole repair and re-wedging startup. The filter mirrors the canonical
    // CHECK exactly.
    // Preserve issued cursor identities, including gaps left by deleted rows.
    // sqlite-allow-raw -- Doctor-only rowid backfill into the explicit cursor column.
    db.exec(`
      INSERT INTO operator_approvals_migration_new (cursor_id, ${columns})
      SELECT rowid, ${columns} FROM operator_approvals
      WHERE typeof(resolution_ref) = 'text'
        AND length(resolution_ref) = 43
        AND resolution_ref NOT GLOB '*[^A-Za-z0-9_-]*'
      ORDER BY rowid;
      DROP TABLE operator_approvals;
      ALTER TABLE operator_approvals_migration_new RENAME TO operator_approvals;
    `);
    db.exec(operatorApprovalIndexSql());
  });
  return true;
}

export function repairOperatorApprovalSchema(db: DatabaseSync): string[] {
  return repairOperatorApprovalKinds(db)
    ? ["Migrated shared state operator approvals → OpenClaw system changes"]
    : [];
}
