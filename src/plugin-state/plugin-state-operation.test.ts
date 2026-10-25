import { existsSync, symlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import {
  observeHostDataSql,
  observeSqliteReadSql,
} from "../../test/helpers/sqlite-statement-execution-counter.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import * as admission from "../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe } from "../infra/sqlite-worker-owner-probe.test-support.js";
import { preparePluginStateRead } from "../plugin-sdk/plugin-state-runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { useState } from "./plugin-state-fixtures.test-support.js";
import { PluginStateOperationInvalidatedError } from "./plugin-state-operation-error.js";
import type { FixtureOperations } from "./plugin-state-operation.test-support.js";
import { pluginStatePublication } from "./plugin-state-publication.js";
import {
  createCorePluginStateKeyedStore,
  createPluginStateKeyedStore,
  createPluginStateSyncKeyedStore,
  replaceCorePluginStateEntry,
} from "./plugin-state-store.js";
import type { PluginStateOperation } from "./plugin-state-store.types.js";
import * as workerClient from "./plugin-state-worker-client.js";
import { executePluginStateCommand, preparePluginStateOperation } from "./plugin-state.worker.js";

const invalid = (promise: Promise<unknown>) =>
  expect(promise).rejects.toMatchObject({ code: "PLUGIN_STATE_INVALID_INPUT" });

const modulePath = fileURLToPath(
  new URL("./plugin-state-operation.test-support.ts", import.meta.url),
);
const handler = { moduleName: "plugin-state-operation.test-support.ts", exportName: "execute" };

const state = useState("plugin-state-operation");
const options = (namespace: string, env = state().env) => ({
  namespace,
  maxEntries: 10,
  env,
  overflowPolicy: "reject-new" as const,
});
const open = (namespace: string, env = state().env) =>
  createPluginStateKeyedStore<string>("operation-test", options(namespace, env), undefined, {
    resolve: () => ({
      modulePath,
      boundaryRoot: path.dirname(modulePath),
      origin: "bundled",
      pluginId: "operation-test",
    }),
  });

const read = (operation: PluginStateOperation<FixtureOperations>, store = 0) =>
  operation.execute({ type: "read", input: { store, key: "key" } }, { writeStores: [] });
const move = (
  operation: PluginStateOperation<FixtureOperations>,
  value: string,
  writeStores = [0, 1],
) => operation.execute({ type: "move", input: { value } }, { writeStores });
const single = async (namespace: string, value = "original", ttlMs?: number) => {
  const store = open(namespace);
  await store.register("key", value, { ttlMs });
  return { store, operation: store.createOperation<FixtureOperations>([store], handler) };
};
const pair = async (prefix: string, value = "original") => {
  const first = open(`${prefix}-first`);
  const second = open(`${prefix}-second`);
  await first.register("key", value);
  return {
    first,
    second,
    operation: first.createOperation<FixtureOperations>([first, second], handler),
  };
};
const afterExecute = (
  after: (...args: Parameters<typeof workerClient.executePluginStateOperationInWorker>) => unknown,
) => {
  const execute = workerClient.executePluginStateOperationInWorker;
  return vi
    .spyOn(workerClient, "executePluginStateOperationInWorker")
    .mockImplementation(async (...args) => {
      const result = await execute(...args);
      await after(...args);
      return result;
    });
};

it("moves rows across namespaces in one worker command and rolls back undeclared writes", async () => {
  const { first, second, operation } = await pair("move");
  await invalid(move(operation, "moved", [0]));
  expect(await first.lookup("key")).toBe("original");
  expect(await second.lookup("key")).toBeUndefined();
  const hostSql = observeHostDataSql();
  const facts = new Map<string, unknown>();
  const unsubscribe = pluginStatePublication.subscribeFacts((change) => {
    if (change.kind === "committed") {
      change.receipt.facts.forEach((fact, key) => facts.set(key, fact));
    }
  });
  try {
    const result = await move(operation, "moved");
    expect(result.value).toMatchObject({
      before: ["original", undefined],
      after: [undefined, "moved"],
    });
    expect(result.value.threadId).toBeGreaterThan(0);
    result.assertCurrent();
    expect(facts.get(JSON.stringify(["operation-test", "move-first", "key"]))).toEqual({
      kind: "absent",
    });
    expect(facts.get(JSON.stringify(["operation-test", "move-second", "key"]))).toMatchObject({
      kind: "postimage",
      value: { value_json: '"moved"' },
    });
    hostSql.calls.forEach((call) => expect(call).not.toHaveBeenCalled());
  } finally {
    unsubscribe();
    hostSql.restore();
  }
});

