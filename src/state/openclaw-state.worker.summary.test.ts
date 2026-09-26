import { existsSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createSqliteAuditRecordKernel,
  prepareSqliteAuditRecord,
} from "../infra/sqlite-audit-record.kernel.js";
import { SQLITE_WORKER_PREPARE_COMMAND } from "../infra/sqlite-worker-contract.js";
import {
  createSqliteWorkerOperationAdmission,
  withSqliteWorkerOperationAdmission,
} from "../infra/sqlite-worker-operation-admission.js";
import { runWithSqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { closeOpenClawStateDatabaseAsync } from "./openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "./openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
import {
  createSqliteWorkerBackend,
  openExistingSqliteWorkerBackend,
} from "./openclaw-state.worker.js";

let state: OpenClawTestState;
const backends = new Set<ReturnType<typeof createSqliteWorkerBackend>>();
beforeEach(async () => {
  state = await createOpenClawTestState({ prefix: "openclaw-native-handles-", applyEnv: true });
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const backend of backends) {
    await backend.close();
  }
  backends.clear();
  await closeOpenClawStateDatabaseAsync();
  await state.cleanup();
});

it("retains the shared native handle until its last actor closes and preserves rows on reopen", async () => {
  const context = captureOpenClawStateWorkerContext();
  const first = runWithSqliteWorkerStateContext(context, () =>
    createSqliteWorkerBackend(undefined, { databasePath: context.admission.databasePath }),
  );
  const second = runWithSqliteWorkerStateContext(context, () =>
    openExistingSqliteWorkerBackend(undefined, { databasePath: context.admission.databasePath }),
  );
  backends.add(first).add(second);
  await first[SQLITE_WORKER_PREPARE_COMMAND]?.("pluginState.register");
  await second[SQLITE_WORKER_PREPARE_COMMAND]?.("pluginState.lookup");
  const database = openOpenClawStateDatabase();
  const key = { pluginId: "native-borrow-fixture", namespace: "shared", key: "answer" };
  const register = (backend: typeof first, value: number) => {
    const stages: string[] = [];
    const admission = createSqliteWorkerOperationAdmission((request, grant) => {
      stages.push(request.stage);
      context.admission.assertCurrent();
      grant();
    });
    const nativePost = admission.port.postMessage.bind(admission.port);
    // Service the real grant on this thread before the native backend waits synchronously.
    const dispatch = vi
      .spyOn(admission.port, "postMessage")
      .mockImplementation((message, transferList) => {
        nativePost(message, transferList);
        admission.service();
      });
    try {
      const result = runWithSqliteWorkerStateContext(context, () =>
        withSqliteWorkerOperationAdmission({ port: admission.port }, () =>
          backend.execute({
            type: "pluginState.register",
            input: {
              ...key,
              valueJson: JSON.stringify(value),
              maxEntries: 4,
              overflowPolicy: "reject-new",
            },
          }),
        ),
      );
      expect(stages).toEqual(["transaction", "commit"]);
      return result;
    } finally {
      dispatch.mockRestore();
      admission.finish();
    }
  };
  expect(register(first, 1)).toEqual({ ok: true, value: undefined });
  // A read-only lookup does not borrow the native writer; promote this actor before closing its sibling.
  expect(register(second, 1)).toEqual({ ok: true, value: undefined });
  expect(
    runWithSqliteWorkerStateContext(context, () =>
      second.execute({ type: "pluginState.lookup", input: key }),
    ),
  ).toEqual({ ok: true, value: 1 });

  await first.close();
  expect(database.db.isOpen).toBe(true);
  expect(register(second, 2)).toEqual({ ok: true, value: undefined });
  await second.close();
  expect(database.db.isOpen).toBe(false);

  const reopenedContext = captureOpenClawStateWorkerContext();
  const reopened = runWithSqliteWorkerStateContext(reopenedContext, () =>
    createSqliteWorkerBackend(undefined, { databasePath: reopenedContext.admission.databasePath }),
  );
  backends.add(reopened);
  await reopened[SQLITE_WORKER_PREPARE_COMMAND]?.("pluginState.lookup");
  expect(
    runWithSqliteWorkerStateContext(reopenedContext, () =>
      reopened.execute({ type: "pluginState.lookup", input: key }),
    ),
  ).toEqual({ ok: true, value: 2 });
});

