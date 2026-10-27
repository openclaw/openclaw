import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readConfigHealthStateInDatabase } from "../config/io.health-state.kernel.js";
import {
  acquireStateDatabaseSchemaLease,
  assertStateDatabaseAccessAllowed,
} from "../infra/gateway-state-owner.js";
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
import { withStateDatabaseSchemaMaintenance } from "../infra/state-database-maintenance.js";
import { pluginStateLookup } from "../plugin-state/plugin-state-store.sqlite.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { closeOpenClawStateDatabaseAsync } from "./openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
import {
  createSqliteWorkerBackend,
  openExistingSqliteWorkerBackend,
} from "./openclaw-state.worker.js";

let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
const backends = new Set<ReturnType<typeof createSqliteWorkerBackend>>();
const pluginKey = { pluginId: "native-borrow-fixture", namespace: "shared", key: "answer" };
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

function createExistingStateContext() {
  const databasePath = resolveOpenClawStateSqlitePath(state.env);
  mkdirSync(path.dirname(databasePath), { recursive: true });
  writeFileSync(databasePath, "");
  return captureOpenClawStateWorkerContext({ path: databasePath, env: state.env });
}

type Context = ReturnType<typeof captureOpenClawStateWorkerContext>;
function createBackend(context: Context, existing = false) {
  const databasePath = context.admission.databasePath;
  const backend = runWithSqliteWorkerStateContext(context, () =>
    existing
      ? openExistingSqliteWorkerBackend(undefined, {
          databasePath,
          existingIdentity: context.admission.identity.key,
        })
      : createSqliteWorkerBackend(undefined, { databasePath }),
  );
  backends.add(backend);
  const execute = (command: Parameters<typeof backend.execute>[0]) =>
    runWithSqliteWorkerStateContext(context, () => backend.execute(command));
  return {
    ...backend,
    execute,
    patch(configPath: string, signature: string, previous?: string) {
      const expected =
        previous === undefined
          ? null
          : {
              lastKnownGoodJson: null,
              lastPromotedGoodJson: null,
              suspiciousSignature: previous,
              updatedAtMs: 100,
            };
      return execute({
        type: "config.health.patch",
        input: {
          configPath,
          patch: { last_observed_suspicious_signature: signature },
          expected,
          updatedAtMs: expected ? 200 : 100,
        },
      });
    },
    register(value: number | { value: number }, bindAuthority = false) {
      return admitted(
        context,
        () =>
          execute({
            type: "pluginState.register",
            input: {
              ...pluginKey,
              valueJson: JSON.stringify(value),
              maxEntries: 4,
              overflowPolicy: "reject-new",
            },
          }),
        bindAuthority,
      );
    },
  };
}

function admitted<T>(context: Context, run: () => T, bindAuthority = false): T {
  const databasePath = context.admission.databasePath;
  const admission = createSqliteWorkerOperationAdmission((_request, grant) => {
    context.admission.assertCurrent();
    grant();
  });
  if (bindAuthority) {
    admission.bindDatabaseAuthority({
      databasePath: context.admission.identity.canonicalPath,
      assertRequest: context.admission.assertCurrent,
      assertAccess: () => assertStateDatabaseAccessAllowed(databasePath),
      acquireSchema: () => acquireStateDatabaseSchemaLease(databasePath),
    });
  }
  const nativePost = admission.port.postMessage.bind(admission.port);
  // Service the real grant before this same-thread backend waits synchronously.
  const dispatch = vi
    .spyOn(admission.port, "postMessage")
    .mockImplementation((message, transfer) => {
      nativePost(message, transfer);
      admission.service();
    });
  try {
    return runWithSqliteWorkerStateContext(context, () =>
      withSqliteWorkerOperationAdmission({ port: admission.port }, run),
    );
  } finally {
    dispatch.mockRestore();
    admission.finish();
  }
}

it.each(["kv", "health"] as const)(
  "retains a promoted KV actor's native handle when %s closes first",
  async (firstToClose) => {
    const context = createExistingStateContext();
    const databasePath = context.admission.databasePath;
    const kv = createBackend(context, true);
    await kv[SQLITE_WORKER_PREPARE_COMMAND]?.("pluginState.register");
    expect(pluginStateLookup(pluginKey)).toBeUndefined();
    expect(readFileSync(databasePath)).toEqual(Buffer.alloc(0));
    withStateDatabaseSchemaMaintenance({ databasePath }, () => {
      expect(kv.register({ value: 42 }, true)).toEqual({
        ok: true,
        value: undefined,
      });
    });
    const health = createBackend(context);
    await health[SQLITE_WORKER_PREPARE_COMMAND]?.("config.health.patch");
    const database = openOpenClawStateDatabase();
    const configPath = "/synthetic-native-borrow.json";
    expect(health.patch(configPath, "first")).toBe(true);

    await (firstToClose === "kv" ? kv : health).close();
    expect(database.db.isOpen).toBe(true);
    if (firstToClose === "kv") {
      expect(health.patch(configPath, "second", "first")).toBe(true);
    } else {
      expect(pluginStateLookup(pluginKey)).toEqual({ value: 42 });
    }
    await (firstToClose === "kv" ? health : kv).close();
    expect(database.db.isOpen).toBe(false);

    createBackend(captureOpenClawStateWorkerContext());
    expect(pluginStateLookup(pluginKey)).toEqual({ value: 42 });
    expect(readConfigHealthStateInDatabase(openOpenClawStateDatabase().db)).toMatchObject({
      entries: {
        [configPath]: {
          lastObservedSuspiciousSignature: firstToClose === "kv" ? "second" : "first",
        },
      },
    });
  },
);

it.each(["config.health.patch", "diagnostic.register"] as const)(
  "retains %s writes from existing-only actors until last close and durably reopens",
  async (operation) => {
    const databasePath = openOpenClawStateDatabase({ env: state.env }).path;
    await closeOpenClawStateDatabaseAsync();
    const initialBytes = readFileSync(databasePath);
    const context = captureOpenClawStateWorkerContext({ path: databasePath, env: state.env });
    const first = createBackend(context, true);
    const second = createBackend(context, true);
    await first[SQLITE_WORKER_PREPARE_COMMAND]?.("claws.install-schema-versions");
    await second[SQLITE_WORKER_PREPARE_COMMAND]?.(operation);
    expect(
      first.execute({
        type: "claws.install-schema-versions",
        input: { artifactPreservingReadOnly: false },
      }),
    ).toEqual([]);
    expect(readFileSync(databasePath)).toEqual(initialBytes);

    const scope = "tests/health-native-borrow";
    const write = (backend: typeof first, key: string) =>
      operation === "config.health.patch"
        ? backend.patch(`/${key}.json`, key)
        : admitted(context, () =>
            backend.execute({
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

    const reopened = createBackend(captureOpenClawStateWorkerContext());
    await reopened[SQLITE_WORKER_PREPARE_COMMAND]?.("claws.install-schema-versions");
    const reopenedDatabase = openOpenClawStateDatabase();
    if (operation === "config.health.patch") {
      expect(readConfigHealthStateInDatabase(reopenedDatabase.db)).toMatchObject({
        entries: {
          "/first.json": { lastObservedSuspiciousSignature: "first" },
          "/second.json": { lastObservedSuspiciousSignature: "second" },
          "/third.json": { lastObservedSuspiciousSignature: "third" },
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
