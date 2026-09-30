import { randomUUID } from "node:crypto";
import { existsSync, linkSync, renameSync, writeFileSync } from "node:fs";
import { parentPort, threadId } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Generated } from "kysely";
import { clearNodeSqliteKyselyCacheForDatabase } from "./kysely-sync-cache-state.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import { openNodeSqliteDatabase, resolveExistingSqliteFileUri } from "./node-sqlite.js";
import { captureSqliteReaderOwner, type SqliteReaderOwner } from "./sqlite-reader-lifecycle.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";
import {
  SQLITE_WORKER_PREPARE_COMMAND,
  type SqliteWorkerPreparedBackend,
} from "./sqlite-worker-contract.js";
import { requestSqliteWorkerOperationAdmission } from "./sqlite-worker-operation-admission.js";

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
export type FixtureOperations = {
  append: { input: { value: string }; output: Receipt };
  read: { input: undefined; output: string[] };
  takeReplyOwnership: { input: undefined; output: ReplyOwnership[] };
  commitThenExit: { input: { value: string }; output: never };
  commitUnserializable: { input: { value: string }; output: symbol };
  failClose: { input: { aggregate: boolean } | undefined; output: undefined };
  delayClose: { input: { markerPath: string; reject: boolean }; output: undefined };
  illegalAsync: {
    input: { value: string; gatePath: string; reject: boolean };
    output: Promise<Receipt>;
  };
};

function waitForFile(file: string): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      if (existsSync(file)) {
        clearInterval(poll);
        resolve();
      }
    };
    // Worker watch notifications can be missed or coalesced; observe the persistent gate.
    const poll = setInterval(check, 50);
    check();
  });
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
  const actor = randomUUID();
  let writes = 0;
  let prepared = false;
  const preparationOwners: (SqliteReaderOwner | undefined)[] = [];
  let failClose: { aggregate: boolean } | undefined;
  let delayedClose: { markerPath: string; reject: boolean } | undefined;
  function append(value: string): Receipt {
    runSqliteImmediateTransactionSync(db, () => {
      if (input?.type === "prepare" && input.guarded) {
        requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
      }
      executeSqliteQuerySync(db, query.insertInto("entries").values({ value }));
      if (input?.type === "prepare" && input.guarded) {
        requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
      }
    });
    writes += 1;
    return {
      actor,
      writes,
      threadId,
      ...(input?.type === "prepare"
        ? {
            readerOwnership: {
              preparation: [...preparationOwners],
              execution: captureSqliteReaderOwner(),
            },
          }
        : {}),
    };
  }
  function closeNative(): void {
    clearNodeSqliteKyselyCacheForDatabase(db);
    db.close();
    if (failClose) {
      const cause = Object.assign(
        new Error("Fixture native close detail Authorization: Bearer synthetic-close-secret"),
        { code: "SQLITE_BUSY", errcode: 5, errno: -16 },
      );
      const failure = new Error("Fixture native database closed with a cleanup failure", { cause });
      throw failClose.aggregate
        ? new AggregateError([failure, cause], "Fixture database cleanup aggregate", {
            cause: failure,
          })
        : failure;
    }
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
      if (command.type === "failClose") {
        failClose = command.input ?? { aggregate: false };
        return undefined;
      }
      if (command.type === "read") {
        return executeSqliteQuerySync(
          db,
          query.selectFrom("entries").select("value").orderBy("id"),
        ).rows.map((row) => row.value);
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