it("keeps read-only absent sources noncreating and uses only an explicit missing value", async () => {
  const env = { ...state().env, OPENCLAW_STATE_DIR: state().path("absent") };
  const store = open("absent", env);
  const operation = store.createOperation<FixtureOperations>([store], handler);
  const command = { type: "read", input: { store: 0, key: "key" } } as const;
  const receipt = await operation.execute(command, {
    writeStores: [],
    missingValue: { value: undefined, threadId: 0 },
  });
  expect(receipt.value).toEqual({ value: undefined, threadId: 0 });
  receipt.assertCurrent();
  await expect(operation.execute(command, { writeStores: [] })).rejects.toMatchObject({
    cause: { message: "Plugin state operation source does not exist" },
  });
  expect(existsSync(resolveOpenClawStateSqlitePath(env))).toBe(false);
});

it("uses one autocommit read when empty and rereads populated inputs in a snapshot", async () => {
  const { second } = await pair("empty-count");
  const input = {
    module: {
      modulePath,
      boundaryRoot: path.dirname(modulePath),
      origin: "bundled" as const,
      pluginId: "operation-test",
    },
    exportName: "execute",
    stores: ["empty-count-first", "empty-count-second"].map((namespace) => ({
      pluginId: "operation-test",
      namespace,
      maxEntries: 10,
      overflowPolicy: "reject-new" as const,
      defaultTtlMs: undefined,
    })),
    writeStores: [],
    ifEmpty: { store: 1, value: [] },
    command: { type: "entries", input: undefined },
    receiptId: "empty-count",
  };
  await preparePluginStateOperation(input);
  const database = openOpenClawStateDatabase({ env: state().env });
  const run = () =>
    executePluginStateCommand(
      { type: "pluginState.executeOperation", input },
      { path: database.path, env: state().env },
      () => database,
      true,
    );
  run();
  const statements: string[] = [];
  const reads = observeSqliteReadSql(requireNodeSqlite().StatementSync.prototype, (sql) => {
    statements.push(sql);
  });
  const exec = database.db.exec.bind(database.db);
  const transactions = vi.spyOn(database.db, "exec").mockImplementation((sql) => {
    statements.push(sql);
    return exec(sql);
  });
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(run()).toEqual({ ok: true, value: { value: [], validUntil: undefined } });
      expect(statements.splice(0)).toEqual([expect.stringContaining("plugin_state_entries")]);
    }
    await second.register("key", "delivery");
    statements.length = 0;
    expect(run()).toMatchObject({ ok: true, value: { value: [[{ value: "delivery" }], [{}]] } });
    expect(statements).toEqual([
      expect.stringContaining("plugin_state_entries"),
      "BEGIN",
      expect.stringContaining("plugin_state_entries"),
      expect.stringContaining("plugin_state_entries"),
      "COMMIT",
    ]);
  } finally {
    transactions.mockRestore();
    reads.restore();
  }
});

it("invalidates empty receipts after either watched namespace changes", async () => {
  const { first, second, operation } = await pair("empty-watch");
  const scan = () =>
    operation.execute(
      { type: "entries", input: undefined },
      { writeStores: [], watchStores: [0, 1], ifEmpty: { store: 1, value: [] } },
    );
  let receipt = await scan();
  expect(receipt.value).toEqual([]);
  await first.register("key", "changed peer");
  expect(receipt.assertCurrent).toThrow(PluginStateOperationInvalidatedError);
  receipt = await scan();
  await second.register("key", "delivery");
  expect(receipt.assertCurrent).toThrow(PluginStateOperationInvalidatedError);
  expect((await scan()).value).toMatchObject([
    [{ value: "delivery" }],
    [{ value: "changed peer" }],
  ]);
  await invalid(
    operation.execute(
      { type: "entries", input: undefined },
      { writeStores: [], ifEmpty: { store: 2, value: [] } },
    ),
  );
  await invalid(
    operation.execute(
      { type: "entries", input: undefined },
      { writeStores: [0], ifEmpty: { store: 1, value: [] } },
    ),
  );
});

