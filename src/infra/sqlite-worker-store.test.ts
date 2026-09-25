import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  link,
  mkdir,
  readFile,
  readdir,
  rename,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { createDeferredCore } from "../shared/deferred.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { createNodeEvalArgs } from "../test-utils/node-process.js";
import { formatErrorMessageWithCode } from "./errors.js";
import { tryAcquireExclusiveSqliteCoordinator } from "./sqlite-coordinator.js";
import { captureCoordinatorDatabase } from "./sqlite-coordinator.test-support.js";
import {
  SQLITE_WORKER_MAX_RESULT_BYTES,
  type SqliteWorkerReply,
} from "./sqlite-worker-contract.js";
import {
  useSqliteWorkerStoreFixture,
  appendWorkerRow as append,
  readWorkerRows as read,
} from "./sqlite-worker-fixture.test-support.js";
import {
  openSharedStateSqliteWorkerStore,
  closeUnclaimedSharedStateSqliteWorkers,
  hasUnclaimedSharedStateSqliteCleanup,
  type SqliteWorkerStore,
} from "./sqlite-worker-store.js";
import type { FixtureOpenInput, FixtureOperations } from "./sqlite-worker-store.test-support.js";
import { SQLITE_WORKER_TRANSFER_FRAME_BYTES } from "./sqlite-worker-transfer.js";
import * as coordinatorOwner from "./state-database-coordinator.js";
import { getTrackedWorkerCpuSources } from "./worker-cpu.js";

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  availableParallelism: () => 32,
}));

const { stores, tempDirs, databasePath, open, openWithGateway } = useSqliteWorkerStoreFixture(
  "openclaw-sqlite-worker-store-",
);

async function expectRejectedOpen(
  file: string,
  input?: FixtureOpenInput,
  code?: string,
): Promise<void> {
  const [result] = await Promise.allSettled([open(file, input)]);
  if (result.status === "fulfilled") {
    await result.value.close();
    stores.delete(result.value);
  }
  expect(result.status).toBe("rejected");
  if (code) {
    expect(result).toMatchObject({ reason: { code } });
  }
}

const nodeIt = process.versions.bun ? it.skip : it;

