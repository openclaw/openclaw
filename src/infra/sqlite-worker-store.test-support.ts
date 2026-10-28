import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, linkSync, renameSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { parentPort, threadId } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Generated } from "kysely";
import { clearNodeSqliteKyselyCacheForDatabase } from "./kysely-sync-cache-state.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import { openNodeSqliteDatabase, resolveExistingSqliteFileUri } from "./node-sqlite.js";
import { publishSqliteDatabaseAdmission } from "./sqlite-database-admission.js";
import { captureSqliteReaderOwner, type SqliteReaderOwner } from "./sqlite-reader-lifecycle.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";
import { bindSqliteWorkerDatabase } from "./sqlite-worker-binding.js";
import {
  SQLITE_WORKER_PREPARE_COMMAND,
  type SqliteWorkerPreparedBackend,
} from "./sqlite-worker-contract.js";
import { requestSqliteWorkerOperationAdmission } from "./sqlite-worker-operation-admission.js";
import { withStateDatabaseSchemaMaintenance } from "./state-database-maintenance.js";

let pendingCloses = 0;
type ReplyOwnership = { kind: string; before: number; after: number };
const replyOwnership: ReplyOwnership[] = [];
if (parentPort) {
  const postMessage = parentPort.postMessage.bind(parentPort);
  parentPort.postMessage = (...args) => {
    if (pendingCloses > 0) {
      throw new Error("Fixture close acknowledgement preceded native cleanup");
    }
    const reply: unknown = args[0];
    const bytes =
      isRecord(reply) && reply.ok === true && reply.value instanceof Uint8Array
        ? reply.value
        : undefined;
    const before = bytes?.byteLength;
    Reflect.apply(postMessage, undefined, args);
    if (bytes && before !== undefined && isRecord(reply)) {
      replyOwnership.push({
        kind: typeof reply.transfer === "string" ? reply.transfer : "inline",
        before,
        after: bytes.byteLength,
      });
    }
  };
}

export type FixtureOpenInput =
  | { type: "disk-full" }
  | { type: "link"; existingPath: string }
  | { type: "observe"; markerPath: string }
  | { type: "prepare"; markerPath: string; gatePath: string; reject?: boolean; guarded?: boolean }
  | { type: "replace"; backupPath: string; replacementPath?: string };

type Receipt = {
  actor: string;
  writes: number;
  threadId: number;
  readerOwnership?: {
    preparation: (SqliteReaderOwner | undefined)[];
    execution: SqliteReaderOwner | undefined;
  };
};
type Operation<Input, Output> = { input: Input; output: Output };
type Value = { value: string };
type DomainCommand = {
  type: "session.actor.appendTranscriptEvent" | "session.private-customer-command";
  input: Value;
};
export type FixtureOperations = {
  append: Operation<Value, Receipt>;
  "database.domain.execute": Operation<{ command: DomainCommand }, Receipt>;
  read: Operation<undefined, string[]>;
  takeReplyOwnership: Operation<undefined, ReplyOwnership[]>;
  commitThenExit: Operation<Value, never>;
  commitWithoutReceipt: Operation<Value & { mode: "native" | "schema-maintenance" }, never>;
  commitUnserializable: Operation<Value, symbol>;
  delayClose: Operation<{ markerPath: string; reject: boolean }, undefined>;
  illegalAsync: Operation<Value & { gatePath: string; reject: boolean }, Promise<Receipt>>;
};

async function waitForFile(file: string): Promise<void> {
  while (!existsSync(file)) {
    await delay(50);
  }
}

export function createSqliteWorkerBackend(
  input: FixtureOpenInput | undefined,
  context: { databasePath: string },
): SqliteWorkerPreparedBackend<FixtureOperations> {
  return createFixtureBackend(input, context.databasePath, false);
}

export function openExistingSqliteWorkerBackend(
  input: FixtureOpenInput | undefined,
  context: { databasePath: string },
): SqliteWorkerPreparedBackend<FixtureOperations> {
  return createFixtureBackend(input, context.databasePath, true);
}

