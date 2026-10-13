import type { DatabaseSync, StatementSync } from "node:sqlite";
import { MessagePort } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { publishSqliteDatabaseAdmission } from "../../infra/sqlite-database-admission.js";
import { getAdmittedSqliteSchemaFacts } from "../../infra/sqlite-schema-facts.js";
import type { SqliteWorkerBackend } from "../../infra/sqlite-worker-contract.js";
import { requestSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import { openOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly-open.js";
import { readSessionEntryCache } from "./session-accessor.sqlite-entry-cache.js";
import { readExactSessionEntryRowValidated } from "./session-accessor.sqlite-entry-read.js";
import { hasSqliteSessionOwnerColumns } from "./session-accessor.sqlite-owner-projection.js";
import { readCanonicalSessionMainKey } from "./session-canonical-key.js";

const key = "agent:main:probe";

export function measureSessionSchemaProbes(
  database: { agentId: string; db: DatabaseSync },
  label?: string,
) {
  const reads = {
    cache: () => {
      const entry = readSessionEntryCache(database, {
        cache: true,
        projection: "list",
      }).entries.get(key);
      return entry?.sessionId === "probe" && entry.label === label;
    },
    exact: () => {
      const entry = readExactSessionEntryRowValidated(database, key, "list")?.entry;
      return entry?.sessionId === "probe" && entry.label === label;
    },
    owner: () => hasSqliteSessionOwnerColumns(database.db),
  };
  return Object.fromEntries(
    Object.entries(reads).map(([name, read]) => [
      name,
      measureSqliteSchemaProbes(database.db, read),
    ]),
  );
}

export function measureSqliteSchemaProbes(database: DatabaseSync, read: () => boolean) {
  read();
  read();
  const admitted = getAdmittedSqliteSchemaFacts(database) !== undefined;
  if (!admitted) {
    throw new Error("Schema probe measurement requires an admitted handle without an authorizer");
  }
  const counts = { schemaVersion: 0, userVersion: 0, dataVersion: 0 };
  const native = requireNodeSqlite();
  const prototype = native.StatementSync.prototype;
  const restores: Array<() => void> = [];
  let observingTablePragmas = false;
  // These synthetic handles have no native authorizer. Preserve the owner's setter
  // wrappers: using them for this passive observer would disable admitted caches.
  native.DatabaseSync.prototype.setAuthorizer.call(database, (action, name) => {
    if (observingTablePragmas && action === native.constants.SQLITE_PRAGMA) {
      if (name === "schema_version") {
        counts.schemaVersion++;
      } else if (name === "user_version") {
        counts.userVersion++;
      } else if (name === "data_version") {
        counts.dataVersion++;
      }
    }
    return native.constants.SQLITE_OK;
  });
  restores.push(() => native.DatabaseSync.prototype.setAuthorizer.call(database, null));
  const tablePragmas = (sql: string) => /\bpragma_(?:schema|user|data)_version\s*\(/i.test(sql);
  const recordStatement = (sql: string) => {
    // Table-valued pragmas authorize when SQLite evaluates them, so a skipped
    // CASE branch costs no probe. Cached direct pragmas still count every step.
    if (tablePragmas(sql)) {
      return;
    }
    if (/\b(?:pragma_schema_version|schema_version)\b/i.test(sql)) {
      counts.schemaVersion++;
    }
    if (/\buser_version\b/i.test(sql)) {
      counts.userVersion++;
    }
    if (/\bdata_version\b/i.test(sql)) {
      counts.dataVersion++;
    }
  };
  const observeStep = <T>(sql: string, step: () => T): T => {
    const previous = observingTablePragmas;
    observingTablePragmas = tablePragmas(sql);
    try {
      return step();
    } finally {
      observingTablePragmas = previous;
    }
  };
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
  for (const method of ["get", "all"] as const) {
    instrument(
      method,
      (original) =>
        function (this: StatementSync, ...args: unknown[]) {
          const sql = this.sourceSQL;
          recordStatement(sql);
          return observeStep(sql, () => Reflect.apply(original, this, args));
        },
    );
  }
  instrument(
    "iterate",
    (original) =>
      function* (this: StatementSync, ...args: unknown[]) {
        const sql = this.sourceSQL;
        recordStatement(sql);
        const rows: ReturnType<StatementSync["iterate"]> = observeStep(sql, () =>
          Reflect.apply(original, this, args),
        );
        try {
          while (true) {
            const next = observeStep(sql, () => rows.next());
            if (next.done) {
              return next.value;
            }
            yield next.value;
          }
        } finally {
          observeStep(sql, () => rows.return?.());
        }
      },
  );
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
  read: {
    input: { label?: string } | undefined;
    output: ReturnType<typeof measureSessionSchemaProbes>;
  };
  mainKey: {
    input: { yieldAfterRead: true } | undefined;
    output: { mainKey: string; statements: number };
  };
  mainKeyLookupTraffic: {
    input: { path: string };
    output: { mainKeys: string[]; lookupMessages: number; workerPublishRefused: boolean };
  };
};

function measureMainKeyLookupTraffic(path: string) {
  const opened = openOpenClawAgentDatabaseReadOnly({ agentId: "main", path });
  if (!opened.found) {
    throw new Error("Main-key traffic database is missing");
  }
  const fact = {
    name: "session-probe-unrelated",
    read: (value: unknown) => (typeof value === "number" ? value : undefined),
  };
  const mainKeys: string[] = [];
  let lookupMessages = 0;
  let observingLookup = false;
  let workerPublishRefused = false;
  // oxlint-disable-next-line typescript/unbound-method -- Retain the raw method for restoration; Reflect.apply supplies the live receiver.
  const original = MessagePort.prototype.postMessage;
  MessagePort.prototype.postMessage = function (...args) {
    const message: unknown = args[0];
    if (observingLookup && isRecord(message) && message.kind === "sqlite-database-admissions") {
      lookupMessages += 1;
    }
    Reflect.apply(original, this, args);
  };
  try {
    readCanonicalSessionMainKey(opened.database);
    for (let index = 0; index < 3; index += 1) {
      publishSqliteDatabaseAdmission(opened.database.db, fact, index);
      observingLookup = true;
      mainKeys.push(readCanonicalSessionMainKey(opened.database));
      observingLookup = false;
    }
    try {
      publishSqliteDatabaseAdmission(opened.database.db, { ...fact, writer: "host" }, 4);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.message !== "SQLite host-owned admission facts require the host publisher"
      ) {
        throw error;
      }
      workerPublishRefused = true;
    }
    return { mainKeys, lookupMessages, workerPublishRefused };
  } finally {
    MessagePort.prototype.postMessage = original;
    opened.database.close();
  }
}

export function createSqliteWorkerBackend(
  _input: unknown,
  context: { databasePath: string },
): SqliteWorkerBackend<SessionProbeOperations> {
  const opened = openOpenClawAgentDatabaseReadOnly({ agentId: "main", path: context.databasePath });
  if (!opened.found) {
    throw new Error("Session probe database is missing");
  }
  return {
    execute(command) {
      if (command.type === "read") {
        return measureSessionSchemaProbes(opened.database, command.input?.label);
      }
      if (command.type === "mainKeyLookupTraffic") {
        return measureMainKeyLookupTraffic(command.input.path);
      }
      const prototype = requireNodeSqlite().StatementSync.prototype;
      // oxlint-disable-next-line typescript/unbound-method -- Retain the raw method for restoration; Reflect.apply supplies the live receiver.
      const original = prototype.get;
      let statements = 0;
      prototype.get = function (...args) {
        const row = Reflect.apply(original, this, args);
        if (this.sourceSQL.includes('from "session_key_contract"')) {
          statements += 1;
          if (command.input?.yieldAfterRead) {
            requestSqliteWorkerOperationAdmission({ stage: "prepare", facts: "main-key-read" });
          }
        }
        return row;
      };
      try {
        return { mainKey: readCanonicalSessionMainKey(opened.database), statements };
      } finally {
        prototype.get = original;
      }
    },
    close: opened.database.close,
  };
}
