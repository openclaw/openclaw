import { createHash } from "node:crypto";
import fs from "node:fs";
import { link, mkdir, readFile, rename, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getEnvironmentData, setEnvironmentData, Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { createDeferredCore } from "../shared/deferred.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { createNodeEvalArgs } from "../test-utils/node-process.js";
import { initializeSqliteRuntimeCapabilities } from "./bun-sqlite-library.js";
import { listDirectoryTreeStrict } from "./directory-walk.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import {
  readSqliteDatabaseScopedWriteTokenForPath,
  readSqliteDatabaseWriteTokenForPath,
} from "./sqlite-database-admission.js";
import { hasSqliteWorkerOutcomeUnknown, type SqliteWorkerReply } from "./sqlite-worker-contract.js";
import {
  useSqliteWorkerStoreFixture,
  appendWorkerRow as append,
  readWorkerRows as read,
} from "./sqlite-worker-fixture.test-support.js";
import { createSqliteWorkerOperationAdmission } from "./sqlite-worker-operation-admission.js";
import {
  openSharedStateSqliteWorkerStore,
  closeUnclaimedSharedStateSqliteWorkers,
  hasUnclaimedSharedStateSqliteCleanup,
  runSqliteWorkerStoreOperation,
  type SqliteWorkerStore,
} from "./sqlite-worker-store.js";
import type { FixtureOpenInput, FixtureOperations } from "./sqlite-worker-store.test-support.js";
import { resolveSqliteBrokerWorkerCount } from "./worker-pool-sizing.js";

const { stores, tempDirs, databasePath, open } = useSqliteWorkerStoreFixture(
  "openclaw-sqlite-worker-store-",
);
type Store = SqliteWorkerStore<FixtureOperations>;
// Capture before any interception; forwarding must retain the emitting worker.
// oxlint-disable-next-line typescript/unbound-method -- Reflect.apply below retains the receiver.
const nativeEmit = Worker.prototype.emit;
function emit(worker: Worker, event: string | symbol, reply: SqliteWorkerReply) {
  return Reflect.apply(nativeEmit, worker, [event, reply]);
}
function interceptReply(
  handler: (this: Worker, event: string | symbol, reply: SqliteWorkerReply) => boolean,
  once = false,
) {
  const spy = vi.spyOn(Worker.prototype, "emit");
  return once ? spy.mockImplementationOnce(handler) : spy.mockImplementation(handler);
}
async function expectUncertainAndUnavailable(...operations: Promise<unknown>[]) {
  expect(await Promise.allSettled(operations)).toEqual([
    { status: "rejected", reason: expect.objectContaining({ code: "outcome-unknown" }) },
    { status: "rejected", reason: expect.objectContaining({ code: "unavailable" }) },
  ]);
}
async function expectRecovery(file: string, rows: string[], next: string) {
  const recovered = await open(file);
  expect(await read(recovered)).toEqual(rows);
  expect(await append(recovered, next)).toMatchObject({ writes: 1 });
  return recovered;
}

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

const { explicitSqliteCloseReleasesNativeResources } = await initializeSqliteRuntimeCapabilities();
const poolIt = explicitSqliteCloseReleasesNativeResources ? it : it.skip;

