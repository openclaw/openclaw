import type { DatabaseSync } from "node:sqlite";
import { threadId } from "node:worker_threads";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { admitSqliteSchema, getAdmittedSqliteSchemaFacts } from "./sqlite-schema-facts.js";
import type { SqliteWorkerBackend, SqliteWorkerCommand } from "./sqlite-worker-contract.js";
import {
  requestSqliteWorkerOperationAdmission,
  takeSqliteWorkerOperationAdmissionAttachment,
} from "./sqlite-worker-operation-admission.js";

export type AdmissionOperations = {
  admitted: { input: undefined; output: { sql: string[]; threadId: number } };
  mutate: { input: undefined; output: undefined };
  writeRows: { input: { sql: string }; output: undefined };
  mutateAfterHostAdmission: {
    input: { path: string };
    output: { native: boolean; admitted: boolean };
  };
  mutateHeld: {
    input: { rollback: boolean; exit: boolean; wait?: boolean };
    output: undefined;
  };
  read: {
    input: { path: string; awaitPublication?: boolean };
    output: { values: number[]; sql: string[]; threadId: number };
  };
};

function observeAdmission(database: DatabaseSync): string[] {
  const sql: string[] = [];
  const prepare = database.prepare.bind(database);
  database.prepare = (statement) => {
    if (
      /sqlite_schema|PRAGMA\s+(?:schema_version|user_version|integrity_check|quick_check|foreign_key_check)\b/i.test(
        statement,
      )
    ) {
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

export function createSqliteWorkerBackend(
  input: { hostBeforeAdmission?: boolean; creationPath?: string } | undefined,
  { databasePath }: { databasePath: string },
) {
  const database = openNodeSqliteDatabase(input?.creationPath ?? databasePath);
  if (input?.hostBeforeAdmission) {
    requestSqliteWorkerOperationAdmission({ stage: "prepare", facts: undefined });
  }
  const sql = observeAdmission(database);
  function execute(
    command: Extract<SqliteWorkerCommand<AdmissionOperations>, { type: "admitted" }>,
  ): AdmissionOperations["admitted"]["output"];
  function execute(
    command: SqliteWorkerCommand<AdmissionOperations>,
  ): AdmissionOperations[keyof AdmissionOperations]["output"];
  function execute(command: SqliteWorkerCommand<AdmissionOperations>) {
    if (command.type === "admitted") {
      return { sql, threadId };
    }
    if (command.type === "mutate") {
      database.exec("CREATE TABLE worker_publication (value)");
      return undefined;
    }
    if (command.type === "writeRows") {
      database.exec(command.input.sql);
      return undefined;
    }
    if (command.type === "mutateAfterHostAdmission") {
      requestSqliteWorkerOperationAdmission({ stage: "prepare", facts: undefined });
      const writer = openNodeSqliteDatabase(command.input.path);
      try {
        writer.exec("CREATE TABLE worker_publication (value)");
        admitSqliteSchema(writer);
        return {
          native:
            writer
              .prepare("SELECT name FROM sqlite_schema WHERE name='worker_publication'")
              .get() !== undefined,
          admitted: getAdmittedSqliteSchemaFacts(writer)?.tables.has("worker_publication") === true,
        };
      } finally {
        writer.close();
      }
    }
    if (command.type === "mutateHeld") {
      database.function("hold_publication", () => {
        requestSqliteWorkerOperationAdmission({ stage: "prepare", facts: undefined });
        if (command.input.exit) {
          process.exit(0);
        }
        if (command.input.wait) {
          const wait = takeSqliteWorkerOperationAdmissionAttachment();
          if (!(wait instanceof SharedArrayBuffer)) {
            throw new Error("Held mutation requires its admission gate");
          }
          Atomics.wait(new Int32Array(wait), 0, 0);
        }
        return 1;
      });
      if (command.input.rollback) {
        database.exec(
          "BEGIN; CREATE TABLE worker_publication (value); SELECT hold_publication(); ROLLBACK",
        );
      } else {
        database.exec("CREATE TABLE worker_publication (value); SELECT hold_publication()");
      }
      return undefined;
    }
    if (command.input.awaitPublication) {
      requestSqliteWorkerOperationAdmission({ stage: "prepare", facts: undefined });
    }
    const reader = openNodeSqliteDatabase(command.input.path, { readOnly: true });
    try {
      const admissionSql = observeAdmission(reader);
      const values = reader.prepare("SELECT value FROM proof").all() as { value: number }[];
      return { values: values.map((row) => row.value), sql: admissionSql, threadId };
    } finally {
      reader.close();
    }
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
