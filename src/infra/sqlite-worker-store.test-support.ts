import { randomUUID } from "node:crypto";
import { existsSync, linkSync, renameSync, watch, writeFileSync } from "node:fs";
import path from "node:path";
import { parentPort, threadId } from "node:worker_threads";
import type { Generated } from "kysely";
import { clearNodeSqliteKyselyCacheForDatabase } from "./kysely-sync-cache-state.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";
import type { SqliteWorkerBackend } from "./sqlite-worker-contract.js";

let pendingCloses = 0;
if (parentPort) {
  const postMessage = parentPort.postMessage.bind(parentPort);
  parentPort.postMessage = (...args) => {
    if (pendingCloses > 0) {
      throw new Error("Fixture close acknowledgement preceded native cleanup");
    }
    Reflect.apply(postMessage, undefined, args);
  };
}

export type FixtureOpenInput =
  | { type: "link"; existingPath: string }
  | { type: "replace"; backupPath: string };

type Receipt = { actor: string; writes: number; threadId: number };
export type FixtureOperations = {
  append: { input: { value: string }; output: Receipt };
  read: { input: undefined; output: string[] };
  commitThenExit: { input: { value: string }; output: never };
  commitUnserializable: { input: { value: string }; output: symbol };
  failClose: { input: undefined; output: undefined };
  delayClose: { input: { markerPath: string; reject: boolean }; output: undefined };
  illegalAsync: {
    input: { value: string; gatePath: string; reject: boolean };
    output: Promise<Receipt>;
  };
};

function waitForFile(file: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const watcher = watch(path.dirname(file), () => {
      if (existsSync(file)) {
        watcher.close();
        resolve();
      }
    });
    watcher.once("error", reject);
    if (existsSync(file)) {
      watcher.close();
      resolve();
    }
  });
}

export function createSqliteWorkerBackend(
  input: FixtureOpenInput | undefined,
  { databasePath }: { databasePath: string },
): SqliteWorkerBackend<FixtureOperations> {
  if (input?.type === "link") {
    linkSync(input.existingPath, databasePath);
  } else if (input?.type === "replace") {
    renameSync(databasePath, input.backupPath);
  }
  const db = openNodeSqliteDatabase(databasePath);
  db.exec("CREATE TABLE IF NOT EXISTS entries (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
  const query = getNodeSqliteKysely<{ entries: { id: Generated<number>; value: string } }>(db);
  const actor = randomUUID();
  let writes = 0;
  let failClose = false;
  let delayedClose: { markerPath: string; reject: boolean } | undefined;
  function append(value: string): Receipt {
    runSqliteImmediateTransactionSync(db, () => {
      executeSqliteQuerySync(db, query.insertInto("entries").values({ value }));
    });
    writes += 1;
    return { actor, writes, threadId };
  }
  function closeNative(): void {
    clearNodeSqliteKyselyCacheForDatabase(db);
    db.close();
    if (failClose) {
      throw new Error("Fixture native database closed with a cleanup failure");
    }
  }
  return {
    execute(command) {
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
        failClose = true;
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