describe("SQLite worker store", () => {
  it("publishes native runtime admission once before the opening caller resumes", async () => {
    await drainGlobalSingletonLifecycleState();
    const key = "openclaw.sqliteNativeRuntimeAdmission";
    const previous = getEnvironmentData(key);
    const receipts: unknown[] = [];
    const messages = interceptReply(function (event, reply) {
      if (event === "message" && reply.ok && reply.nativeRuntimeAdmission !== undefined) {
        receipts.push(reply.nativeRuntimeAdmission);
      }
      return emit(this, event, reply);
    });
    setEnvironmentData(key, undefined);
    try {
      const store = await open(databasePath());
      expect(getEnvironmentData(key)).toMatchObject({ format: 1, runtime: { pid: process.pid } });
      await append(store, "admitted");
      expect(await read(store)).toEqual(["admitted"]);
      expect(receipts).toHaveLength(1);
    } finally {
      messages.mockRestore();
      await drainGlobalSingletonLifecycleState();
      setEnvironmentData(key, previous);
    }
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
      let frameCount = 0;
      const aborted = new AbortController();
      let closing: Promise<void> | undefined;
      const messages = interceptReply(function (event, reply) {
        if (event === "message" && reply.ok && reply.transfer === "frame") {
          frameCount += 1;
          if (frameCount === 1) {
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
              return emit(this, event, { ...reply, value: new Uint8Array([0]) });
            }
          }
        }
        return emit(this, event, reply);
      });
      try {
        for (const value of values) {
          await append(store, value);
        }
        const reading = store.execute(
          { type: "read", input: undefined },
          { signal: aborted.signal },
        );
        if (action === "failed frame") {
          const queued = append(store, "queued");
          await expectUncertainAndUnavailable(reading, queued);
        } else {
          const result = await reading;
          expect(result).toHaveLength(values.length);
          expect(result.map(digest)).toEqual(values.map(digest));
          expect(frameCount).toBeGreaterThan(8);
          if (action.endsWith("close")) {
            expect(closing).toBeDefined();
          }
          if (action === "abort") {
            expect(aborted.signal.aborted).toBe(true);
          }
          await closing;
        }
        if (action === "read") {
          const ownership = await store.execute({ type: "takeReplyOwnership", input: undefined });
          expect(ownership.some((reply) => reply.kind === "inline")).toBe(true);
          expect(ownership.filter((reply) => reply.kind === "frame")).toHaveLength(frameCount);
          for (const reply of ownership) {
            expect(reply.before).toBeGreaterThan(0);
            expect.soft(reply.after, `${reply.kind} reply (${reply.before} bytes)`).toBe(0);
          }
        }
      } finally {
        messages.mockRestore();
        await Promise.allSettled([closing, store.close()]);
        stores.delete(store);
      }
      if (action === "failed frame") {
        const recovered = await open(file);
        expect((await read(recovered)).map(digest)).toEqual(values.map(digest));
        expect(await append(recovered, "recovered")).toMatchObject({ writes: 1 });
      }
    },
  );

  it("joins failed-factory native retirement before releasing its database for recovery", async () => {
    const file = databasePath();
    const root = path.dirname(file);
    const modulePath = path.join(root, "failed-open.mjs");
    await writeFile(
      modulePath,
      `
      import { DatabaseSync } from "node:sqlite";
      const retained = [];
      export function createSqliteWorkerBackend(_input, context) {
        const database = new DatabaseSync(context.databasePath);
        retained.push(database);
        database.exec("CREATE TABLE entries (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
        database.exec("INSERT INTO entries (value) VALUES ('committed')");
        database.exec("BEGIN IMMEDIATE; INSERT INTO entries (value) VALUES ('uncommitted')");
        throw new Error("Fixture factory failed with a live native transaction");
      }
    `,
    );
    const unrelatedPath = databasePath();
    const unrelated = await open(unrelatedPath);
    const retiring = createDeferredCore();
    const releaseRetirement = createDeferredCore();
    let exited = false;
    let recoverySettled = false;
    let recoveredBeforeExit = false;
    let recovering: Promise<Store> | undefined;
    // oxlint-disable-next-line typescript/unbound-method -- call preserves the retiring worker.
    const terminate = Worker.prototype.terminate;
    const retirement = vi
      .spyOn(Worker.prototype, "terminate")
      .mockImplementationOnce(async function (this: Worker) {
        this.once("exit", () => {
          exited = true;
        });
        retiring.resolve();
        await releaseRetirement.promise;
        return terminate.call(this);
      });
    let settled = false;
    const opening = Promise.allSettled([
      openSharedStateSqliteWorkerStore(
        { moduleUrl: pathToFileURL(modulePath), databasePath: file },
        { environment: { OPENCLAW_STATE_DIR: root } },
      ),
    ]).then((results) => {
      settled = true;
      return results;
    });
    try {
      await Promise.race([retiring.promise, opening]);
      expect(settled).toBe(false);
      recovering = open(file).then((store) => {
        recoverySettled = true;
        recoveredBeforeExit = !exited;
        return store;
      });
      void recovering.catch(() => {});
      await expect(append(unrelated, "unrelated")).resolves.toMatchObject({ writes: 1 });
      expect(exited).toBe(false);
      expect(settled).toBe(false);
      expect(recoverySettled).toBe(false);
      releaseRetirement.resolve();
      expect(await opening).toMatchObject([
        {
          status: "rejected",
          reason: { message: "Fixture factory failed with a live native transaction" },
        },
      ]);
      expect(hasUnclaimedSharedStateSqliteCleanup(file)).toBe(false);
      await closeUnclaimedSharedStateSqliteWorkers(file);
      await closeUnclaimedSharedStateSqliteWorkers(unrelatedPath);
      expect(await read(unrelated)).toEqual(["unrelated"]);
      const recovered = await recovering;
      expect(exited).toBe(true);
      expect(recoveredBeforeExit).toBe(false);
      expect(await read(recovered)).toEqual(["committed"]);
      await expect(append(recovered, "recovered")).resolves.toMatchObject({ writes: 1 });
      expect(await read(recovered)).toEqual(["committed", "recovered"]);
    } finally {
      releaseRetirement.resolve();
      retirement.mockRestore();
      const [result] = await opening;
      await recovering?.catch(() => {});
      if (result.status === "fulfilled") {
        await result.value?.close();
      }
    }
  });

  it.for(["absolute memory", "memory URI", "incognito", "empty"] as const)(
    "rejects a %s locator before creating a file or dispatching a worker request",
    async (kind, { signal }) => {
      const directory = tempDirs.make("openclaw-sqlite-worker-locator-");
      const incognito = resolveIncognitoOpenClawAgentSqlitePath({
        agentId: "fixture",
        env: { OPENCLAW_STATE_DIR: directory },
      });
      await mkdir(path.dirname(incognito), { recursive: true });
      const locators = {
        "absolute memory": path.join(directory, ":memory:"),
        "memory URI": "file:memory-test?mode=memory&cache=shared",
        incognito,
        empty: "",
      };
      const contents = (await listDirectoryTreeStrict(directory))
        .map((walkEntry) => walkEntry.relativePath)
        .toSorted();
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
      expect(
        (await listDirectoryTreeStrict(directory))
          .map((walkEntry) => walkEntry.relativePath)
          .toSorted(),
      ).toEqual(contents);
    },
  );

  describe.skipIf(process.platform === "win32")("replaced admitted aliases", () => {
    it.each(["hardlink", "symlink"] as const)(
      "holds a replaced %s alias until both alias clients drain and close",
      async (kind) => {
        const file = databasePath();
        const aliasPath = path.join(path.dirname(file), "alias.sqlite");
        const original = await open(file);
        const originalReceipt = await append(original, "original");
        const createAlias = kind === "hardlink" ? link : symlink;
        await createAlias(file, aliasPath);
        const firstAlias = await open(aliasPath);
        const secondAlias = await open(aliasPath);
        const realpath = vi.spyOn(fs.realpathSync, "native");
        try {
          expect(await append(firstAlias, "warm")).toEqual({ ...originalReceipt, writes: 2 });
          expect(await read(original)).toEqual(["original", "warm"]);
          // No database path resolution belongs on an already-open worker operation.
          expect(
            realpath.mock.calls.filter(([pathname]) => pathname === file || pathname === aliasPath),
          ).toEqual([]);
        } finally {
          realpath.mockRestore();
        }
        await unlink(aliasPath);
        const replacementTarget =
          kind === "hardlink" ? aliasPath : path.join(path.dirname(file), "replacement.sqlite");
        await writeFile(replacementTarget, "");
        if (kind === "symlink") {
          await symlink(replacementTarget, aliasPath);
        }
        await expectRejectedOpen(aliasPath);
        await firstAlias.close();
        await expectRejectedOpen(aliasPath);

        const ahead = append(original, "ahead");
        let drained = false;
        const queued = append(secondAlias, "alias-last").then((receipt) => {
          drained = true;
          return receipt;
        });
        await secondAlias.close();
        expect(drained).toBe(true);
        await Promise.all([ahead, queued]);

        const replacement = await open(aliasPath);
        expect(await read(replacement)).toEqual([]);
        const replacementReceipt = await append(replacement, "replacement");
        expect(replacementReceipt.actor).not.toBe(originalReceipt.actor);
        expect(replacementReceipt.writes).toBe(1);
        expect(await append(original, "original-live")).toEqual({ ...originalReceipt, writes: 5 });
        expect(await read(original)).toEqual([
          "original",
          "warm",
          "ahead",
          "alias-last",
          "original-live",
        ]);
        expect(await read(replacement)).toEqual(["replacement"]);
      },
    );

    it("pins the canonical target of the first symlink open until its native actor closes", async () => {
      const canonicalPath = databasePath();
      const aliasPath = path.join(path.dirname(canonicalPath), "first-open.sqlite");
      const displacedPath = path.join(path.dirname(canonicalPath), "displaced.sqlite");
      await writeFile(canonicalPath, "");
      await symlink(canonicalPath, aliasPath);
      const original = await open(aliasPath);
      await append(original, "original");
      await rename(canonicalPath, displacedPath);
      await writeFile(canonicalPath, "");
      await expectRejectedOpen(canonicalPath);
      await original.close();

      const replacement = await open(canonicalPath);
      expect(await read(replacement)).toEqual([]);
      await expect(append(replacement, "replacement")).resolves.toMatchObject({ writes: 1 });
      expect(await read(await open(displacedPath))).toEqual(["original"]);
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
    await append(seeded, "original");
    await seeded.close();
    await expectRejectedOpen(file, { type: "replace", backupPath });

    expect(await read(await open(backupPath))).toEqual(["original"]);
    const replacement = await open(file);
    expect(await read(replacement)).toEqual([]);
    await expect(append(replacement, "recovered")).resolves.toMatchObject({ writes: 1 });
  });

  poolIt("keeps a new database usable while another worker retires at capacity", async () => {
    const first = await open(databasePath());
    // Give each worker one actor so closing the first actor starts native retirement.
    for (let index = 1; index < resolveSqliteBrokerWorkerCount(); index += 1) {
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
    let replacement: Store | undefined;
    try {
      await retiring.promise;
      replacement = await open(databasePath());
      release.resolve();
      await closed;
      await expect(append(replacement, "survived")).resolves.toMatchObject({ writes: 1 });
      expect(await read(replacement)).toEqual(["survived"]);
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
    const messages = interceptReply(function (event, reply) {
      messages.mockRestore();
      publish = () => this.emit(event, reply);
      replyReady.resolve();
      return true;
    }, true);
    const write = append(retiring, "before-close");
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
    expect(await read(survivor)).toEqual(["before-close"]);

    const missing = path.join(path.dirname(file), "missing.sqlite");
    const failed = open(missing, {
      type: "replace",
      backupPath: path.join(path.dirname(file), "unused-backup.sqlite"),
    });
    // The failing factory owns the last reservation before its asynchronous admission settles.
    const overflow = expectRejectedOpen(file, undefined, "overloaded");
    await Promise.all([expect(failed).rejects.toThrow(), overflow]);
    const recovered = await open(file);
    expect(await append(recovered, "after-refusal")).toMatchObject({ writes: 2 });
    await expectRejectedOpen(file, undefined, "overloaded");
    expect(await read(survivor)).toEqual(["before-close", "after-refusal"]);
  });

  poolIt("times out a waiting open without retiring healthy workers or writes", async () => {
    const active: Store[] = [];
    for (let index = 0; index < resolveSqliteBrokerWorkerCount(); index += 1) {
      active.push(await open(databasePath()));
    }
    const repliesReady = createDeferredCore();
    const replies: (() => void)[] = [];
    const messages = interceptReply(function (event, reply) {
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
        expect(fs.existsSync(pendingFile)).toBe(false);
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
      await expect(append(admitted, "drained")).resolves.toMatchObject({ writes: 1 });
      expect(await read(admitted)).toEqual(["drained"]);
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
              Reflect.apply(nativeEmit, this, args);
            };
            replyHeld.resolve();
            return true;
          }
          return Reflect.apply(nativeEmit, this, args);
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
        expect(await readFile(markerPath, "utf8")).toBe("native database closed");
      } finally {
        events.mockRestore();
        resumeReply?.();
        await cleanup;
        await clientCleanup;
        await peer?.close();
      }
      await expectRecovery(file, ["preserved"], "recovered");
    },
  );

  it.each(["async resolve", "async reject", "corrupt receipt"] as const)(
    "retires %s before reporting uncertainty without dispatching queued writes",
    async (failure) => {
      const file = databasePath();
      const store = await open(file);
      const gatePath = path.join(path.dirname(file), "release-operation");
      const corrupt = failure === "corrupt receipt";
      if (!corrupt) {
        await append(store, "before");
      }
      const events = corrupt
        ? interceptReply(function (event, reply) {
            events.mockRestore();
            expect(event).toBe("message");
            expect(reply.ok).toBe(true);
            return this.emit(event, { ...reply, value: new Uint8Array([0]) });
          }, true)
        : vi.spyOn(Worker.prototype, "emit");
      try {
        const operation = corrupt
          ? append(store, "committed once")
          : store.execute({
              type: "illegalAsync",
              input: { value: "late write", gatePath, reject: failure === "async reject" },
            });
        await expectUncertainAndUnavailable(operation, append(store, "queued"));
        expect(events.mock.calls.filter(([event]) => event === "error")).toEqual([]);
        if (!corrupt) {
          await writeFile(gatePath, "released after operation settled");
        }
      } finally {
        events.mockRestore();
        if (!corrupt) {
          await writeFile(gatePath, "released for cleanup");
        }
        await Promise.allSettled([store.close()]);
        stores.delete(store);
      }
      await expectRecovery(file, [corrupt ? "committed once" : "before"], "recovered");
    },
  );

  it("reports an uncertain result when serialization fails after commit without replaying the write", async () => {
    const file = databasePath();
    const store = await open(file);
    const failure = await store
      .execute({ type: "commitUnserializable", input: { value: "committed once" } })
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "outcome-unknown" });
    expect(hasSqliteWorkerOutcomeUnknown(failure)).toBe(true);
    expect(await read(store)).toEqual(["committed once"]);
    expect(await append(store, "next")).toMatchObject({ writes: 2 });
    await store.close();
    expect(await read(await open(file))).toEqual(["committed once", "next"]);
  });

  it("reports a lost write outcome without replay and releases native locks before recovery", async () => {
    const file = databasePath();
    const store = await open(file);
    const lost = store.execute({ type: "commitThenExit", input: { value: "committed" } });
    const queued = Array.from({ length: 128 }, () => append(store, "queued"));
    const [result, ...followers] = await Promise.allSettled([lost, ...queued]);
    expect(result).toMatchObject({ status: "rejected", reason: { code: "outcome-unknown" } });
    expect(followers).toHaveLength(128);
    for (const follower of followers) {
      expect(follower).toMatchObject({ status: "rejected", reason: { code: "unavailable" } });
    }
    await expect(store.close()).resolves.toBeUndefined();
    stores.delete(store);

    const recovered = await expectRecovery(file, ["committed"], "recovered");
    expect(await read(recovered)).toEqual(["committed", "recovered"]);
  });

  it.each(["native", "schema-maintenance"] as const)(
    "invalidates saved authority receipts when a %s writer dies inside native COMMIT",
    async (mode) => {
      const file = databasePath();
      const store = await open(file);
      const sibling = openNodeSqliteDatabase(file);
      try {
        const receipt = readSqliteDatabaseWriteTokenForPath(file);
        const scoped = readSqliteDatabaseScopedWriteTokenForPath(file, "fixture:authority");
        expect(receipt).toBeDefined();
        expect(scoped).toBeDefined();
        await expect(
          runSqliteWorkerStoreOperation(
            store,
            (scope) =>
              scope.execute({ type: "commitWithoutReceipt", input: { value: "revoked", mode } }),
            undefined,
            undefined,
            () => ({
              admission: createSqliteWorkerOperationAdmission((_request, grant) => {
                if (mode === "native") {
                  throw new Error("Native writes do not request separate domain admission");
                }
                grant();
              }),
              nativeLocations: [file],
            }),
          ),
        ).rejects.toMatchObject({ code: "outcome-unknown" });
        expect(readSqliteDatabaseWriteTokenForPath(file)).not.toBe(receipt);
        expect(readSqliteDatabaseScopedWriteTokenForPath(file, "fixture:authority")).not.toBe(
          scoped,
        );
        expect(await read(await open(file))).toEqual(["revoked"]);
      } finally {
        sibling.close();
      }
    },
  );
});
