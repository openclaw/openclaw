import { existsSync, symlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import * as admission from "../infra/sqlite-worker-operation-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { PluginStateOperationInvalidatedError } from "./plugin-state-operation-error.js";
import type { FixtureOperations } from "./plugin-state-operation.test-support.js";
import { pluginStatePublication } from "./plugin-state-publication.js";
import {
  createPluginStateKeyedStore,
  createPluginStateSyncKeyedStore,
} from "./plugin-state-store.js";
import * as workerClient from "./plugin-state-worker-client.js";

const modulePath = fileURLToPath(
  new URL("./plugin-state-operation.test-support.ts", import.meta.url),
);
const handler = {
  moduleName: "plugin-state-operation.test-support.ts",
  exportName: "execute",
};

describe("plugin state worker operations", () => {
  let state: OpenClawTestState;
  beforeAll(async () => {
    state = await createOpenClawTestState({ label: "plugin-state-operation" });
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await closeOpenClawStateDatabaseAsync();
    await state.cleanup();
  });
  const open = (
    namespace: string,
    options: {
      maxEntries?: number;
      env?: NodeJS.ProcessEnv;
      overflowPolicy?: "reject-new" | "evict-oldest";
    } = {},
  ) =>
    createPluginStateKeyedStore<string>(
      "operation-test",
      {
        namespace,
        maxEntries: options.maxEntries ?? 10,
        env: options.env ?? state.env,
        overflowPolicy: options.overflowPolicy ?? "reject-new",
      },
      undefined,
      {
        resolve: () => ({
          modulePath,
          boundaryRoot: path.dirname(modulePath),
          origin: "bundled",
          pluginId: "operation-test",
        }),
      },
    );

  it("moves rows across namespaces in one worker command and rolls back undeclared writes", async () => {
    const first = open("move-first");
    const second = open("move-second");
    await first.register("key", "original");
    const operation = first.createOperation<FixtureOperations>([first, second], handler);
    await expect(
      operation.execute({ type: "move", input: { value: "moved" } }, { writeStores: [0] }),
    ).rejects.toMatchObject({ code: "PLUGIN_STATE_INVALID_INPUT" });
    expect(await first.lookup("key")).toBe("original");
    expect(await second.lookup("key")).toBeUndefined();
    const dispatch = vi.spyOn(workerClient, "executePluginStateOperationInWorker");
    const hostSql = observeHostDataSql();
    const committedRows = new Map<string, unknown>();
    const unsubscribe = pluginStatePublication.subscribeFacts((change) => {
      if (change.kind === "committed") {
        for (const [key, fact] of change.receipt.facts) {
          committedRows.set(key, fact);
        }
      }
    });
    try {
      const result = await operation.execute(
        { type: "move", input: { value: "moved" } },
        { writeStores: [0, 1] },
      );
      expect(result.value).toMatchObject({
        before: ["original", undefined],
        after: [undefined, "moved"],
      });
      expect(result.value.threadId).toBeGreaterThan(0);
      expect(dispatch).toHaveBeenCalledTimes(1);
      result.assertCurrent();
      expect(committedRows.get(JSON.stringify(["operation-test", "move-first", "key"]))).toEqual({
        kind: "absent",
      });
      expect(
        committedRows.get(JSON.stringify(["operation-test", "move-second", "key"])),
      ).toMatchObject({ kind: "postimage", value: { value_json: '"moved"' } });
      for (const call of hostSql.calls) {
        expect(call).not.toHaveBeenCalled();
      }
    } finally {
      unsubscribe();
      hostSql.restore();
    }
  });

  it("keeps namespace scans coherent with eviction and deletion", async () => {
    const store = open("cache", { maxEntries: 1, overflowPolicy: "evict-oldest" });
    await store.register("old", "old");
    const operation = store.createOperation<FixtureOperations>([store], handler);
    expect(
      (await operation.execute({ type: "cache", input: undefined }, { writeStores: [0] })).value,
    ).toEqual([["old"], ["new"], undefined, []]);
    expect(await store.entries()).toEqual([]);
  });

  it("keeps read-only absent sources noncreating and uses only an explicit missing value", async () => {
    const env = { ...state.env, OPENCLAW_STATE_DIR: state.path("absent") };
    const store = open("absent", { env });
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

  it("invalidates receipts before asynchronous writes queue and after synchronous adapter writes", async () => {
    const store = open("receipts");
    await store.register("key", "allowed");
    const operation = store.createOperation<FixtureOperations>([store], handler);
    const read = () =>
      operation.execute({ type: "read", input: { store: 0, key: "key" } }, { writeStores: [] });
    const before = await read();
    before.assertCurrent();
    const pending = store.register("key", "revoked");
    expect(before.assertCurrent).toThrow("no longer current");
    await pending;
    const current = await read();
    expect(current.value.value).toBe("revoked");
    current.assertCurrent();
    createPluginStateSyncKeyedStore<string>("operation-test", {
      namespace: "receipts",
      maxEntries: 10,
      overflowPolicy: "reject-new",
      env: state.env,
    }).delete("key");
    expect(current.assertCurrent).toThrow("no longer current");
    expect((await read()).value.value).toBeUndefined();
  });

  it("expires receipts without querying SQLite or waiting for a timer", async () => {
    const store = open("ttl");
    await store.register("key", "allowed", { ttlMs: 60_000 });
    const operation = store.createOperation<FixtureOperations>([store], handler);
    const result = await operation.execute(
      { type: "read", input: { store: 0, key: "key" } },
      { writeStores: [] },
    );
    result.assertCurrent();
    const afterExpiry = Date.now() + 120_000;
    vi.spyOn(Date, "now").mockReturnValue(afterExpiry);
    expect(result.assertCurrent).toThrow("no longer current");
  });

  it("invalidates canonical receipts for sync and async writes through a source alias", async () => {
    const store = open("alias-authority");
    await store.register("key", "original");
    const alias = state.path("state-directory-alias");
    symlinkSync(state.stateDir, alias, process.platform === "win32" ? "junction" : "dir");
    const aliasEnv = { ...state.env, OPENCLAW_STATE_DIR: alias };
    const operation = store.createOperation<FixtureOperations>([store], handler);
    const read = () =>
      operation.execute({ type: "read", input: { store: 0, key: "key" } }, { writeStores: [] });
    const original = await read();
    original.assertCurrent();
    createPluginStateSyncKeyedStore<string>("operation-test", {
      namespace: "alias-authority",
      maxEntries: 10,
      overflowPolicy: "reject-new",
      env: aliasEnv,
    }).register("key", "sync successor");
    expect(original.assertCurrent).toThrow(PluginStateOperationInvalidatedError);
    const current = await read();
    expect(current.value.value).toBe("sync successor");
    current.assertCurrent();
    const pending = open("alias-authority", { env: aliasEnv }).register("key", "async successor");
    expect(current.assertCurrent).toThrow(PluginStateOperationInvalidatedError);
    await pending;
    const latest = await read();
    expect(latest.value.value).toBe("async successor");
    latest.assertCurrent();
  });

  it("keeps scalar and receipt reads behind earlier unfinished mutations", async () => {
    const first = open("fifo-source");
    const second = open("fifo-destination");
    await first.register("key", "old");
    const operation = first.createOperation<FixtureOperations>([first, second], handler);
    const committed = createDeferredCore();
    const release = createDeferredCore();
    const execute = workerClient.executePluginStateOperationInWorker;
    vi.spyOn(workerClient, "executePluginStateOperationInWorker").mockImplementation(
      async (...args) => {
        const result = await execute(...args);
        if (args[0].command.type === "move") {
          committed.resolve();
          await release.promise;
        }
        return result;
      },
    );
    const write = operation.execute(
      { type: "move", input: { value: "committed" } },
      { writeStores: [0, 1] },
    );
    await committed.promise;
    const followingWrite = second.register("key", "following");
    const scalarRead = second.lookup("key");
    const read = operation.execute(
      { type: "read", input: { store: 1, key: "key" } },
      { writeStores: [] },
    );
    release.resolve();
    await write;
    await followingWrite;
    expect(await scalarRead).toBe("following");
    const receipt = await read;
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
    const execute = workerClient.executePluginStateOperationInWorker;
    vi.spyOn(workerClient, "executePluginStateOperationInWorker").mockImplementation(
      async (...args) => {
        const result = await execute(...args);
        current = false;
        return result;
      },
    );
    const receipt = await operation.execute(
      { type: "move", input: { value: "settled" } },
      { writeStores: [0, 1] },
    );
    expect(receipt.value.after).toEqual([undefined, "settled"]);
    expect(receipt.assertCurrent).toThrow("owner closed after commit");
    expect(await second.lookup("key")).toBe("settled");
  });

  it("brands recovery receipts and rejects composing a captured source with retargeted stores", async () => {
    const env = { ...state.env, OPENCLAW_STATE_DIR: state.path("source-original") };
    const store = open("source", { env });
    await store.register("key", "original");
    const operation = store.createOperation<FixtureOperations>([store], handler);
    const source = await operation.execute(
      { type: "read", input: { store: 0, key: "key" } },
      { writeStores: [] },
    );
    expect(() =>
      store.createOperation<FixtureOperations>([store], handler, {
        assertCurrent() {},
        sourceReceipt: { ...source },
      }),
    ).toThrow("another source or plugin");
    const same = store.createOperation<FixtureOperations>([store], handler, {
      assertCurrent() {},
      sourceReceipt: source,
    });
    expect(
      (await same.execute({ type: "read", input: { store: 0, key: "key" } }, { writeStores: [] }))
        .value.value,
    ).toBe("original");
    env.OPENCLAW_STATE_DIR = state.path("source-successor");
    await store.register("key", "successor");
    source.assertCurrent();
    expect(
      (
        await operation.execute(
          { type: "read", input: { store: 0, key: "key" } },
          { writeStores: [] },
        )
      ).value.value,
    ).toBe("original");
    expect(() =>
      store.createOperation<FixtureOperations>([store], handler, {
        assertCurrent() {},
        sourceReceipt: source,
      }),
    ).toThrow("another source or plugin");
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
      await expect(
        operation.execute({ type: "move", input: { value: "forbidden" } }, { writeStores: [0, 1] }),
      ).rejects.toMatchObject({ code: "PLUGIN_STATE_WRITE_FAILED" });
      expect(await first.lookup("key")).toBe("allowed");
      expect(await second.lookup("key")).toBeUndefined();
    },
  );

  it("rejects escaped facades and rolls back a handler that returns a Promise", async () => {
    const store = open("lifetime");
    await store.register("key", "original");
    const operation = store.createOperation<FixtureOperations>([store], handler);
    await operation.execute({ type: "escape", input: undefined }, { writeStores: [] });
    await expect(
      operation.execute({ type: "escape", input: undefined }, { writeStores: [] }),
    ).rejects.toMatchObject({ code: "PLUGIN_STATE_INVALID_INPUT" });
    const asynchronous = store.createOperation<{ invalid: { input: undefined; output: void } }>(
      [store],
      { ...handler, exportName: "asynchronousHandler" },
    );
    await expect(
      asynchronous.execute({ type: "invalid", input: undefined }, { writeStores: [0] }),
    ).rejects.toMatchObject({ code: "PLUGIN_STATE_INVALID_INPUT" });
    expect(await store.lookup("key")).toBe("original");
  });

  it("does not replay a committed command after its acknowledgement is lost", async () => {
    const first = open("lost-first");
    const second = open("lost-second");
    await first.register("key", "original");
    const operation = first.createOperation<FixtureOperations>([first, second], handler);
    const execute = workerClient.executePluginStateOperationInWorker;
    const dispatch = vi
      .spyOn(workerClient, "executePluginStateOperationInWorker")
      .mockImplementation(async (...args) => {
        await execute(...args);
        throw new Error("acknowledgement lost");
      });
    await expect(
      operation.execute({ type: "move", input: { value: "committed" } }, { writeStores: [0, 1] }),
    ).rejects.toThrow("acknowledgement lost");
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(await first.lookup("key")).toBeUndefined();
    expect(await second.lookup("key")).toBe("committed");
  });

  it("refuses to issue a receipt when only the result acknowledgement arrives", async () => {
    const first = open("receipt-first");
    const second = open("receipt-second");
    await first.register("key", "original");
    const operation = first.createOperation<FixtureOperations>([first, second], handler);
    vi.spyOn(admission, "observeSqliteWorkerCommittedFacts").mockImplementation(() => {});
    await expect(
      operation.execute({ type: "move", input: { value: "committed" } }, { writeStores: [0, 1] }),
    ).rejects.toThrow("no committed receipt");
    expect(await first.lookup("key")).toBeUndefined();
    expect(await second.lookup("key")).toBe("committed");
  });
});
