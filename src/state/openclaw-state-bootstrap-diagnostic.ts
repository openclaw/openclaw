// Temporary PR #195370 capture; remove after the single hosted diagnostic run.
import { createHash } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { threadId } from "node:worker_threads";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { getSqliteDatabaseAdmission } from "../infra/sqlite-database-admission.js";
import { schemaAdmission, type SqliteSchemaFacts } from "../infra/sqlite-schema-admission.js";
import { sqliteSchemaOwners } from "../infra/sqlite-schema-scope.js";
import { peekStateSchemaVersionForDiagnostic } from "./openclaw-state-db-admission.js";

const LIMIT = 8192;
const unavailable = { captureError: "unavailable" } as const;
function read<T>(operation: () => T): T | typeof unavailable {
  try {
    return operation();
  } catch {
    return unavailable;
  }
}
function catalog(entries: string[], total = entries.length) {
  entries.sort();
  return {
    entries: entries.slice(0, 8).map((entry) => entry.slice(0, 64)),
    total,
    truncated: Math.max(0, total - 8),
    shortenedNames: entries.slice(0, 8).filter((entry) => entry.length > 64).length,
  };
}
function schema(facts: SqliteSchemaFacts | undefined) {
  return facts
    ? {
        admissionId: facts.admissionId.slice(0, 80),
        userVersion: facts.userVersion,
        revision: facts.revision,
        schemaVersion: facts.schemaVersion,
        catalog: catalog([
          ...[...facts.tables].map((name) => "table:" + name),
          ...[...facts.indexes].map((name) => "index:" + name),
          ...[...facts.views].map((name) => "view:" + name),
          ...[...facts.triggers.keys()].map((name) => "trigger:" + name),
        ]),
      }
    : { captureError: "absent" };
}

/** Observe only the already-refused connection; never refresh admission or alter its outcome. */
export function captureBootstrapRefusal(
  db: DatabaseSync,
  pathname: string,
  previousVersion: number,
): Error {
  try {
    // Copy passive cache facts before any physical query. The ordinary getters can refresh them.
    const cachedVersion = peekStateSchemaVersionForDiagnostic(db);
    const cachedSchema = schema(sqliteSchemaOwners.get(db)?.facts);
    const inTransaction = db.isTransaction;
    const admittedSchema = inTransaction
      ? read(() =>
          schema(
            getSqliteDatabaseAdmission(db, schemaAdmission, { existingOnly: true, refresh: false }),
          ),
        )
      : { captureError: "no-active-transaction" };
    const context = {
      previousVersion,
      bootstrapAccepted: false,
      cachedVersion,
      cachedSchema,
      admittedSchema,
      isOpen: db.isOpen,
      inTransaction,
      threadId,
      pathHash: createHash("sha256").update(pathname).digest("hex").slice(0, 16),
    };
    // Bypass only the observation wrappers, not database authority: these are fixed read-only SQL.
    const native = requireNodeSqlite();
    const get = (sql: string, ...bindings: SQLInputValue[]) => {
      const statement = native.DatabaseSync.prototype.prepare.call(db, sql);
      return statement.get(...bindings);
    };
    const all = (sql: string) => {
      const statement = native.DatabaseSync.prototype.prepare.call(db, sql);
      return statement.all();
    };
    const pragma = (name: "user_version" | "schema_version" | "data_version") =>
      read(() => {
        const value = get("PRAGMA " + name)?.[name];
        return typeof value === "number" && Number.isSafeInteger(value) ? value : unavailable;
      });
    const table = (name: "schema_meta" | "state_leases") =>
      read(() => {
        const exists =
          get("SELECT 1 FROM main.sqlite_schema WHERE type = 'table' AND name = ?", name) !==
          undefined;
        return {
          exists,
          hasAnyRow: exists ? get("SELECT 1 FROM main." + name + " LIMIT 1") !== undefined : false,
        };
      });
    const contentMarker = read(() => {
      if (
        !get(
          "SELECT 1 FROM main.sqlite_schema WHERE type = 'table' AND name = 'config_machine_state'",
        )
      ) {
        return "absent";
      }
      const value = get(
        "SELECT value_json FROM main.config_machine_state WHERE state_key = 'state.schema.contentVersion'",
      )?.value_json;
      if (value === undefined) {
        return "absent";
      }
      if (typeof value !== "string" || value.length > 64) {
        return "invalid-or-oversized";
      }
      try {
        const parsed: unknown = JSON.parse(value);
        return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : "non-numeric";
      } catch {
        return "invalid-json";
      }
    });
    const physical = {
      userVersion: pragma("user_version"),
      schemaVersion: pragma("schema_version"),
      dataVersion: pragma("data_version"),
      catalog: read(() => {
        const objects = all(
          "SELECT type || ':' || name AS object FROM main.sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name LIMIT 65",
        );
        const count = get(
          "SELECT COUNT(*) AS count FROM main.sqlite_schema WHERE name NOT LIKE 'sqlite_%'",
        )?.count;
        if (typeof count !== "number" || !Number.isSafeInteger(count)) {
          throw new Error("catalog count unavailable");
        }
        return catalog(
          objects.flatMap((row) => (typeof row.object === "string" ? [row.object] : [])),
          count,
        );
      }),
      schemaMeta: table("schema_meta"),
      stateLeases: table("state_leases"),
      contentMarker,
    };
    let message = JSON.stringify({ kind: "pr195370-bootstrap-refusal", ...context, physical });
    // Keep valid JSON even if unusual quoted catalog identifiers exhaust the envelope.
    if (message.length > LIMIT) {
      message = JSON.stringify({
        kind: "pr195370-bootstrap-refusal",
        previousVersion,
        threadId,
        captureError: "envelope-limit",
        capturedLength: message.length,
      });
    }
    return new Error(message);
  } catch {
    return new Error('{"kind":"pr195370-bootstrap-refusal","captureError":"snapshot-failed"}');
  }
}
