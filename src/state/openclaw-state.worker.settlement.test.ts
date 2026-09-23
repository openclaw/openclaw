import { existsSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getNodeSqliteKysely, iterateSqliteQuerySync } from "../infra/kysely-sync.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { runWithSqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { closeOpenClawStateDatabaseAsync } from "./openclaw-state-db-cache.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { withExistingOpenClawStateSchema } from "./openclaw-state-db-schema-policy.js";
import { openOpenClawStateDatabase } from "./openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
import {
  createSqliteWorkerBackend,
  openExistingSqliteWorkerBackend,
} from "./openclaw-state.worker.js";

let state: OpenClawTestState;
beforeEach(async () => {
  state = await createOpenClawTestState({ prefix: "openclaw-worker-settlement-", applyEnv: true });
});
afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  await state.cleanup();
});

it("admits a worker operation after the previous turn's schema probe expires", async () => {
  vi.useFakeTimers({ toFake: ["setImmediate"] });
  const context = captureOpenClawStateWorkerContext();
  const backend = runWithSqliteWorkerStateContext(context, () =>
    createSqliteWorkerBackend(undefined, { databasePath: context.admission.databasePath }),
  );
  const peer = new (requireNodeSqlite().DatabaseSync)(context.admission.databasePath);
  try {
    peer.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION + 1}`);
    const command = { type: "database.inspectIdle" as const, input: undefined };
    const result = Promise.resolve(backend.prepare?.(command))
      .then(() => runWithSqliteWorkerStateContext(context, () => backend.execute(command)))
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    await Promise.resolve();
    vi.runOnlyPendingTimers();
    expect(await result).toMatchObject({
      message: expect.stringContaining("newer schema version"),
    });
  } finally {
    peer.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION}`);
    peer.close();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    await backend.close();
  }
});

it("retires an existing-only idle actor without opening its missing database", async () => {
  const context = captureOpenClawStateWorkerContext();
  const backend = runWithSqliteWorkerStateContext(context, () =>
    openExistingSqliteWorkerBackend(undefined, { databasePath: context.admission.databasePath }),
  );
  try {
    expect(backend.execute({ type: "database.inspectIdle", input: undefined })).toBe("retire");
    expect(existsSync(context.admission.databasePath)).toBe(false);
  } finally {
    await backend.close();
  }
});

it("does not checkpoint a retained existing-schema actor during idle inspection", async () => {
  const databasePath = openOpenClawStateDatabase().path;
  await closeOpenClawStateDatabaseAsync();
  await withExistingOpenClawStateSchema({ path: databasePath }, async () => {
    const context = captureOpenClawStateWorkerContext();
    const backend = runWithSqliteWorkerStateContext(context, () =>
      createSqliteWorkerBackend(undefined, { databasePath }),
    );
    const { db } = openOpenClawStateDatabase();
    const { constants } = requireNodeSqlite();
    const checkpoints: string[] = [];
    db.setAuthorizer((action, name) => {
      if (action === constants.SQLITE_PRAGMA && name === "wal_checkpoint") {
        checkpoints.push(name);
      }
      return constants.SQLITE_OK;
    });
    try {
      expect(backend.execute({ type: "database.inspectIdle", input: undefined })).toBe("retire");
      expect(checkpoints).toEqual([]);
    } finally {
      db.setAuthorizer(null);
      await backend.close();
    }
  });
});

it("rejects leaked readers and unfinished transactions through the same actor settlement hook", async () => {
  const context = captureOpenClawStateWorkerContext();
  const backend = runWithSqliteWorkerStateContext(context, () =>
    createSqliteWorkerBackend(undefined, { databasePath: context.admission.databasePath }),
  );
  const { db } = openOpenClawStateDatabase();
  const query = getNodeSqliteKysely<{ schema_meta: { schema_version: number } }>(db)
    .selectFrom("schema_meta")
    .select("schema_version");
  const reader = iterateSqliteQuerySync(db, query);
  try {
    expect(() => backend.assertSettled!()).not.toThrow();
    expect(reader.next().done).toBe(false);
    expect(db.isTransaction).toBe(false);
    expect(() => backend.assertSettled!()).toThrow("active SQLite reader");
    reader.return?.();
    expect(() => backend.assertSettled!()).not.toThrow();
    db.exec("BEGIN");
    expect(() => backend.assertSettled!()).toThrow("unsettled transaction");
    db.exec("ROLLBACK");
    expect(() => backend.assertSettled!()).not.toThrow();
  } finally {
    reader.return?.();
    if (db.isTransaction) {
      db.exec("ROLLBACK");
    }
    await backend.close();
  }
});