it("leaves the writer free during initial grants and preserves replacement revocation", async () => {
  const { first, second, operation } = await pair("admission");
  const replacement = { ...options("replacement"), ownerId: "core:admission-test" as const };
  const core = createCorePluginStateKeyedStore<string>(replacement);
  await core.register("key", "original");
  using contention = sqliteWorkerOwnerProbe.writerLock(resolveOpenClawStateSqlitePath(state().env));
  let transactions = 0;
  let revokeAt = Number.POSITIVE_INFINITY;
  let current = true;
  sqliteWorkerOwnerProbe.admission(admission, (request, grant, admit) => {
    contention.observe(request.stage);
    if (request.stage === "transaction" && ++transactions === revokeAt) {
      current = false;
    }
    admit(request, grant);
  });

  await first.register("key", "updated");
  const moved = await move(operation, "moved");
  await replaceCorePluginStateEntry(replacement, "key", "replacement");
  expect(contention.observed).toEqual([
    "transaction:free",
    "commit:held",
    "transaction:free",
    "commit:held",
    "transaction:free",
    "commit:held",
    "transaction:free",
    "commit:held",
  ]);
  expect(moved.value).toMatchObject({
    before: ["updated", undefined],
    after: [undefined, "moved"],
  });
  expect(moved.value.threadId).toBeGreaterThan(0);
  moved.assertCurrent();
  expect(await first.lookup("key")).toBeUndefined();
  expect(await second.lookup("key")).toBe("moved");
  expect(await core.lookup("key")).toBe("replacement");

  // Replacement intentionally commits revocation before seeking its next grant.
  const offset = contention.observed.length;
  revokeAt = transactions + 2;
  await expect(
    replaceCorePluginStateEntry(replacement, "key", "forbidden", {
      assertCurrent() {
        if (!current) {
          throw new Error("replacement owner retired");
        }
      },
    }),
  ).rejects.toMatchObject({ code: "PLUGIN_STATE_WRITE_FAILED" });
  expect(contention.observed.slice(offset)).toEqual([
    "transaction:free",
    "commit:held",
    "transaction:free",
  ]);
  expect(await core.lookup("key")).toBeUndefined();
});

it("expires receipts without querying SQLite or waiting for a timer", async () => {
  const { operation } = await single("ttl", "allowed", 60_000);
  const result = await read(operation);
  result.assertCurrent();
  const afterExpiry = Date.now() + 120_000;
  vi.spyOn(Date, "now").mockReturnValue(afterExpiry);
  expect(result.assertCurrent).toThrow("no longer current");
});

it("invalidates receipts at async admission and sync commit through a directory alias", async () => {
  const namespace = "alias-authority";
  const { operation } = await single(namespace);
  const directory = state().path("state-directory-alias");
  symlinkSync(state().stateDir, directory, process.platform === "win32" ? "junction" : "dir");
  const env = { ...state().env, OPENCLAW_STATE_DIR: directory };
  const native = createPluginStateSyncKeyedStore<string>("operation-test", options(namespace, env));
  const invalidation = PluginStateOperationInvalidatedError;
  let current = await read(operation);
  current.assertCurrent();
  native.register("key", "sync successor");
  expect(current.assertCurrent).toThrow(invalidation);
  current = await read(operation);
  expect(current.value.value).toBe("sync successor");
  current.assertCurrent();
  const nextValue = "async successor";
  const pending = open(namespace, env).register("key", nextValue);
  expect(current.assertCurrent).toThrow(invalidation);
  await pending;
  current = await read(operation);
  expect(current.value.value).toBe(nextValue);
  current.assertCurrent();
  native.delete("key");
  expect(current.assertCurrent).toThrow(invalidation);
  expect((await read(operation)).value.value).toBeUndefined();
});

it("keeps scalar and receipt reads behind earlier unfinished mutations", async () => {
  const { second, operation } = await pair("fifo", "old");
  const committed = createDeferredCore();
  const release = createDeferredCore();
  afterExecute(async (input) => {
    if (input.command.type === "move") {
      committed.resolve();
      await release.promise;
    }
  });
  const write = move(operation, "committed");
  await committed.promise;
  const followingWrite = second.register("key", "following");
  const scalarRead = second.lookup("key");
  const reading = read(operation, 1);
  release.resolve();
  await write;
  await followingWrite;
  expect(await scalarRead).toBe("following");
  const receipt = await reading;
  expect(receipt.value.value).toBe("following");
  receipt.assertCurrent();
  const next = second.delete("key");
  expect(receipt.assertCurrent).toThrow(PluginStateOperationInvalidatedError);
  await next;
});

