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
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import type { SqliteWorkerReply } from "./sqlite-worker-contract.js";
import { openSqliteWorkerStore, type SqliteWorkerStore } from "./sqlite-worker-store.js";
import type { FixtureOpenInput, FixtureOperations } from "./sqlite-worker-store.test-support.js";

const stores = new Set<SqliteWorkerStore<FixtureOperations>>();
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    try {
      await Promise.all([...stores].map((store) => store.close()));
    } finally {
      stores.clear();
      cleanup();
    }
  }),
);

function databasePath(): string {
  return path.join(tempDirs.make("openclaw-sqlite-worker-store-"), "store.sqlite");
}

async function open(file: string, input?: FixtureOpenInput) {
  const store = await openSqliteWorkerStore<FixtureOperations>({
    moduleUrl: new URL("./sqlite-worker-store.test-support.ts", import.meta.url),
    databasePath: file,
    input,
  });
  stores.add(store);
  return store;
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

function append(store: SqliteWorkerStore<FixtureOperations>, value: string) {
  return store.execute({ type: "append", input: { value } });
}

function read(store: SqliteWorkerStore<FixtureOperations>) {
  return store.execute({ type: "read", input: undefined });
}

const nodeIt = process.versions.bun ? it.skip : it;

describe("SQLite worker store", () => {
  it.each(["memory", "absolute memory", "memory URI", "incognito", "empty"] as const)(
    "rejects a %s locator before creating a file or dispatching a worker request",
    async (kind) => {
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
      const originalCwd = process.cwd();
      const originalTsconfigPath = process.env.TSX_TSCONFIG_PATH;
      const requests = vi.spyOn(Worker.prototype, "postMessage");
      try {
        // An unfixed broker may resolve a memory locator into a real file; contain it in this test.
        process.env.TSX_TSCONFIG_PATH = path.join(originalCwd, "tsconfig.json");
        process.chdir(directory);
        const [result] = await Promise.allSettled([open(locators[kind])]);
        if (result.status === "fulfilled") {
          await result.value.close();
          stores.delete(result.value);
        }
        expect(result).toMatchObject({
          status: "rejected",
          reason: expect.objectContaining({
            message: expect.stringMatching(/file-backed|memory|incognito/i),
          }),
        });
        expect(requests).not.toHaveBeenCalled();
        expect((await readdir(directory, { recursive: true })).toSorted()).toEqual(contents);
      } finally {
        process.chdir(originalCwd);
        if (originalTsconfigPath === undefined) {
          delete process.env.TSX_TSCONFIG_PATH;
        } else {
          process.env.TSX_TSCONFIG_PATH = originalTsconfigPath;
        }
        requests.mockRestore();
      }
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
    const spy = vi
      .spyOn(Worker.prototype, "terminate")
      .mockImplementationOnce(async function (this: Worker) {
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

  nodeIt("rejects an overloaded admission without retiring healthy workers or writes", async () => {
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
    for (let round = 0; round < 32; round += 1) {
      for (const [index, store] of active.entries()) {
        writes.push(append(store, `${index}:${round}`));
      }
    }
    const outcomes = Promise.allSettled(writes);
    try {
      await repliesReady.promise;
      const pendingFile = databasePath();
      await expectRejectedOpen(pendingFile, undefined, "overloaded");
      releaseReplies();
      const results = await outcomes;
      expect(results.find((result) => result.status === "rejected")).toBeUndefined();
      for (const [index, store] of active.entries()) {
        expect(await read(store)).toEqual(
          Array.from({ length: 32 }, (_, round) => `${index}:${round}`),
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

  it("bounds outstanding requests and accepts work again after the queue drains", async () => {
    const store = await open(databasePath());
    // The burst is admitted in one main-thread turn, before worker replies can drain it.
    const accepted = Array.from({ length: 128 }, (_, index) => append(store, String(index)));
    await expect(append(store, "overflow")).rejects.toMatchObject({ code: "overloaded" });
    await Promise.all(accepted);
    expect(await append(store, "after drain")).toMatchObject({ writes: 129 });
    expect(await read(store)).toEqual([
      ...Array.from({ length: 128 }, (_, i) => String(i)),
      "after drain",
    ]);
  });

  it("surfaces native-close cleanup failure and permits explicit recovery of committed data", async () => {
    const file = databasePath();
    const store = await open(file);
    const receipt = await append(store, "preserved");
    await store.execute({ type: "failClose", input: undefined });
    const closed = store.close();
    stores.delete(store);
    await expect(closed).rejects.toThrow("Fixture native database closed with a cleanup failure");

    const recovered = await open(file);
    expect(await read(recovered)).toEqual(["preserved"]);
    const recoveredReceipt = await append(recovered, "after recovery");
    expect(recoveredReceipt.actor).not.toBe(receipt.actor);
    expect(recoveredReceipt.writes).toBe(1);
    expect(await read(recovered)).toEqual(["preserved", "after recovery"]);
  });

  it.each([false, true])(
    "awaits delayed native cleanup before close settles (reject: %s)",
    async (reject) => {
      const file = databasePath();
      const markerPath = path.join(path.dirname(file), "closed");
      const store = await open(file);
      await append(store, "preserved");
      await store.execute({ type: "delayClose", input: { markerPath, reject } });
      stores.delete(store);
      const events = vi.spyOn(Worker.prototype, "emit");
      try {
        const [result] = await Promise.allSettled([store.close()]);
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
    const queued = append(store, "never dispatched");
    const results = await Promise.allSettled([lost, queued]);
    expect(results).toEqual([
      { status: "rejected", reason: expect.objectContaining({ code: "outcome-unknown" }) },
      { status: "rejected", reason: expect.objectContaining({ code: "unavailable" }) },
    ]);
    await expect(store.close()).rejects.toMatchObject({ code: "unavailable" });
    stores.delete(store);

    const recovered = await open(file);
    expect(await read(recovered)).toEqual(["committed"]);
    expect(await append(recovered, "explicit recovery")).toMatchObject({ writes: 1 });
    expect(await read(recovered)).toEqual(["committed", "explicit recovery"]);
  });
});
