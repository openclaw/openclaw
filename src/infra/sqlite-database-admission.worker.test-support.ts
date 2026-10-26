import type { DatabaseSync } from "node:sqlite";
import { MessagePort, threadId } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import {
  captureSqliteDatabaseAdmissions,
  getSqliteDatabaseAdmission,
  installSqliteDatabaseAdmissions,
  publishSqliteDatabaseAdmission,
  retireSqliteDatabaseAdmissionForPath,
  withSqliteDatabaseWriteScope,
  type SqliteDatabaseAdmissionKey,
} from "./sqlite-database-admission.js";
import { admitSqliteSchema, getAdmittedSqliteSchemaFacts } from "./sqlite-schema-facts.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";
import type { SqliteWorkerBackend, SqliteWorkerCommand } from "./sqlite-worker-contract.js";
import { requestSqliteWorkerOperationAdmission } from "./sqlite-worker-operation-admission.js";

type Operation<Input, Output = undefined> = { input: Input; output: Output };
export type AdmissionOperations = {
  admitted: Operation<
    { measureHostAbsence: true } | undefined,
    { sql: string[]; threadId: number; hostLookupMessages?: number }
  >;
  hostFacts: Operation<{ path: string }, { value: number | undefined; lookupMessages: number }>;
  mutate: Operation<undefined>;
  retirePath: Operation<{ path: string }>;
  writeRows: Operation<
    { sql: string; sessionKeys?: string[]; awaitPublication?: boolean },
    { lookupMessages: number }
  >;
  mutateAfterHostAdmission: Operation<{ path: string }, { native: boolean; admitted: boolean }>;
  read: Operation<
    { path: string; awaitPublication?: boolean },
    { values: number[]; sql: string[]; threadId: number }
  >;
};

export const hostFactKey: SqliteDatabaseAdmissionKey<number> = {
  name: "admission-test-host-value",
  writer: "host",
  read: (value) => (typeof value === "number" ? value : undefined),
};
const absentHostFactKey = { ...hostFactKey, name: "admission-test-host-absent" };
const workerFactKey = {
  name: "admission-test-worker-value",
  read: hostFactKey.read,
};

function countLookupMessages(read: () => void): number {
  let messages = 0;
  // oxlint-disable-next-line typescript/unbound-method -- Retain the raw method for restoration; Reflect.apply supplies the live receiver.
  const original = MessagePort.prototype.postMessage;
  MessagePort.prototype.postMessage = function (...args) {
    const message: unknown = args[0];
    if (isRecord(message) && message.kind === "sqlite-database-admissions") {
      messages += 1;
    }
    Reflect.apply(original, this, args);
  };
  try {
    read();
    return messages;
  } finally {
    MessagePort.prototype.postMessage = original;
  }
}

function observeAdmission(database: DatabaseSync): string[] {
  const sql: string[] = [];
  const prepare = database.prepare.bind(database);
  const admissionSql =
    /sqlite_schema|PRAGMA\s+(?:schema_version|user_version|integrity_check|quick_check|foreign_key_check)\b/i;
  database.prepare = (statement) => {
    if (admissionSql.test(statement)) {
      sql.push(statement);
    }
    return prepare(statement);
  };
  try {
    admitSqliteSchema(database);
  } finally {
    database.prepare = prepare;
  }
  return sql;
}

function withDatabase<T>(location: string, readOnly: boolean, run: (db: DatabaseSync) => T): T {
  using database = openNodeSqliteDatabase(location, { readOnly });
  return run(database);
}

function countAbsentHostLookups(database: DatabaseSync): number {
  return countLookupMessages(() => {
    if (getSqliteDatabaseAdmission(database, absentHostFactKey) !== undefined) {
      throw new Error("Absent host fact unexpectedly exists");
    }
  });
}

export function createSqliteWorkerBackend(
  input: { hostBeforeAdmission?: boolean; creationPath?: string } | undefined,
  { databasePath }: { databasePath: string },
) {
  const database = openNodeSqliteDatabase(input?.creationPath ?? databasePath);
  if (input?.hostBeforeAdmission) {
    requestSqliteWorkerOperationAdmission({ stage: "prepare", facts: undefined });
  }
  const sql = observeAdmission(database);
  function execute<Key extends keyof AdmissionOperations>(command: {
    type: Key;
    input: AdmissionOperations[Key]["input"];
  }): AdmissionOperations[Key]["output"];
  function execute(command: SqliteWorkerCommand<AdmissionOperations>) {
    if (command.type === "admitted") {
      if (command.input?.measureHostAbsence) {
        publishSqliteDatabaseAdmission(database, workerFactKey, 1);
        return { sql, threadId, hostLookupMessages: countAbsentHostLookups(database) };
      }
      return { sql, threadId };
    }
    if (command.type === "retirePath") {
      retireSqliteDatabaseAdmissionForPath(command.input.path);
      return undefined;
    }
    if (command.type === "mutate") {
      database.exec("CREATE TABLE worker_publication (value)");
      return undefined;
    }
    if (command.type === "writeRows") {
      const write = () => {
        if (command.input.awaitPublication) {
          requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
        }
        return {
          lookupMessages: countLookupMessages(() => {
            const run = () => database.exec(command.input.sql);
            return command.input.sessionKeys
              ? withSqliteDatabaseWriteScope(database, command.input.sessionKeys, run)
              : run();
          }),
        };
      };
      return command.input.awaitPublication
        ? runSqliteImmediateTransactionSync(database, write)
        : write();
    }
    if (
      command.type === "mutateAfterHostAdmission" ||
      (command.type === "read" && command.input.awaitPublication)
    ) {
      requestSqliteWorkerOperationAdmission({ stage: "prepare", facts: undefined });
    }
    const location = command.input.path;
    const readOnly = command.type !== "mutateAfterHostAdmission";
    return withDatabase(location, readOnly, (reader) => {
      if (command.type === "hostFacts") {
        admitSqliteSchema(reader);
        const before = captureSqliteDatabaseAdmissions();
        requestSqliteWorkerOperationAdmission({ stage: "prepare", facts: undefined });
        // Relaying local knowledge cannot certify the host publication that just happened.
        installSqliteDatabaseAdmissions(captureSqliteDatabaseAdmissions());
        const value = getSqliteDatabaseAdmission(reader, hostFactKey);
        // An older complete snapshot cannot revoke newer completeness already received.
        installSqliteDatabaseAdmissions(before);
        return { value, lookupMessages: countAbsentHostLookups(reader) };
      }
      if (command.type === "mutateAfterHostAdmission") {
        reader.exec("CREATE TABLE worker_publication (value)");
        admitSqliteSchema(reader);
        return {
          native:
            reader
              .prepare("SELECT name FROM sqlite_schema WHERE name=?")
              .get("worker_publication") !== undefined,
          admitted: getAdmittedSqliteSchemaFacts(reader)?.tables.has("worker_publication") === true,
        };
      }
      const admissionSql = observeAdmission(reader);
      const values = reader.prepare("SELECT value FROM proof").all() as { value: number }[];
      return { values: values.map((row) => row.value), sql: admissionSql, threadId };
    });
  }
  return {
    execute,
    assertSettled() {
      if (database.isTransaction) {
        throw new Error("Admission fixture left its database transaction open");
      }
    },
    close: () => database.close(),
  } satisfies SqliteWorkerBackend<AdmissionOperations>;
}