it.each(["kv", "health"] as const)(
  "retains a promoted KV actor's native handle when %s closes first",
  async (firstToClose) => {
    const context = captureOpenClawStateWorkerContext();
    const databasePath = context.admission.databasePath;
    const key = { pluginId: "borrow-fixture", namespace: "shared", key: "answer" };
    const kv = runWithSqliteWorkerStateContext(context, () =>
      openExistingSqliteWorkerBackend(undefined, { databasePath }),
    );
    backends.add(kv);
    await kv[SQLITE_WORKER_PREPARE_COMMAND]?.("pluginState.lookup");
    expect(
      runWithSqliteWorkerStateContext(context, () =>
        kv.execute({ type: "pluginState.lookup", input: key }),
      ),
    ).toEqual({ ok: true, value: undefined });
    expect(existsSync(databasePath)).toBe(false);
    const stages: string[] = [];
    const admission = createSqliteWorkerOperationAdmission((request, grant) => {
      stages.push(request.stage);
      context.admission.assertCurrent();
      grant();
    });
    const nativePost = admission.port.postMessage.bind(admission.port);
    // Both native backends share this thread; service the real grant before its synchronous wait.
    const dispatch = vi
      .spyOn(admission.port, "postMessage")
      .mockImplementation((message, transferList) => {
        nativePost(message, transferList);
        admission.service();
      });
    try {
      expect(
        runWithSqliteWorkerStateContext(context, () =>
          withSqliteWorkerOperationAdmission({ port: admission.port }, () =>
            kv.execute({
              type: "pluginState.register",
              input: {
                ...key,
                valueJson: JSON.stringify({ value: 42 }),
                maxEntries: 4,
                overflowPolicy: "reject-new",
              },
            }),
          ),
        ),
      ).toEqual({ ok: true, value: undefined });
      expect(stages).toEqual(["transaction", "commit"]);
    } finally {
      dispatch.mockRestore();
      admission.finish();
    }
    const health = runWithSqliteWorkerStateContext(context, () =>
      createSqliteWorkerBackend(undefined, { databasePath }),
    );
    backends.add(health);
    await health[SQLITE_WORKER_PREPARE_COMMAND]?.("config.health.patch");
    const database = openOpenClawStateDatabase();
    const configPath = "/synthetic-native-borrow.json";
    expect(
      runWithSqliteWorkerStateContext(context, () =>
        health.execute({
          type: "config.health.patch",
          input: {
            configPath,
            patch: { last_observed_suspicious_signature: "first" },
            expected: null,
            updatedAtMs: 100,
          },
        }),
      ),
    ).toBe(true);

    await (firstToClose === "kv" ? kv : health).close();
    expect(database.db.isOpen).toBe(true);
    if (firstToClose === "kv") {
      expect(
        runWithSqliteWorkerStateContext(context, () =>
          health.execute({
            type: "config.health.patch",
            input: {
              configPath,
              patch: { last_observed_suspicious_signature: "second" },
              expected: {
                lastKnownGoodJson: null,
                lastPromotedGoodJson: null,
                suspiciousSignature: "first",
                updatedAtMs: 100,
              },
              updatedAtMs: 200,
            },
          }),
        ),
      ).toBe(true);
    } else {
      expect(
        runWithSqliteWorkerStateContext(context, () =>
          kv.execute({ type: "pluginState.lookup", input: key }),
        ),
      ).toEqual({ ok: true, value: { value: 42 } });
    }
    await (firstToClose === "kv" ? health : kv).close();
    expect(database.db.isOpen).toBe(false);

    const reopenedContext = captureOpenClawStateWorkerContext();
    const reopened = runWithSqliteWorkerStateContext(reopenedContext, () =>
      createSqliteWorkerBackend(undefined, { databasePath }),
    );
    backends.add(reopened);
    await reopened[SQLITE_WORKER_PREPARE_COMMAND]?.("pluginState.lookup");
    expect(
      runWithSqliteWorkerStateContext(reopenedContext, () =>
        reopened.execute({ type: "pluginState.lookup", input: key }),
      ),
    ).toEqual({ ok: true, value: { value: 42 } });
    expect(
      runWithSqliteWorkerStateContext(reopenedContext, () =>
        reopened.execute({ type: "config.health.read", input: { artifactPreserving: false } }),
      ),
    ).toMatchObject({
      state: {
        entries: {
          [configPath]: {
            lastObservedSuspiciousSignature: firstToClose === "kv" ? "second" : "first",
          },
        },
      },
    });
  },
);