it("settles an accepted write even when its owner closes before the reply arrives", async () => {
  const first = open("settled-first");
  const second = open("settled-second");
  await first.register("key", "original");
  let current = true;
  const operation = first.createOperation<FixtureOperations>([first, second], handler, {
    assertCurrent() {
      if (!current) {
        throw new Error("owner closed after commit");
      }
    },
  });
  afterExecute(() => {
    current = false;
  });
  const receipt = await move(operation, "settled");
  expect(receipt.value.after).toEqual([undefined, "settled"]);
  expect(receipt.assertCurrent).toThrow("owner closed after commit");
  expect(await second.lookup("key")).toBe("settled");
});

it("brands recovery receipts and rejects composing a captured source with retargeted stores", async () => {
  const env = { ...state().env, OPENCLAW_STATE_DIR: state().path("source-original") };
  const store = open("source", env);
  await store.register("key", "original");
  const operation = store.createOperation<FixtureOperations>([store], handler);
  const source = await read(operation);
  const recover = (sourceReceipt = source) =>
    store.createOperation<FixtureOperations>([store], handler, {
      assertCurrent() {},
      sourceReceipt,
    });
  expect(() => recover({ ...source })).toThrow("another source or plugin");
  expect((await read(recover())).value.value).toBe("original");
  env.OPENCLAW_STATE_DIR = state().path("source-successor");
  await store.register("key", "successor");
  source.assertCurrent();
  expect((await read(operation)).value.value).toBe("original");
  expect(() => recover()).toThrow("another source or plugin");
});

it.each(["transaction", "commit"] as const)(
  "rechecks bound authority at %s and rolls back",
  async (stage) => {
    const first = open(`authority-first-${stage}`);
    const second = open(`authority-second-${stage}`);
    await first.register("key", "allowed");
    let current = true;
    const bound = second.withCurrent({
      assertCurrent() {
        if (!current) {
          throw new Error("owner retired");
        }
      },
    });
    const operation = first.createOperation<FixtureOperations>([first, bound], handler);
    const create = admission.createSqliteWorkerOperationAdmission;
    vi.spyOn(admission, "createSqliteWorkerOperationAdmission").mockImplementation(
      (admit, attachment) =>
        create((request, grant) => {
          if (request.stage === stage) {
            current = false;
          }
          admit(request, grant);
        }, attachment),
    );
    await expect(move(operation, "forbidden")).rejects.toMatchObject({
      code: "PLUGIN_STATE_WRITE_FAILED",
    });
    expect(await first.lookup("key")).toBe("allowed");
    expect(await second.lookup("key")).toBeUndefined();
  },
);

it("rejects escaped facades and rolls back a handler that returns a Promise", async () => {
  const { store, operation } = await single("lifetime");
  await operation.execute({ type: "escape", input: undefined }, { writeStores: [] });
  await invalid(operation.execute({ type: "escape", input: undefined }, { writeStores: [] }));
  const asynchronous = store.createOperation<{ invalid: { input: undefined; output: void } }>(
    [store],
    { ...handler, exportName: "asynchronousHandler" },
  );
  await invalid(asynchronous.execute({ type: "invalid", input: undefined }, { writeStores: [0] }));
  expect(await store.lookup("key")).toBe("original");
});

it("does not replay a committed command after its acknowledgement is lost", async () => {
  const { first, second, operation } = await pair("lost");
  const dispatch = afterExecute(() => {
    throw new Error("acknowledgement lost");
  });
  await expect(move(operation, "committed")).rejects.toThrow("acknowledgement lost");
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(await first.lookup("key")).toBeUndefined();
  expect(await second.lookup("key")).toBe("committed");
});

it("refuses to issue a receipt when only the result acknowledgement arrives", async () => {
  const { first, second, operation } = await pair("receipt");
  const guard = await preparePluginStateRead(first, "key");
  if (!guard) {
    throw new Error("Expected an owner-published state guard");
  }
  vi.spyOn(admission, "observeSqliteWorkerCommittedFacts").mockImplementation(() => {});
  try {
    await expect(move(operation, "committed")).rejects.toThrow("no committed receipt");
    expect(await first.lookup("key")).toBeUndefined();
    expect(await second.lookup("key")).toBe("committed");
    expect(() => guard.read()).toThrow("unavailable");
  } finally {
    guard.release();
  }
});
