import type { DatabaseSync, StatementSync } from "node:sqlite";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { getAdmittedSqliteSchemaFacts } from "../../infra/sqlite-schema-facts.js";
import type { SqliteWorkerBackend } from "../../infra/sqlite-worker-contract.js";
import { openOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly-open.js";
import { readSessionEntryCache } from "./session-accessor.sqlite-entry-cache.js";
import { readExactSessionEntryRowValidated } from "./session-accessor.sqlite-entry-read.js";
import { hasSqliteSessionOwnerColumns } from "./session-accessor.sqlite-owner-projection.js";

const key = "agent:main:probe";

export function measureSessionSchemaProbes(database: { agentId: string; db: DatabaseSync }) {
  const reads = {
    cache: () =>
      readSessionEntryCache(database, { cache: true, projection: "list" }).entries.get(key)
        ?.sessionId === "probe",
    exact: () =>
      readExactSessionEntryRowValidated(database, key, "list")?.entry.sessionId === "probe",
    owner: () => hasSqliteSessionOwnerColumns(database.db),
  };
  return Object.fromEntries(
    Object.entries(reads).map(([name, read]) => [name, measureRead(database.db, read)]),
  );
}

function measureRead(database: DatabaseSync, read: () => boolean) {
  read();
  read();
  const admitted = getAdmittedSqliteSchemaFacts(database) !== undefined;
  const counts = { schemaVersion: 0, userVersion: 0, dataVersion: 0 };
  const prototype = requireNodeSqlite().StatementSync.prototype;
  const restores: Array<() => void> = [];
  const instrument = <Method extends "get" | "all" | "iterate">(
    method: Method,
    wrap: (original: (typeof prototype)[Method]) => (typeof prototype)[Method],
  ) => {
    const original = prototype[method];
    prototype[method] = wrap(original);
    restores.push(() => {
      prototype[method] = original;
    });
  };
  for (const method of ["get", "all", "iterate"] as const) {
    instrument(
      method,
      (original) =>
        function (this: StatementSync, ...args: unknown[]) {
          const sql = this.sourceSQL;
          if (/\b(?:pragma_schema_version|schema_version)\b/i.test(sql)) {
            counts.schemaVersion++;
          }
          if (/\buser_version\b/i.test(sql)) {
            counts.userVersion++;
          }
          if (/\bdata_version\b/i.test(sql)) {
            counts.dataVersion++;
          }
          return Reflect.apply(original, this, args);
        },
    );
  }
  const start = performance.now();
  try {
    for (let i = 0; i < 100; i++) {
      if (!read()) {
        throw new Error("Session probe did not read the seeded session");
      }
    }
    return { admitted, ...counts, elapsedMs: performance.now() - start };
  } finally {
    for (const restore of restores) {
      restore();
    }
  }
}

export type SessionProbeOperations = {
  read: { input: undefined; output: ReturnType<typeof measureSessionSchemaProbes> };
};

export function createSqliteWorkerBackend(
  _input: unknown,
  context: { databasePath: string },
): SqliteWorkerBackend<SessionProbeOperations> {
  const opened = openOpenClawAgentDatabaseReadOnly({ agentId: "main", path: context.databasePath });
  if (!opened.found) {
    throw new Error("Session probe database is missing");
  }
  return {
    execute: () => measureSessionSchemaProbes(opened.database),
    close: opened.database.close,
  };
}