it.each(["config.health.patch", "diagnostic.register"] as const)(
  "retains %s writes from existing-only actors until last close and durably reopens",
  async (operation) => {
    const context = captureOpenClawStateWorkerContext();
    const first = runWithSqliteWorkerStateContext(context, () =>
      openExistingSqliteWorkerBackend(undefined, { databasePath: context.admission.databasePath }),
    );
    const second = runWithSqliteWorkerStateContext(context, () =>
      openExistingSqliteWorkerBackend(undefined, { databasePath: context.admission.databasePath }),
    );
    backends.add(first).add(second);
    await first[SQLITE_WORKER_PREPARE_COMMAND]?.("config.health.read");
    await second[SQLITE_WORKER_PREPARE_COMMAND]?.(operation);
    expect(
      runWithSqliteWorkerStateContext(context, () =>
        first.execute({ type: "config.health.read", input: { artifactPreserving: false } }),
      ),
    ).toEqual({ state: {}, basis: {} });
    expect(existsSync(context.admission.databasePath)).toBe(false);

    const scope = "tests/health-native-borrow";
    const write = (backend: typeof first, key: string) =>
      runWithSqliteWorkerStateContext(context, () =>
        operation === "config.health.patch"
          ? backend.execute({
              type: operation,
              input: {
                configPath: `/${key}.json`,
                patch: { last_observed_suspicious_signature: key },
                expected: null,
                updatedAtMs: 100,
              },
            })
          : backend.execute({
              type: operation,
              input: {
                scope,
                maxEntries: 10,
                record: prepareSqliteAuditRecord(scope, {
                  key,
                  value: { marker: key },
                  createdAt: 100,
                }),
              },
            }),
      );
    const expectedResult = operation === "config.health.patch" ? true : undefined;
    expect(write(first, "first")).toBe(expectedResult);
    expect(write(second, "second")).toBe(expectedResult);
    const database = openOpenClawStateDatabase();
    await first.close();
    expect(database.db.isOpen).toBe(true);
    expect(write(second, "third")).toBe(expectedResult);
    await second.close();
    expect(database.db.isOpen).toBe(false);

    const reopenedContext = captureOpenClawStateWorkerContext();
    const reopened = runWithSqliteWorkerStateContext(reopenedContext, () =>
      createSqliteWorkerBackend(undefined, {
        databasePath: reopenedContext.admission.databasePath,
      }),
    );
    backends.add(reopened);
    await reopened[SQLITE_WORKER_PREPARE_COMMAND]?.("config.health.read");
    const reopenedDatabase = openOpenClawStateDatabase();
    if (operation === "config.health.patch") {
      expect(
        runWithSqliteWorkerStateContext(reopenedContext, () =>
          reopened.execute({ type: "config.health.read", input: { artifactPreserving: false } }),
        ),
      ).toMatchObject({
        state: {
          entries: {
            "/first.json": { lastObservedSuspiciousSignature: "first" },
            "/second.json": { lastObservedSuspiciousSignature: "second" },
            "/third.json": { lastObservedSuspiciousSignature: "third" },
          },
        },
      });
    } else {
      expect(
        createSqliteAuditRecordKernel(reopenedDatabase.db, { scope, maxEntries: 10 }).entries(),
      ).toEqual([
        { key: "first", value: { marker: "first" }, createdAt: 100 },
        { key: "second", value: { marker: "second" }, createdAt: 100 },
        { key: "third", value: { marker: "third" }, createdAt: 100 },
      ]);
    }
    await reopened.close();
    expect(reopenedDatabase.db.isOpen).toBe(false);
  },
);
