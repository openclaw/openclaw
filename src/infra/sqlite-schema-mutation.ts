import { findSqlCharacter, normalizeSqlWhitespace } from "./sqlite-schema-sql.js";

// Conservative matching also covers multi-statement migration batches and catalog repairs.
// False positives only revoke prepared facts; SQL is still executed by SQLite unchanged.
function changesSchema(sql: string): boolean | "temp" {
  if (
    !/\b(?:CREATE|ALTER|DROP|REINDEX|VACUUM)\b|\bPRAGMA\b[\s\S]*\b(?:user_version|schema_version|writable_schema)\b[\s\S]*[=(]/i.test(
      sql,
    )
  ) {
    return false;
  }
  return changesOnlyTemporaryTable(sql) ? "temp" : true;
}

function changesOnlyTemporaryTable(sql: string): boolean {
  const normalized = normalizeSqlWhitespace(sql);
  const end = findSqlCharacter(normalized, ";");
  if (end >= 0 && normalized.slice(end + 1).trim() !== "") {
    return false;
  }
  // An unqualified DROP may resolve to MAIN; only the explicit TEMP namespace is local.
  return (
    /^CREATE\s+(?:TEMP|TEMPORARY)\s+TABLE\b/iu.test(normalized) ||
    /^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:temp|"temp"|`temp`|\[temp\])\s*\./iu.test(normalized)
  );
}

// A write to another table can change policy through a trigger.
function changesData(sql: string): boolean {
  return /\b(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql);
}

const transactionControlPrefix =
  /^(?:\s|;|--[^\n]*(?:\n|$)|\/\*(?:[^*]|\*(?!\/))*\*\/)*(BEGIN|SAVEPOINT|COMMIT|END|RELEASE|ROLLBACK)\b/i;

export type SqliteTransactionControl = { kind: string; single: boolean };

function batchTransactionControl(sql: string): SqliteTransactionControl | undefined {
  let control: string | undefined;
  let statements = 0;
  let remaining = sql;
  while (remaining) {
    if (remaining.trim()) {
      statements += 1;
    }
    const next = transactionControlPrefix.exec(remaining)?.[1]?.toUpperCase();
    if (next === "ROLLBACK") {
      control = next;
    }
    control ||= next;
    // Exec accepts batches; quoted semicolons and comments do not start statements.
    const end = remaining.includes(";") ? findSqlCharacter(remaining, ";") : -1;
    if (end < 0) {
      break;
    }
    remaining = remaining.slice(end + 1);
  }
  return control ? { kind: control, single: statements === 1 } : undefined;
}

export function canPreserveTransactionSnapshot(
  control: SqliteTransactionControl | undefined,
  inTransaction: boolean,
): boolean {
  return Boolean(
    inTransaction &&
    control?.single &&
    (control.kind === "SAVEPOINT" || control.kind === "RELEASE" || control.kind === "ROLLBACK"),
  );
}

/** Mutation hints preserve the schema owner's policy; they never certify a committed write set. */
export function classifySqliteMutation(sql: string, mode: "batch" | "statement") {
  const controlKind = transactionControlPrefix.exec(sql)?.[1]?.toUpperCase();
  return {
    schemaChange: changesSchema(sql),
    dataChange: changesData(sql),
    control:
      mode === "batch"
        ? batchTransactionControl(sql)
        : controlKind
          ? { kind: controlKind, single: true }
          : undefined,
  };
}
