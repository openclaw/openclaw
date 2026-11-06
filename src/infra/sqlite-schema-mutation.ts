import {
  findSqlCharacter,
  hasUnquotedSqlKeyword,
  normalizeSqlIdentifier,
  normalizeSqlWhitespace,
  readSqlToken,
} from "./sqlite-schema-sql.js";

function schemaStatement(sql: string): boolean {
  if (/^(?:CREATE|ALTER|DROP|REINDEX|VACUUM)\b/iu.test(sql)) {
    return true;
  }
  const catalogWrite =
    /^(?:INSERT(?: OR \w+)? INTO|UPDATE(?: OR \w+)?|DELETE FROM|REPLACE INTO)\s+/iu.exec(sql);
  if (catalogWrite) {
    const target = readSqlToken(sql, catalogWrite[0].length)?.raw ?? "";
    const name = target.slice(findSqlCharacter(target, ".") + 1);
    return ["sqlite_schema", "sqlite_master"].includes(normalizeSqlIdentifier(name));
  }
  if (!/^PRAGMA\b/iu.test(sql)) {
    return false;
  }
  const argumentsAt = [findSqlCharacter(sql, "="), findSqlCharacter(sql, "(")].filter(
    (position) => position >= 0,
  );
  if (argumentsAt.length === 0) {
    return false;
  }
  const qualified = sql.slice("PRAGMA".length, Math.min(...argumentsAt)).trim();
  const name = qualified.slice(findSqlCharacter(qualified, ".") + 1).trim();
  const pragma =
    name.startsWith("'") && name.endsWith("'")
      ? name.slice(1, -1).toLowerCase()
      : normalizeSqlIdentifier(name);
  // writable_schema changes connection parsing; only catalog writes change physical facts.
  return ["user_version", "schema_version"].includes(pragma);
}

// Statement kinds are mutation hints; quoted payloads and comments are not statements.
function changesSchema(sql: string): boolean {
  if (!/\b(?:CREATE|ALTER|DROP|REINDEX|VACUUM|PRAGMA|INSERT|UPDATE|DELETE|REPLACE)\b/iu.test(sql)) {
    return false;
  }
  let remaining = normalizeSqlWhitespace(sql);
  while (remaining) {
    remaining = remaining.replace(/^[\s;]+/u, "");
    const end = findSqlCharacter(remaining, ";");
    if (schemaStatement(end < 0 ? remaining : remaining.slice(0, end))) {
      return true;
    }
    remaining = end < 0 ? "" : remaining.slice(end + 1);
  }
  return false;
}

function createsOnlyTemporaryObject(sql: string): boolean {
  let remaining = normalizeSqlWhitespace(sql);
  const kind = /^\s*CREATE\s+(?:TEMP|TEMPORARY)\s+(TABLE|TRIGGER)\b/iu
    .exec(remaining)?.[1]
    ?.toUpperCase();
  if (!kind) {
    return false;
  }
  let end = findSqlCharacter(remaining, ";");
  if (kind === "TABLE") {
    return end < 0 || remaining.slice(end + 1).trim() === "";
  }
  // Trigger steps end with semicolons; CASE END stays within its statement.
  while (end >= 0) {
    remaining = remaining.slice(end + 1).trim();
    end = findSqlCharacter(remaining, ";");
    const step = (end < 0 ? remaining : remaining.slice(0, end)).trim();
    if (/^END$/iu.test(step)) {
      return end < 0 || remaining.slice(end + 1).trim() === "";
    }
  }
  return false;
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
  return hasUnquotedSqlKeyword(sql, /\b(?:INSERT|UPDATE|DELETE|REPLACE)\b/giu);
}

function temporaryWriteTables(sql: string): string[] | undefined {
  const tables: string[] = [];
  let remaining = normalizeSqlWhitespace(sql);
  while (remaining) {
    remaining = remaining.replace(/^[\s;]+/u, "");
    const end = findSqlCharacter(remaining, ";");
    const statement = end < 0 ? remaining : remaining.slice(0, end);
    if (changesData(statement)) {
      const target =
        /^(?:INSERT(?: OR \w+)? INTO|REPLACE INTO|UPDATE(?: OR \w+)?|DELETE FROM)\s+(?:temp|"temp"|`temp`|\[temp\])\s*\.\s*("(?:[^"]|"")+"|`(?:[^`]|``)+`|\[[^\]]+\]|[a-z_]\w*)(?=\s|\(|$)/iu.exec(
          statement,
        );
      const table = target?.[1];
      if (table === undefined) {
        return undefined;
      }
      tables.push(normalizeSqlIdentifier(table));
    }
    remaining = end < 0 ? "" : remaining.slice(end + 1);
  }
  return tables;
}

const sqlLeadingTrivia = /^(?:\s|;|--[^\n]*(?:\n|$)|\/\*(?:[^*]|\*(?!\/))*(?:\*\/|$))*/u;
const transactionControlPrefix = /^(BEGIN|SAVEPOINT|COMMIT|END|RELEASE|ROLLBACK)\b/i;

export type SqliteTransactionControl = {
  kind: string;
  single: boolean;
  /** One outer rollback with no other writes or transaction controls in the batch. */
  outerRollback: boolean;
};

function readTransactionControl(
  sql: string,
  mode: "batch" | "statement",
): SqliteTransactionControl | undefined {
  let control: string | undefined;
  let outerRollback = false;
  let otherChanges = false;
  let statements = 0;
  let remaining = sql;
  while (remaining) {
    remaining = remaining.replace(sqlLeadingTrivia, "");
    if (!remaining) {
      break;
    }
    statements += 1;
    // Exec accepts batches; quoted semicolons and comments do not start statements.
    const end = remaining.includes(";") ? findSqlCharacter(remaining, ";") : -1;
    const statement = end < 0 ? remaining : remaining.slice(0, end);
    const next = transactionControlPrefix.exec(statement)?.[1]?.toUpperCase();
    if (next === "ROLLBACK") {
      control = next;
      otherChanges ||= outerRollback;
      outerRollback = !/^ROLLBACK(?: TRANSACTION)? TO\b/iu.test(normalizeSqlWhitespace(statement));
      otherChanges ||= !outerRollback;
    } else if (
      next ||
      (!/^SELECT\b/iu.test(statement) && (changesSchema(statement) || changesData(statement)))
    ) {
      otherChanges = true;
    }
    control ||= next;
    if (end < 0 || mode === "statement") {
      break;
    }
    remaining = remaining.slice(end + 1);
  }
  return control
    ? { kind: control, single: statements === 1, outerRollback: outerRollback && !otherChanges }
    : undefined;
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

export function classifySqliteMutation(sql: string, mode: "batch" | "statement") {
  const schemaChange = changesSchema(sql);
  const dataChange = changesData(sql);
  const temporaryTableSchemaChange = schemaChange && changesOnlyTemporaryTable(sql);
  return {
    schemaChange,
    mainSchemaChange:
      schemaChange && !temporaryTableSchemaChange && !createsOnlyTemporaryObject(sql),
    temporaryTableSchemaChange,
    dataChange,
    temporaryWriteTables: dataChange ? temporaryWriteTables(sql) : undefined,
    control: readTransactionControl(sql, mode),
  };
}