describe("SQLite worker store", () => {
  it("registers storage-worker CPU sources until native close", async () => {
    const initial = getTrackedWorkerCpuSources();
    const store = await open(databasePath());
    const opened = getTrackedWorkerCpuSources();
    expect(opened.workers).toHaveLength(initial.workers.length + 1);
    await store.close();
    expect(getTrackedWorkerCpuSources().workers).toEqual(initial.workers);
    expect(getTrackedWorkerCpuSources().revision).toBeGreaterThan(opened.revision);
  });
  it.each(["read", "client close", "global close", "abort", "failed frame"] as const)(
    "preserves a complete large result through %s",
    async (action) => {
      const file = databasePath();
      const store = await open(file);
      const values = Array.from(
        { length: 3 },
        (_, index) => `${"x".repeat(24 * 1024 * 1024)}é-${index}`,
      );
      const digest = (value: string) => createHash("sha256").update(value).digest("hex");
      const inlineReplies: string[][] = [];
      const frames: Array<{ bytes: number; backingBytes: number }> = [];
      const aborted = new AbortController();
      let closing: Promise<void> | undefined;
      // oxlint-disable-next-line typescript/unbound-method -- Reflect.apply preserves the emitting worker below.
      const originalEmit = Worker.prototype.emit;
      const messages = vi.spyOn(Worker.prototype, "emit").mockImplementation(function (
        this: Worker,
        event: string | symbol,
        reply: SqliteWorkerReply,
      ) {
        if (event === "message" && reply.ok) {
          if (!reply.transfer) {
            inlineReplies.push(Object.keys(reply).toSorted());
          } else if (reply.transfer === "frame") {
            frames.push({
              bytes: reply.value.byteLength,
              backingBytes: reply.value.buffer.byteLength,
            });
            if (frames.length === 1) {
              if (action === "client close") {
                closing = store.close();
              }
              if (action === "global close") {
                closing = drainGlobalSingletonLifecycleState("restart");
              }
              if (action === "abort") {
                aborted.abort(new Error("Canceled after read dispatch"));
              }
              if (action === "failed frame") {
                return Reflect.apply(originalEmit, this, [
                  event,
                  { ...reply, value: new Uint8Array([0]) },
                ]);
              }
            }
          }
        }
        return Reflect.apply(originalEmit, this, [event, reply]);
      });
      const requests = vi.spyOn(Worker.prototype, "postMessage");
      try {
        for (const value of values) {
          await append(store, value);
        }
        expect(inlineReplies).toEqual(values.map(() => ["id", "ok", "value"]));
        requests.mockClear();
        const reading = store.execute(
          { type: "read", input: undefined },
          { signal: aborted.signal },
        );
        if (action === "failed frame") {
          const queued = append(store, "must not be dispatched");
          expect(await Promise.allSettled([reading, queued])).toEqual([
            { status: "rejected", reason: expect.objectContaining({ code: "outcome-unknown" }) },
            { status: "rejected", reason: expect.objectContaining({ code: "unavailable" }) },
          ]);
        } else {
          const result = await reading;
          expect(result).toHaveLength(values.length);
          expect(result.map(digest)).toEqual(values.map(digest));
          expect(frames.length).toBeGreaterThan(8);
          if (action.endsWith("close")) {
            expect(closing).toBeDefined();
          }
          if (action === "abort") {
            expect(aborted.signal.aborted).toBe(true);
          }
          await closing;
        }
        expect(requests.mock.calls.filter(([request]) => request.type === "execute")).toHaveLength(
          1,
        );
        expect(
          frames.every((frame) => frame.bytes <= SQLITE_WORKER_TRANSFER_FRAME_BYTES + 1024),
        ).toBe(true);
        expect(frames.every((frame) => frame.backingBytes <= SQLITE_WORKER_MAX_RESULT_BYTES)).toBe(
          true,
        );
        if (action === "read") {
          const ownership = await store.execute({ type: "takeReplyOwnership", input: undefined });
          expect(ownership.some((reply) => reply.kind === "inline")).toBe(true);
          expect(ownership.filter((reply) => reply.kind === "frame")).toHaveLength(frames.length);
          for (const reply of ownership) {
            expect(reply.before).toBeGreaterThan(0);
            expect.soft(reply.after, `${reply.kind} reply (${reply.before} bytes)`).toBe(0);
          }
        }
      } finally {
        messages.mockRestore();
        requests.mockRestore();
        await Promise.allSettled([closing, store.close()]);
        stores.delete(store);
      }
      if (action === "failed frame") {
        const recovered = await open(file);
        expect((await read(recovered)).map(digest)).toEqual(values.map(digest));
        expect(await append(recovered, "after recovery")).toMatchObject({ writes: 1 });
      }
    },
  );

  it("retains failed-factory custody for explicit cleanup when no Store escapes", async () => {
    const file = databasePath();
    const root = path.dirname(file);
    const modulePath = path.join(root, "failed-open.mjs");
    await writeFile(
      modulePath,
      `
      import { DatabaseSync } from "node:sqlite";
      export function createSqliteWorkerBackend(_input, context) {
        const database = new DatabaseSync(context.databasePath);
        database.close();
        throw new Error("Fixture factory failed after creating its database");
      }
    `,
    );
    const unrelatedPath = databasePath();
    const unrelated = await openWithGateway(unrelatedPath);
    const { result: gateway, database } = captureCoordinatorDatabase(() =>
      coordinatorOwner.acquireGatewayLifecycleCoordinator({
        databasePath: file,
        runtimeDirectory: root,
      }),
    );
    const close = vi.spyOn(database, "close").mockImplementationOnce(() => {
      throw new Error("Fixture native close remains open");
    });
    let requests = vi.spyOn(Worker.prototype, "postMessage").mockImplementationOnce(function (
      this: Worker,
      ...args
    ) {
      requests.mockRestore();
      const result = this.postMessage(...args);
      gateway.release();
      return result;
    });
    try {
      await expect(
        openSharedStateSqliteWorkerStore(
          {
            moduleUrl: pathToFileURL(modulePath),
            databasePath: file,
          },
          {
            environment: { OPENCLAW_STATE_DIR: root },
            coordinatorRuntime: { directory: root, keepAlive: false },
          },
        ),
      ).rejects.toThrow();
      expect(database.isOpen).toBe(true);
      expect(hasUnclaimedSharedStateSqliteCleanup(file)).toBe(true);
      await expect(open(file)).rejects.toThrow("close the existing store first");
      requests = vi.spyOn(Worker.prototype, "postMessage");
      await closeUnclaimedSharedStateSqliteWorkers(file);
      await closeUnclaimedSharedStateSqliteWorkers(unrelatedPath);
      expect(requests).not.toHaveBeenCalled();
      expect(database.isOpen).toBe(false);
      expect(hasUnclaimedSharedStateSqliteCleanup(file)).toBe(false);
      expect(close).toHaveBeenCalledTimes(2);
      await expect(append(unrelated.store, "unrelated actor remains open")).resolves.toMatchObject({
        writes: 1,
      });
      await expect(append(await open(file), "after orphan cleanup")).resolves.toMatchObject({
        writes: 1,
      });
    } finally {
      requests.mockRestore();
      close.mockRestore();
      await closeUnclaimedSharedStateSqliteWorkers(file);
      gateway.release();
      unrelated.gateway.release();
    }
  });

  it.each(["store", "host"] as const)(
    "retries an open native Gateway pin through explicit %s cleanup after worker exit",
    async (owner) => {
      const file = databasePath();
      const { result, database } = captureCoordinatorDatabase(() => openWithGateway(file));
      const { store, gateway } = await result;
      gateway.release();
      const close = vi.spyOn(database, "close").mockImplementationOnce(() => {
        throw new Error("Fixture native close remains open");
      });
      const cleanup = () =>
        owner === "store" ? store.close() : drainGlobalSingletonLifecycleState();
      const requests = vi.spyOn(Worker.prototype, "postMessage");
      try {
        await expect(cleanup()).rejects.toThrow();
        expect(database.isOpen).toBe(true);
        expect(close).toHaveBeenCalledTimes(1);
        await expect(read(store)).rejects.toMatchObject({ code: "closed" });
        await expect(open(file)).rejects.toThrow("cleanup is pending");
        requests.mockClear();
        await expect(cleanup()).resolves.toBeUndefined();
        expect(database.isOpen).toBe(false);
        expect(close).toHaveBeenCalledTimes(2);
        expect(requests).not.toHaveBeenCalled();
        await expect(store.close()).resolves.toBeUndefined();
        const recovered = await open(file);
        await expect(append(recovered, "after cleanup retry")).resolves.toMatchObject({
          writes: 1,
        });
      } finally {
        requests.mockRestore();
        close.mockRestore();
        await Promise.allSettled([cleanup(), store.close()]);
        stores.delete(store);
        gateway.release();
      }
    },
  );

  it("releases delegated Gateway pins when a rejected async command retires its worker", async () => {
    const file = databasePath();
    const { store, gateway } = await openWithGateway(file);
    gateway.release();
    try {
      const failed = store.execute({
        type: "illegalAsync",
        input: { value: "unused", gatePath: file, reject: true },
      });
      const queued = read(store);
      expect(await Promise.allSettled([failed, queued])).toEqual([
        { status: "rejected", reason: expect.objectContaining({ code: "outcome-unknown" }) },
        { status: "rejected", reason: expect.objectContaining({ code: "unavailable" }) },
      ]);
      const next = tryAcquireExclusiveSqliteCoordinator(gateway.path);
      expect(next).not.toBeNull();
      next?.release();
    } finally {
      await Promise.allSettled([store.close()]);
      stores.delete(store);
      gateway.release();
    }
  });

  it("retires an empty worker even when its Gateway pin reports a cleanup failure", async () => {
    const createDelegate = coordinatorOwner.tryCreateGatewaySchemaFenceDelegate;
    const delegation = vi
      .spyOn(coordinatorOwner, "tryCreateGatewaySchemaFenceDelegate")
      .mockImplementationOnce((params) => {
        const original = createDelegate(params);
        assert(original, "Fixture Gateway delegate was not acquired");
        return {
          port: original.port,
          get closed() {
            return original.closed;
          },
          release() {
            original.release();
            throw new Error("Fixture Gateway pin cleanup failed");
          },
        };
      });
    const file = databasePath();
    const { store, gateway } = await openWithGateway(file);
    gateway.release();
    const events = vi.spyOn(Worker.prototype, "emit");
    try {
      await expect(store.close()).rejects.toThrow("Fixture Gateway pin cleanup failed");
      expect(events.mock.calls.some(([event]) => event === "exit")).toBe(true);
      await expect(store.close()).resolves.toBeUndefined();
      await expect(append(await open(file), "after completed cleanup")).resolves.toMatchObject({
        writes: 1,
      });
    } finally {
      const worker = events.mock.contexts.find((context) => context instanceof Worker);
      await worker?.terminate();
      events.mockRestore();
      delegation.mockRestore();
      await Promise.allSettled([store.close()]);
      stores.delete(store);
      gateway.release();
    }
  });

  it.for(["memory", "absolute memory", "memory URI", "incognito", "empty"] as const)(
    "rejects a %s locator before creating a file or dispatching a worker request",
    async (kind, { signal }) => {
      const directory = tempDirs.make("openclaw-sqlite-worker-locator-");
      const incognito = resolveIncognitoOpenClawAgentSqlitePath({
        agentId: "fixture",
        env: { OPENCLAW_STATE_DIR: directory },
      });
      await mkdir(path.dirname(incognito), { recursive: true });
      const locators = {
        memory: ":memory:",
        "absolute memory": path.join(directory, ":memory:"),
        "memory URI": "file:memory-test?mode=memory&cache=shared",
        incognito,
        empty: "",
      };
      const contents = (await readdir(directory, { recursive: true })).toSorted();
      // A regressed broker can create a file from a memory locator; its child owns that cwd.
      const result = await runNodeScript(
        createNodeEvalArgs(
          `import assert from "node:assert/strict";
           import { Worker } from "node:worker_threads";
           import { openSqliteWorkerStore } from ${JSON.stringify(new URL("./sqlite-worker-store.ts", import.meta.url).href)};
           const originalPostMessage = Worker.prototype.postMessage;
           let requests = 0;
           Worker.prototype.postMessage = function (...args) {
             requests += 1;
             return Reflect.apply(originalPostMessage, this, args);
           };
           try {
             const [result] = await Promise.allSettled([openSqliteWorkerStore({
               moduleUrl: new URL(${JSON.stringify(new URL("./sqlite-worker-store.test-support.ts", import.meta.url).href)}),
               databasePath: ${JSON.stringify(locators[kind])},
             })]);
             if (result.status === "fulfilled") await result.value.close();
             assert.equal(result.status, "rejected");
             assert.match(result.reason.message, /file-backed|memory|incognito/i);
             assert.equal(requests, 0);
           } finally {
             Worker.prototype.postMessage = originalPostMessage;
           }`,
          { imports: [import.meta.resolve("tsx/esm")] },
        ),
        {
          ...process.env,
          TSX_TSCONFIG_PATH: fileURLToPath(new URL("../../tsconfig.json", import.meta.url)),
        },
        undefined,
        { cwd: directory, signal, requireProcessTreeExit: process.platform !== "win32" },
      );
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect((await readdir(directory, { recursive: true })).toSorted()).toEqual(contents);
    },
  );

  it("shares one native actor across physical file aliases", async () => {
    const file = databasePath();
    const first = await open(file);
    const alias = path.join(path.dirname(file), "alias.sqlite");
    await link(file, alias);
    const second = await open(alias);

    const firstReceipt = await append(first, "first");
    const secondReceipt = await append(second, "second");
    expect(firstReceipt.threadId).toBeGreaterThan(0);
    expect(secondReceipt).toEqual({ ...firstReceipt, writes: 2 });
    expect(await read(first)).toEqual(["first", "second"]);
  });

  describe.skipIf(process.platform === "win32")("replaced admitted aliases", () => {
    it.each(["hardlink", "symlink"] as const)(
      "holds a replaced %s alias until both alias clients drain and close",
      async (kind) => {
        const file = databasePath();
        const aliasPath = path.join(path.dirname(file), "alias.sqlite");
        const original = await open(file);
        const originalReceipt = await append(original, "original data");
        if (kind === "hardlink") {
          await link(file, aliasPath);
        } else {
          await symlink(file, aliasPath);
        }
        const firstAlias = await open(aliasPath);
        const secondAlias = await open(aliasPath);
        await unlink(aliasPath);
        if (kind === "hardlink") {
          await writeFile(aliasPath, "");
        } else {
          const replacementTarget = path.join(path.dirname(file), "replacement.sqlite");
          await writeFile(replacementTarget, "");
          await symlink(replacementTarget, aliasPath);
        }
        await expectRejectedOpen(aliasPath);
        await firstAlias.close();
        await expectRejectedOpen(aliasPath);

        const ahead = append(original, "ahead of alias write");
        let drained = false;
        const queued = append(secondAlias, "last alias write").then((receipt) => {
          drained = true;
          return receipt;
        });
        await secondAlias.close();
        expect(drained).toBe(true);
        await Promise.all([ahead, queued]);

        const replacement = await open(aliasPath);
        expect(await read(replacement)).toEqual([]);
        const replacementReceipt = await append(replacement, "replacement data");
        expect(replacementReceipt.actor).not.toBe(originalReceipt.actor);
        expect(replacementReceipt.writes).toBe(1);
        expect(await append(original, "original still usable")).toEqual({
          ...originalReceipt,
          writes: 4,
        });
        expect(await read(original)).toEqual([
          "original data",
          "ahead of alias write",
          "last alias write",
          "original still usable",
        ]);
        expect(await read(replacement)).toEqual(["replacement data"]);
      },
    );

    it("pins the canonical target of the first symlink open until its native actor closes", async () => {
      const canonicalPath = databasePath();
      const aliasPath = path.join(path.dirname(canonicalPath), "first-open.sqlite");
      const displacedPath = path.join(path.dirname(canonicalPath), "displaced.sqlite");
      await writeFile(canonicalPath, "");
      await symlink(canonicalPath, aliasPath);
      const original = await open(aliasPath);
      await append(original, "original data");
      await rename(canonicalPath, displacedPath);
      await writeFile(canonicalPath, "");
      await expectRejectedOpen(canonicalPath);
      await original.close();

      const replacement = await open(canonicalPath);
      expect(await read(replacement)).toEqual([]);
      await expect(append(replacement, "replacement data")).resolves.toMatchObject({ writes: 1 });
      expect(await read(await open(displacedPath))).toEqual(["original data"]);
    });
  });

  it("rejects a factory-created physical collision without replacing the existing owner", async () => {
    const file = databasePath();
    const first = await open(file);
    const receipt = await append(first, "original");
    const alias = path.join(path.dirname(file), "created-during-open.sqlite");
    await expectRejectedOpen(alias, { type: "link", existingPath: file });

    expect(await append(first, "still owned")).toEqual({ ...receipt, writes: 2 });
    const shared = await open(alias);
    expect(await append(shared, "alias after refusal")).toEqual({ ...receipt, writes: 3 });
    expect(await read(first)).toEqual(["original", "still owned", "alias after refusal"]);
  });

  it("rejects an existing file whose identity changes inside the backend factory", async () => {
    const file = databasePath();
    const backupPath = path.join(path.dirname(file), "before-replacement.sqlite");
    const seeded = await open(file);
    await append(seeded, "original data");
    await seeded.close();
    await expectRejectedOpen(file, { type: "replace", backupPath });

    expect(await read(await open(backupPath))).toEqual(["original data"]);
    const replacement = await open(file);
    expect(await read(replacement)).toEqual([]);
    await expect(append(replacement, "explicit recovery")).resolves.toMatchObject({ writes: 1 });
  });

  // Windows prevents replacing SQLite's open database file at this boundary.
  it.skipIf(process.platform === "win32")(
    "refuses a replaced active pathname until its original client closes",
    async () => {
      const file = databasePath();
      const displacedPath = path.join(path.dirname(file), "displaced.sqlite");
      const original = await open(file);
      await append(original, "original data");
      await rename(file, displacedPath);
      await writeFile(file, "");
      await expectRejectedOpen(file);
      await original.close();

      const replacement = await open(file);
      expect(await read(replacement)).toEqual([]);
      await expect(append(replacement, "replacement data")).resolves.toMatchObject({ writes: 1 });
      expect(await read(await open(displacedPath))).toEqual(["original data"]);
    },
  );

  it("drains a closing client's writes and preserves the remaining client's connection", async () => {
    const file = databasePath();
    const first = await open(file);
    const second = await open(file);
    let committedSettled = false;
    const committed = append(first, "before close").then((receipt) => {
      committedSettled = true;
      return receipt;
    });
    const closed = first.close();
    await expect(append(first, "after close")).rejects.toMatchObject({ code: "closed" });
    await closed;
    expect(committedSettled).toBe(true);

    const receipt = await committed;
    expect(await append(second, "still open")).toEqual({ ...receipt, writes: 2 });
    await second.close();
    expect(await read(await open(file))).toEqual(["before close", "still open"]);
  });

  nodeIt("keeps a new database usable while another worker retires at capacity", async () => {
    const first = await open(databasePath());
    // Fill the documented four-worker budget before retiring an otherwise idle worker.
    for (let index = 0; index < 3; index += 1) {
      await open(databasePath());
    }
    const retiring = createDeferredCore();
    const release = createDeferredCore();
    const spy = vi.spyOn(Worker.prototype, "terminate").mockImplementationOnce(async function (
      this: Worker,
    ) {
      retiring.resolve();
      await release.promise;
      spy.mockRestore();
      return this.terminate();
    });
    const closed = first.close();
    let replacement: SqliteWorkerStore<FixtureOperations> | undefined;
    try {
      await retiring.promise;
      replacement = await open(databasePath());
      release.resolve();
      await closed;
      await expect(append(replacement, "survives retirement")).resolves.toMatchObject({
        writes: 1,
      });
      expect(await read(replacement)).toEqual(["survives retirement"]);
    } finally {
      release.resolve();
      spy.mockRestore();
      await closed;
      if (replacement) {
        // The regressed broker loses this actor too; join its cleanup without masking the assertion.
        await Promise.allSettled([replacement.close()]);
        stores.delete(replacement);
      }
    }
  });

  it("snapshots command input before a queued caller can mutate it", async () => {
    const store = await open(databasePath());
    const first = append(store, "first");
    const command = { type: "append" as const, input: { value: "admitted" } };
    const queued = store.execute(command);
    command.input.value = "mutated";
    await Promise.all([first, queued]);
    expect(await read(store)).toEqual(["first", "admitted"]);
  });

  it("cancels queued work but retains a dispatched write until its outcome is known", async () => {
    const store = await open(databasePath());
    const dispatched = new AbortController();
    const queued = new AbortController();
    const committed = store.execute(
      { type: "append", input: { value: "dispatched" } },
      { signal: dispatched.signal },
    );
    const canceled = store.execute(
      { type: "append", input: { value: "queued" } },
      { signal: queued.signal },
    );
    const reason = new Error("owner retired");
    dispatched.abort(reason);
    queued.abort(reason);
    await expect(canceled).rejects.toBe(reason);
    await expect(committed).resolves.toMatchObject({ writes: 1 });
    expect(await read(store)).toEqual(["dispatched"]);
  });

  it("bounds reserved and live clients sharing one actor until close or failed admission drains", async () => {
    const file = databasePath();
    const retiring = await open(file);
    const survivor = await open(file);
    for (let index = 2; index < 64; index += 1) {
      await open(file);
    }
    await expectRejectedOpen(file, undefined, "overloaded");

    const replyReady = createDeferredCore();
    let publish: (() => void) | undefined;
    const messages = vi.spyOn(Worker.prototype, "emit").mockImplementationOnce(function (
      this: Worker,
      event: string | symbol,
      reply: SqliteWorkerReply,
    ) {
      messages.mockRestore();
      publish = () => this.emit(event, reply);
      replyReady.resolve();
      return true;
    });
    const write = append(retiring, "write before close");
    const closed = retiring.close();
    try {
      await replyReady.promise;
      await expectRejectedOpen(file, undefined, "overloaded");
      publish?.();
      publish = undefined;
      await closed;
      await write;
    } finally {
      messages.mockRestore();
      publish?.();
      await Promise.allSettled([write, closed]);
    }
    expect(await read(survivor)).toEqual(["write before close"]);

    const missing = path.join(path.dirname(file), "missing.sqlite");
    const failed = open(missing, {
      type: "replace",
      backupPath: path.join(path.dirname(file), "unused-backup.sqlite"),
    });
    // The failing factory owns the last reservation before its asynchronous admission settles.
    const overflow = expectRejectedOpen(file, undefined, "overloaded");
    await Promise.all([expect(failed).rejects.toThrow(), overflow]);
    const recovered = await open(file);
    expect(await append(recovered, "after failed admission")).toMatchObject({ writes: 2 });
    await expectRejectedOpen(file, undefined, "overloaded");
    expect(await read(survivor)).toEqual(["write before close", "after failed admission"]);
  });

  nodeIt("times out a waiting open without retiring healthy workers or writes", async () => {
    const active: SqliteWorkerStore<FixtureOperations>[] = [];
    for (let index = 0; index < 4; index += 1) {
      active.push(await open(databasePath()));
    }
    const repliesReady = createDeferredCore();
    const replies: (() => void)[] = [];
    const messages = vi.spyOn(Worker.prototype, "emit").mockImplementation(function (
      this: Worker,
      event: string | symbol,
      reply: SqliteWorkerReply,
    ) {
      replies.push(() => this.emit(event, reply));
      if (replies.length === active.length) {
        messages.mockRestore();
        repliesReady.resolve();
      }
      return true;
    });
    function releaseReplies(): void {
      messages.mockRestore();
      for (const publish of replies.splice(0)) {
        publish();
      }
    }
    const writes: ReturnType<typeof append>[] = [];
    for (let round = 0; round < 128; round += 1) {
      for (const [index, store] of active.entries()) {
        writes.push(append(store, `${index}:${round}`));
      }
    }
    const outcomes = Promise.allSettled(writes);
    try {
      await repliesReady.promise;
      const pendingFile = databasePath();
      const timeout = vi.spyOn(globalThis, "setTimeout");
      const opening = expectRejectedOpen(pendingFile, undefined, "overloaded");
      try {
        await vi.waitFor(() => {
          expect(timeout.mock.calls.some(([, ms]) => ms === 10_000)).toBe(true);
        });
        const expire = timeout.mock.calls.find(([, ms]) => ms === 10_000)?.[0];
        expect(expire).toBeDefined();
        expire?.();
        await opening;
      } finally {
        timeout.mockRestore();
      }
      releaseReplies();
      const results = await outcomes;
      expect(results.find((result) => result.status === "rejected")).toBeUndefined();
      for (const [index, store] of active.entries()) {
        expect(await read(store)).toEqual(
          Array.from({ length: 128 }, (_, round) => `${index}:${round}`),
        );
      }
      const admitted = await open(pendingFile);
      await expect(append(admitted, "after queue drainage")).resolves.toMatchObject({ writes: 1 });
      expect(await read(admitted)).toEqual(["after queue drainage"]);
    } finally {
      releaseReplies();
      await outcomes;
      // A regressed admission can lose a shared worker; preserve the write failure as the assertion.
      await Promise.allSettled(active.map((store) => store.close()));
      for (const store of active) {
        stores.delete(store);
      }
    }
  });

  it("waits at capacity, preserves FIFO, and drains accepted waiters on client close", async () => {
    const file = databasePath();
    const store = await open(file);
    // One main-thread turn fills admission before worker replies can drain it.
    const accepted = Array.from({ length: 128 }, (_, index) => append(store, String(index)));
    let settled = false;
    const waiting = Promise.all([
      append(store, "first waiter"),
      append(store, "second waiter"),
    ]).finally(() => {
      settled = true;
    });
    const outcomes = Promise.allSettled([...accepted, waiting]);
    await Promise.resolve();
    expect(settled).toBe(false);
    await store.close();
    expect((await outcomes).every((result) => result.status === "fulfilled")).toBe(true);
    expect(await read(await open(file))).toEqual([
      ...Array.from({ length: 128 }, (_, index) => String(index)),
      "first waiter",
      "second waiter",
    ]);
  });

  it.each([
    { owner: "agent", aggregate: false },
    { owner: "agent", aggregate: true },
    { owner: "shared", aggregate: true },
  ] as const)(
    "preserves $owner close diagnostics and committed data (aggregate: $aggregate)",
    async ({ owner, aggregate }) => {
      const file = databasePath();
      const { store, gateway } = await openWithGateway(file, owner);
      try {
        const receipt = await append(store, "preserved");
        await store.execute({ type: "failClose", input: { aggregate } });
        const failure: unknown = await store.close().catch((error: unknown) => error);
        stores.delete(store);
        assert(failure instanceof Error);
        const nativeFailure = aggregate ? failure.cause : failure;
        assert(nativeFailure instanceof Error);
        expect(nativeFailure.message).toBe("Fixture native database closed with a cleanup failure");
        expect(nativeFailure.cause).toMatchObject({
          message: "Fixture native close detail Authorization: Bearer synthetic-close-secret",
          code: "SQLITE_BUSY",
          errcode: 5,
          errno: -16,
        });
        if (aggregate) {
          assert(failure instanceof AggregateError);
          expect(failure.errors).toHaveLength(2);
          expect(failure.errors[0]).toBe(nativeFailure);
          expect(failure.errors[1]).toBe(nativeFailure.cause);
        }
        const displayed = formatErrorMessageWithCode(failure);
        expect(displayed).toContain("Fixture native close detail");
        expect(displayed).toContain("SQLITE_BUSY");
        expect(displayed).not.toContain("synthetic-close-secret");

        const recovered = await open(file);
        expect(await read(recovered)).toEqual(["preserved"]);
        const recoveredReceipt = await append(recovered, "after recovery");
        expect(recoveredReceipt.actor).not.toBe(receipt.actor);
        expect(recoveredReceipt.writes).toBe(1);
        expect(await read(recovered)).toEqual(["preserved", "after recovery"]);
      } finally {
        try {
          await store.close();
        } finally {
          gateway.release();
        }
      }
    },
  );

  it.each([
    { reject: false, owner: "client" },
    { reject: true, owner: "client" },
    { reject: false, owner: "host" },
  ] as const)(
    "awaits delayed native cleanup before $owner close settles (reject: $reject)",
    async ({ reject, owner }) => {
      const file = databasePath();
      const markerPath = path.join(path.dirname(file), "closed");
      const store = await open(file);
      const peer = owner === "host" ? await open(file) : undefined;
      await append(store, "preserved");
      await store.execute({ type: "delayClose", input: { markerPath, reject } });
      stores.delete(store);
      // oxlint-disable-next-line typescript/unbound-method -- Reflect.apply preserves the emitting worker below.
      const originalEmit = Worker.prototype.emit;
      const events = vi.spyOn(Worker.prototype, "emit");
      const replyHeld = createDeferredCore();
      let resumeReply: (() => void) | undefined;
      if (peer) {
        events.mockImplementation(function (this: Worker, ...args: Parameters<Worker["emit"]>) {
          const [event, reply] = args;
          if (event === "message" && isRecord(reply) && reply.ok === true && !resumeReply) {
            let delivered = false;
            resumeReply = () => {
              if (delivered) {
                return;
              }
              delivered = true;
              Reflect.apply(originalEmit, this, args);
            };
            replyHeld.resolve();
            return true;
          }
          return Reflect.apply(originalEmit, this, args);
        });
      }
      const cleanup = Promise.allSettled([
        peer ? drainGlobalSingletonLifecycleState("restart") : store.close(),
      ]);
      let clientCleanup: Promise<PromiseSettledResult<void>[]> | undefined;
      try {
        if (peer) {
          await replyHeld.promise;
          let clientClosed = false;
          clientCleanup = Promise.allSettled([store.close()]).then((results) => {
            clientClosed = true;
            return results;
          });
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
          expect(clientClosed).toBe(false);
          resumeReply?.();
          expect(await clientCleanup).toEqual([{ status: "fulfilled", value: undefined }]);
        }
        const [result] = await cleanup;
        expect(events.mock.calls.filter(([event]) => event === "error")).toEqual([]);
        expect(await readFile(markerPath, "utf8")).toBe("native database closed");
        if (reject) {
          expect(result).toEqual({
            status: "rejected",
            reason: expect.objectContaining({
              name: "FixtureCleanupError",
              code: "FIXTURE_CLEANUP_FAILED",
              message: "Fixture delayed cleanup rejected",
            }),
          });
        } else {
          expect(result).toEqual({ status: "fulfilled", value: undefined });
        }
      } finally {
        events.mockRestore();
        resumeReply?.();
        await cleanup;
        await clientCleanup;
        await peer?.close();
      }
      const recovered = await open(file);
      expect(await read(recovered)).toEqual(["preserved"]);
      await expect(append(recovered, "recovered")).resolves.toMatchObject({ writes: 1 });
    },
  );

  it.each([false, true])(
    "retires an illegal async operation before reporting uncertainty (reject: %s)",
    async (reject) => {
      const file = databasePath();
      const gatePath = path.join(path.dirname(file), "release-operation");
      const store = await open(file);
      await append(store, "before");
      const events = vi.spyOn(Worker.prototype, "emit");
      try {
        const operation = store.execute({
          type: "illegalAsync",
          input: { value: "late write", gatePath, reject },
        });
        const queued = append(store, "queued write");
        const outcomes = await Promise.allSettled([operation, queued]);
        expect(outcomes).toEqual([
          { status: "rejected", reason: expect.objectContaining({ code: "outcome-unknown" }) },
          { status: "rejected", reason: expect.objectContaining({ code: "unavailable" }) },
        ]);
        expect(events.mock.calls.filter(([event]) => event === "error")).toEqual([]);
        await writeFile(gatePath, "released after operation settled");
      } finally {
        events.mockRestore();
        await writeFile(gatePath, "released for cleanup");
        await Promise.allSettled([store.close()]);
        stores.delete(store);
      }
      const recovered = await open(file);
      expect(await read(recovered)).toEqual(["before"]);
      await expect(append(recovered, "after recovery")).resolves.toMatchObject({ writes: 1 });
    },
  );

  it("retires a worker after a committed result cannot be deserialized without dispatching queued writes", async () => {
    const file = databasePath();
    const store = await open(file);
    const messages = vi.spyOn(Worker.prototype, "emit").mockImplementationOnce(function (
      this: Worker,
      event: string | symbol,
      reply: SqliteWorkerReply,
    ) {
      messages.mockRestore();
      expect(event).toBe("message");
      expect(reply.ok).toBe(true);
      return this.emit(event, { ...reply, value: new Uint8Array([0]) });
    });
    try {
      const committed = append(store, "committed once");
      const queued = append(store, "never dispatched");
      expect(await Promise.allSettled([committed, queued])).toEqual([
        { status: "rejected", reason: expect.objectContaining({ code: "outcome-unknown" }) },
        { status: "rejected", reason: expect.objectContaining({ code: "unavailable" }) },
      ]);
    } finally {
      messages.mockRestore();
      await Promise.allSettled([store.close()]);
      stores.delete(store);
    }
    const recovered = await open(file);
    expect(await read(recovered)).toEqual(["committed once"]);
    await expect(append(recovered, "after recovery")).resolves.toMatchObject({ writes: 1 });
  });

  it("reports an uncertain result when serialization fails after commit without replaying the write", async () => {
    const file = databasePath();
    const store = await open(file);
    await expect(
      store.execute({ type: "commitUnserializable", input: { value: "committed once" } }),
    ).rejects.toMatchObject({ code: "outcome-unknown" });
    expect(await read(store)).toEqual(["committed once"]);
    expect(await append(store, "next write")).toMatchObject({ writes: 2 });
    await store.close();
    expect(await read(await open(file))).toEqual(["committed once", "next write"]);
  });

  it("reports a lost write outcome without replay and releases native locks before recovery", async () => {
    const file = databasePath();
    const store = await open(file);
    const lost = store.execute({ type: "commitThenExit", input: { value: "committed" } });
    const queued = Array.from({ length: 128 }, () => append(store, "never dispatched"));
    const [result, ...followers] = await Promise.allSettled([lost, ...queued]);
    expect(result).toMatchObject({ status: "rejected", reason: { code: "outcome-unknown" } });
    expect(followers).toHaveLength(128);
    for (const follower of followers) {
      expect(follower).toMatchObject({ status: "rejected", reason: { code: "unavailable" } });
    }
    await expect(store.close()).resolves.toBeUndefined();
    stores.delete(store);

    const recovered = await open(file);
    expect(await read(recovered)).toEqual(["committed"]);
    expect(await append(recovered, "explicit recovery")).toMatchObject({ writes: 1 });
    expect(await read(recovered)).toEqual(["committed", "explicit recovery"]);
  });
});
