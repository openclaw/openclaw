import { existsSync, symlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { resolveDatabaseEngineSelection } from "../infra/database-engine/config.js";
import { withDatabaseEngineSelection } from "../infra/database-engine/context.js";
import * as admission from "../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe } from "../infra/sqlite-worker-owner-probe.test-support.js";
import { preparePluginStateRead } from "../plugin-sdk/plugin-state-runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { useState } from "./plugin-state-fixtures.test-support.js";
import type { PluginStateOperationInput } from "./plugin-state-operation-contract.js";
import { PluginStateOperationInvalidatedError } from "./plugin-state-operation-error.js";
import { executePluginStateOperation } from "./plugin-state-operation.kernel.js";
import type { FixtureOperations } from "./plugin-state-operation.test-support.js";
import {
  createCorePluginStateKeyedStore,
  createPluginStateKeyedStore,
  createPluginStateSyncKeyedStore,
  replaceCorePluginStateEntry,
} from "./plugin-state-store.js";
import type { PluginStateOperation } from "./plugin-state-store.types.js";
import * as workerClient from "./plugin-state-worker-client.js";

const invalid = (promise: Promise<unknown>) =>
  expect(promise).rejects.toMatchObject({ code: "PLUGIN_STATE_INVALID_INPUT" });

const modulePath = fileURLToPath(
  new URL("./plugin-state-operation.test-support.ts", import.meta.url),
);
const handler = { moduleName: "plugin-state-operation.test-support.ts", exportName: "execute" };
const moduleSource = {
  modulePath,
  boundaryRoot: path.dirname(modulePath),
  origin: "bundled" as const,
  pluginId: "operation-test",
};
const entriesCommand = { type: "entries", input: undefined } as const;
const scan = (operation: PluginStateOperation<FixtureOperations>, watchStores = [0, 1]) =>
  operation.execute(entriesCommand, {
    writeStores: [],
    watchStores,
    ifEmpty: { store: 1, value: [] },
  });

const state = useState("plugin-state-operation");
const options = (namespace: string, env = state().env) => ({
  namespace,
  maxEntries: 10,
  env,
  overflowPolicy: "reject-new" as const,
});
const open = (namespace: string, env = state().env) =>
  createPluginStateKeyedStore<string>("operation-test", options(namespace, env), undefined, {
    resolve: () => moduleSource,
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
  const result = await move(operation, "moved");
  expect(result.value).toMatchObject({
    before: ["original", undefined],
    after: [undefined, "moved"],
  });
  expect(result.value.threadId).toBeGreaterThan(0);
  expect(await first.lookup("key")).toBeUndefined();
  expect(await second.lookup("key")).toBe("moved");
  result.assertCurrent();
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

it("invalidates empty receipts after either watched namespace changes", async () =>
  withDatabaseEngineSelection(await resolveDatabaseEngineSelection({}), async () => {
    const { first, second, operation } = await pair("empty-watch");
    let receipt = await scan(operation);
    expect(receipt.value).toEqual([]);
    receipt.value.push([]);
    expect((await scan(operation)).value).toEqual([]);
    await first.register("key", "changed peer");
    expect(receipt.assertCurrent).toThrow(PluginStateOperationInvalidatedError);
    receipt = await scan(operation);
    await second.register("key", "delivery");
    expect(receipt.assertCurrent).toThrow(PluginStateOperationInvalidatedError);
    expect((await scan(operation)).value).toMatchObject([
      [{ value: "delivery" }],
      [{ value: "changed peer" }],
    ]);
    await invalid(
      operation.execute(entriesCommand, { writeStores: [], ifEmpty: { store: 2, value: [] } }),
    );
    await invalid(
      operation.execute(entriesCommand, { writeStores: [0], ifEmpty: { store: 1, value: [] } }),
    );
  }));

it("decodes only live requested snapshot rows and retains expiry across clock corrections", () => {
  const input: PluginStateOperationInput = {
    module: moduleSource,
    exportName: "execute",
    stores: [
      {
        pluginId: "operation-test",
        namespace: "raw-snapshot",
        maxEntries: 10,
        overflowPolicy: "reject-new",
        defaultTtlMs: undefined,
      },
    ],
    writeStores: [],
    command: { type: "read", input: undefined },
    receiptId: "raw-snapshot",
    namespaceSnapshots: {
      '["operation-test","raw-snapshot"]': [
        { entry_key: "key", value_json: '"current"', created_at: 1, expires_at: 3_000 },
        {
          entry_key: "expired-corrupt",
          value_json: "invalid JSON",
          created_at: 2,
          expires_at: 500,
        },
        { entry_key: "backward", value_json: '"earlier"', created_at: 3, expires_at: 1_000 },
      ],
    },
  };
  const now = vi.spyOn(Date, "now").mockReturnValue(2_000);
  expect(
    executePluginStateOperation(undefined, input, (_command, tx) => tx.lookup(0, "key")),
  ).toEqual({ value: "current", validUntil: 3_000 });
  expect(executePluginStateOperation(undefined, input, (_command, tx) => tx.entries(0))).toEqual({
    value: [{ key: "key", value: "current", createdAt: 1, expiresAt: 3_000 }],
    validUntil: 3_000,
  });
  now.mockReturnValue(750);
  expect(
    executePluginStateOperation(undefined, input, (_command, tx) =>
      tx.lookupMany([{ store: 0, key: "backward" }]),
    ),
  ).toEqual({ value: ["earlier"], validUntil: 1_000 });
  now.mockReturnValue(250);
  expect(() =>
    executePluginStateOperation(undefined, input, (_command, tx) =>
      tx.lookup(0, "expired-corrupt"),
    ),
  ).toThrowError(expect.objectContaining({ code: "PLUGIN_STATE_CORRUPT", operation: "lookup" }));
});

it("waits for an earlier write to the empty target even when it is not watched", async () =>
  withDatabaseEngineSelection(await resolveDatabaseEngineSelection({}), async () => {
    const { first, second, operation } = await pair("empty-target-order");
    expect((await scan(operation, [0])).value).toEqual([]);
    const entered = createDeferredCore();
    const release = createDeferredCore();
    sqliteWorkerOwnerProbe.command(
      await import("../state/openclaw-state-worker-store.js"),
      async (command, commandOptions, scope) => {
        if (command.type === "pluginState.register") {
          entered.resolve();
          await release.promise;
        }
        return scope.execute(command, commandOptions);
      },
    );
    const writing = second.register("key", "delivery");
    await entered.promise;
    const reading = scan(operation, [0]);
    release.resolve();
    await writing;
    expect((await reading).value).toMatchObject([[{ value: "delivery" }], [{ value: "original" }]]);
    expect(await first.lookup("key")).toBe("original");
  }));

it("validates a new handler even when another operation confirmed an empty namespace", async () =>
  withDatabaseEngineSelection(await resolveDatabaseEngineSelection({}), async () => {
    const { first, second, operation } = await pair("empty-preparation");
    const readOptions = { writeStores: [], ifEmpty: { store: 1, value: [] } };
    expect((await operation.execute(entriesCommand, readOptions)).value).toEqual([]);
    const invalidOperation = first.createOperation<FixtureOperations>([first, second], {
      ...handler,
      exportName: "missingHandler",
    });
    await expect(invalidOperation.execute(entriesCommand, readOptions)).rejects.toMatchObject({
      code: "PLUGIN_STATE_WRITE_FAILED",
    });
  }));

it("leaves the writer free during initial grants and preserves replacement revocation", async () => {
  const { first, operation } = await pair("admission");
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
  await move(operation, "moved");
  await replaceCorePluginStateEntry(replacement, "key", "replacement");
  expect(contention.observed).toEqual(
    Array.from({ length: 4 }, () => ["transaction:free", "commit:held"]).flat(),
  );
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
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 120_000);
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
    const { first, second } = await pair(`authority-${stage}`, "allowed");
    let current = true;
    const bound = second.withCurrent({
      assertCurrent() {
        if (!current) {
          throw new Error("owner retired");
        }
      },
    });
    const operation = first.createOperation<FixtureOperations>([first, bound], handler);
    sqliteWorkerOwnerProbe.admission(admission, (request, grant, admit) => {
      if (request.stage === stage) {
        current = false;
      }
      admit(request, grant);
    });
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