function createFixtureBackend(
  input: FixtureOpenInput | undefined,
  databasePath: string,
  existingOnly: boolean,
): SqliteWorkerPreparedBackend<FixtureOperations> {
  if (input?.type === "link") {
    linkSync(input.existingPath, databasePath);
  } else if (input?.type === "observe") {
    writeFileSync(input.markerPath, "factory called");
  } else if (input?.type === "replace") {
    renameSync(databasePath, input.backupPath);
    if (input.replacementPath) {
      renameSync(input.replacementPath, databasePath);
    }
  }
  const db = openNodeSqliteDatabase(
    existingOnly ? resolveExistingSqliteFileUri(databasePath) : databasePath,
  );
  if (!existingOnly) {
    db.exec("CREATE TABLE IF NOT EXISTS entries (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
  }
  const query = getNodeSqliteKysely<{ entries: { id: Generated<number>; value: string } }>(db);
  const insert = (value: string) =>
    executeSqliteQuerySync(db, query.insertInto("entries").values({ value }));
  const actor = randomUUID();
  let writes = 0;
  let prepared = false;
  const preparationOwners: (SqliteReaderOwner | undefined)[] = [];
  let delayedClose: { markerPath: string; reject: boolean } | undefined;
  function append(value: string): Receipt {
    runSqliteImmediateTransactionSync(db, () => {
      if (input?.type === "prepare" && input.guarded) {
        requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
      }
      insert(value);
      if (input?.type === "prepare" && input.guarded) {
        requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
      }
    });
    const receipt: Receipt = { actor, writes: ++writes, threadId };
    if (input?.type === "prepare") {
      receipt.readerOwnership = {
        preparation: [...preparationOwners],
        execution: captureSqliteReaderOwner(),
      };
    }
    return receipt;
  }
  function closeNative(): undefined {
    clearNodeSqliteKyselyCacheForDatabase(db);
    db.close();
  }
  if (input?.type === "disk-full") {
    db.exec("PRAGMA journal_mode=WAL; PRAGMA max_page_count=2");
    return bindSqliteWorkerDatabase<FixtureOperations>(db, {
      execute() {
        return runSqliteImmediateTransactionSync(db, () => {
          append("x".repeat(65_536));
          throw new Error("Expected SQLITE_FULL from the bounded database");
        });
      },
      close: closeNative,
    });
  }
  return {
    [SQLITE_WORKER_PREPARE_COMMAND](commandType) {
      if (input?.type !== "prepare" || commandType !== "append" || prepared) {
        return undefined;
      }
      preparationOwners.push(captureSqliteReaderOwner());
      const waiting = waitForFile(input.gatePath);
      writeFileSync(input.markerPath, "preparing");
      return waiting.then(() => {
        preparationOwners.push(captureSqliteReaderOwner());
        if (input.reject) {
          throw new Error("Fixture code preparation failed");
        }
        prepared = true;
      });
    },
    execute(command) {
      if (command.type === "takeReplyOwnership") {
        return replyOwnership.splice(0);
      }
      if (command.type === "delayClose") {
        delayedClose = command.input;
        return undefined;
      }
      if (command.type === "illegalAsync") {
        if (command.input.reject) {
          return Promise.reject(new Error("Fixture async operation rejected"));
        }
        return waitForFile(command.input.gatePath).then(() => append(command.input.value));
      }
      if (command.type === "read") {
        return executeSqliteQuerySync(
          db,
          query.selectFrom("entries").select("value").orderBy("id"),
        ).rows.map((row) => row.value);
      }
      if (command.type === "commitWithoutReceipt") {
        // Exit inside the native call: the durable COMMIT precedes its receipt observer.
        const exec = db.exec.bind(db);
        db.exec = (sql) => {
          exec(sql);
          if (sql === "COMMIT") {
            process.exit(17);
          }
        };
        const write = () =>
          runSqliteImmediateTransactionSync(db, () => {
            insert(command.input.value);
          });
        if (command.input.mode === "schema-maintenance") {
          withStateDatabaseSchemaMaintenance({ databasePath }, write);
        } else {
          write();
        }
        throw new Error("Fixture COMMIT did not exit");
      }
      if (command.type === "database.domain.execute") {
        const inner = command.input.command;
        if (inner.type === "session.private-customer-command") {
          return runSqliteImmediateTransactionSync(db, () => {
            append(inner.input.value);
            throw new Error("Fixture transaction rolled back");
          });
        }
        return append(inner.input.value);
      }
      const receipt = append(command.input.value);
      if (command.type === "commitThenExit") {
        // Leave an outstanding native lock as well as a committed write when the worker exits.
        db.exec("BEGIN IMMEDIATE");
        process.exit(17);
      }
      if (command.type === "commitUnserializable") {
        return Symbol("unserializable committed receipt");
      }
      return receipt;
    },
    close() {
      if (delayedClose) {
        const { markerPath, reject } = delayedClose;
        pendingCloses += 1;
        return (async () => {
          try {
            await Promise.resolve();
            assert.throws(
              () => requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined }),
              /requires its retained admission/u,
            );
            publishSqliteDatabaseAdmission(
              db,
              { name: "fixture.cleanup", read: (value) => (value === true ? true : undefined) },
              true,
            );
            closeNative();
            writeFileSync(markerPath, "native database closed");
            if (reject) {
              throw Object.assign(new Error("Fixture delayed cleanup rejected"), {
                name: "FixtureCleanupError",
                code: "FIXTURE_CLEANUP_FAILED",
              });
            }
          } finally {
            pendingCloses -= 1;
          }
        })();
      }
      return closeNative();
    },
  };
}
