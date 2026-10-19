import type { SQLInputValue } from "node:sqlite";
import { vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { SqlConnection } from "../../infra/sql-connection.js";
import type {
  SqliteWorkerOperations,
  SqliteWorkerStore,
} from "../../infra/sqlite-worker-contract.js";
import * as workerStore from "../../infra/sqlite-worker-store.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { persistSessionTranscriptTurn } from "./session-accessor.transcript-turn.js";
import type { useReconcileWorkerObserver } from "./session-transcript-reconcile.test-support.js";

export function rows(db: SqlConnection, sql: string, ...bindings: SQLInputValue[]) {
  return db.prepare(sql).all(...bindings);
}

export function row(db: SqlConnection, sql: string, ...bindings: SQLInputValue[]) {
  return db.prepare(sql).get(...bindings);
}

export async function seedTranscript(
  scope: Parameters<typeof persistSessionTranscriptTurn>[0],
  eventId: string,
  content: string,
  parentId?: null,
) {
  await persistSessionTranscriptTurn(scope, {
    messages: [
      { eventId, ...(parentId === null ? { parentId } : {}), message: { role: "user", content } },
    ],
    touchSessionEntry: false,
  });
}

export async function closeReconcileDatabases(stateDir?: string) {
  await closeOpenClawAgentDatabasesAsync(stateDir);
  await closeOpenClawStateDatabaseAsync();
}

// Intercept only execution; preserve the real operation's admission and lifetime arguments.
export function interceptWorkerExecution(
  intercept: <Operations extends SqliteWorkerOperations>(
    execute: SqliteWorkerStore<Operations>["execute"],
  ) => SqliteWorkerStore<Operations>["execute"],
) {
  const run = workerStore.runSqliteWorkerStoreOperation;
  return vi
    .spyOn(workerStore, "runSqliteWorkerStoreOperation")
    .mockImplementation(
      <Operations extends SqliteWorkerOperations, T>(
        target: SqliteWorkerStore<Operations>,
        operation: (worker: Pick<SqliteWorkerStore<Operations>, "execute">) => T | Promise<T>,
        ...context: [
          Parameters<typeof run>[2]?,
          Parameters<typeof run>[3]?,
          Parameters<typeof run>[4]?,
        ]
      ) =>
        run(
          target,
          (worker) => operation({ execute: intercept(worker.execute.bind(worker)) }),
          ...context,
        ),
    );
}

export function holdReconcileAck(
  observer: ReturnType<typeof useReconcileWorkerObserver>,
  stage: "plan-start" | "plan-finish",
) {
  const paused = createDeferred();
  let release: (() => void) | undefined;
  observer.onTask = ({ port, observeMessage }) => {
    let holding = false;
    observeMessage((message) => {
      holding = message.type === stage;
    });
    const post = port.postMessage.bind(port);
    port.postMessage = (message, transferList) => {
      const options = Array.isArray(transferList) ? { transfer: transferList } : transferList;
      if (holding) {
        holding = false;
        release = () => post(message, options);
        paused.resolve();
      } else {
        post(message, options);
      }
    };
  };
  return { paused: paused.promise, release: () => release?.() };
}
