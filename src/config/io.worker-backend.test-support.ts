import { threadId } from "node:worker_threads";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import type { SqliteWorkerBackend } from "../infra/sqlite-worker-contract.js";

export type WorkerFixtureOperations = { threadId: { input: undefined; output: number } };

export function createSqliteWorkerBackend(
  _input: undefined,
  context: { databasePath: string },
): SqliteWorkerBackend<WorkerFixtureOperations> {
  const db = openNodeSqliteDatabase(context.databasePath);
  return { execute: () => threadId, close: () => db.close() };
}
