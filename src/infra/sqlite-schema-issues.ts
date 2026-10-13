/** A completed inspection proved schema drift; native read failures retain their own type. */
export class SqliteSchemaMismatchError extends Error {
  override name = "SqliteSchemaMismatchError";
}

export function isSqliteSchemaMismatchError(error: unknown): boolean {
  // Native worker envelopes preserve error names without changing their wire contract.
  return error instanceof Error && error.name === "SqliteSchemaMismatchError";
}

export type SqliteSchemaIssueCode =
  | "column-definition-drift"
  | "missing-column"
  | "missing-or-drifted-index"
  | "missing-or-drifted-trigger"
  | "missing-table"
  | "table-constraint-drift"
  | "table-definition-drift"
  | "table-options-drift"
  | "unexpected-column"
  | "unexpected-trigger"
  | "unexpected-unique-index"
  | "virtual-table-definition-drift";

export type SqliteSchemaIssue = {
  code: SqliteSchemaIssueCode;
  message: string;
  objectName: string;
};

export type SqliteSchemaCompatibility = {
  /** Tables outside this inspection's view of the canonical schema, even when present. */
  excludedTables?: readonly string[];
  /** Named indexes outside the expected view; actual unexpected uniqueness still fails. */
  excludedIndexes?: readonly string[];
  /**
   * Canonical additive tables that may be absent until their owning feature
   * performs its one-time lazy ensure. Present tables still require the exact
   * canonical shape.
   */
  allowedMissingTables?: readonly string[];
  /** Same-version non-unique indexes that a writable cold open lazily repairs. */
  allowedMissingIndexes?: readonly string[];
  /** Additive columns that may be absent until their owning feature lazily ensures them. */
  allowedMissingColumns?: readonly string[];
  /**
   * Exact definitions produced by supported additive migrations when SQLite
   * requires a temporary default that the clean schema does not retain.
   */
  allowedColumnDefinitions?: Readonly<Record<string, readonly string[]>>;
  /**
   * Allow unexpected columns declared as a name plus one bare nullable SQLite
   * STRICT datatype. Allowed-missing tables remain exact when present.
   */
  allowCompatibleAdditiveColumns?: boolean;
  /**
   * Exact owner-defined trigger groups that may be absent when their derived
   * or lazily ensured schema is absent, but must be complete and canonical
   * when present.
   */
  optionalCanonicalTriggerGroups?: readonly {
    /** The trigger group is optional only while this canonical table is absent. */
    optionalWhenTableMissing?: string;
    tableName: string;
    triggers: readonly {
      name: string;
      sql: string;
    }[];
  }[];
};

const ISSUE_DESCRIPTIONS = {
  "missing-table": "missing table",
  "missing-column": "column definitions differ for",
  "unexpected-column": "column definitions differ for",
  "column-definition-drift": "column definitions differ for",
  "table-constraint-drift": "table constraints differ for",
  "table-definition-drift": "table definition differs for",
  "missing-or-drifted-index": "missing or drifted index",
  "unexpected-unique-index": "unexpected unique index",
  "missing-or-drifted-trigger": "missing or drifted trigger",
  "unexpected-trigger": "unexpected trigger",
  "virtual-table-definition-drift": "virtual table definition differs for",
  "table-options-drift": "table options differ for",
} satisfies Record<SqliteSchemaIssueCode, string>;

function isColumnIssue(code: SqliteSchemaIssueCode): boolean {
  return (
    code === "column-definition-drift" || code === "missing-column" || code === "unexpected-column"
  );
}

function defaultIssueMessage(code: SqliteSchemaIssueCode, objectName: string): string {
  if (!Object.hasOwn(ISSUE_DESCRIPTIONS, code)) {
    throw new Error("Unsupported SQLite schema issue code", { cause: code });
  }
  const target = isColumnIssue(code) ? objectName.split(".", 1)[0] : objectName;
  return `${ISSUE_DESCRIPTIONS[code]} ${target}`;
}

export function createSqliteSchemaIssue(
  code: SqliteSchemaIssueCode,
  objectName: string,
  message?: string,
): SqliteSchemaIssue {
  return { code, objectName, message: message ?? defaultIssueMessage(code, objectName) };
}

export function legacySqliteSchemaIssueMessages(issues: readonly SqliteSchemaIssue[]): string[] {
  const columnIssueTables = new Set(
    issues
      .filter((issue) => isColumnIssue(issue.code))
      .map((issue) => issue.objectName.split(".", 1)[0]),
  );
  return [
    ...new Set(
      issues
        .filter(
          (issue) =>
            issue.code !== "table-constraint-drift" || !columnIssueTables.has(issue.objectName),
        )
        .map((issue) => issue.message),
    ),
  ];
}

export function throwSqliteSchemaMismatches(
  databaseLabel: string,
  mismatches: readonly string[],
): never {
  const shown = mismatches.slice(0, 8);
  if (mismatches.length > shown.length) {
    shown.push(`${mismatches.length - shown.length} additional mismatch(es)`);
  }
  // Drift is repairable by the doctor migration owner, so the throw must name it:
  // callers surface this straight to operators, and the gateway refuses to start.
  throw new SqliteSchemaMismatchError(
    `SQLite schema is incomplete or noncanonical for ${databaseLabel}: ${shown.join("; ")}; run openclaw doctor --fix to repair it.`,
  );
}
