import { createHash } from "node:crypto";
import path from "node:path";
import { deserialize, serialize } from "node:v8";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../shared/deferred.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import {
  SQLITE_WORKER_MAX_RESULT_BYTES,
  type SqliteWorkerReply,
  type SqliteWorkerRequest,
} from "./sqlite-worker-contract.js";
import { openSqliteWorkerStore, type SqliteWorkerStore } from "./sqlite-worker-store.js";
import type { FixtureOperations } from "./sqlite-worker-store.test-support.js";
import {
  SQLITE_WORKER_TRANSFER_FRAME_BYTES,
  type SqliteWorkerTransferFrame,
} from "./sqlite-worker-transfer.js";
import { ownedWorkerBytes } from "./worker-transfer-bytes.js";

const stores = new Set<SqliteWorkerStore<FixtureOperations>>();
const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    try {
      await Promise.all([...stores].map((store) => store.close()));
    } finally {
      stores.clear();
      cleanup();
    }
  }),
);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const payload = (mib: number) => "x".repeat(mib * 1024 * 1024);
const databasePath = () => path.join(dirs.make("sqlite-worker-input-"), "store.sqlite");

async function open(file: string) {
  const store = await openSqliteWorkerStore<FixtureOperations>({
    moduleUrl: new URL("./sqlite-worker-store.test-support.ts", import.meta.url),
    databasePath: file,
    input: undefined,
  });
  stores.add(store);
  return store;
}

function append(store: SqliteWorkerStore<FixtureOperations>, value: string, signal?: AbortSignal) {
  return store.execute({ type: "append", input: { value } }, { signal });
}

async function expectRows(store: SqliteWorkerStore<FixtureOperations>, expected: string[]) {
  const rows = await store.execute({ type: "read", input: undefined });
  expect(rows.map((row) => ({ length: row.length, digest: digest(row) }))).toEqual(
    expected.map((row) => ({ length: row.length, digest: digest(row) })),
  );
}

function holdReply(matches: (reply: SqliteWorkerReply) => boolean) {
  const held = createDeferredCore();
  let publish: (() => void) | undefined;
  let captured = false;
  // oxlint-disable-next-line typescript/unbound-method -- Reflect.apply restores the emitting worker.
  const original = Worker.prototype.emit;
  const messages = vi.spyOn(Worker.prototype, "emit").mockImplementation(function (
    this: Worker,
    event: string | symbol,
    ...args: unknown[]
  ) {
    const reply = args[0] as SqliteWorkerReply;
    if (event === "message" && !captured && matches(reply)) {
      captured = true;
      publish = () => Reflect.apply(original, this, [event, ...args]);
      held.resolve();
      return true;
    }
    return Reflect.apply(original, this, [event, ...args]);
  });
  return {
    held: held.promise,
    release() {
      messages.mockRestore();
      publish?.();
      publish = undefined;
    },
  };
}

function holdFirstStagedChunk() {
  let acknowledgments = 0;
  return holdReply((reply) => reply.ok && reply.input === "next" && ++acknowledgments === 2);
}

describe("SQLite worker staged input", () => {
  it.each(["full", "sliced", "pooled"] as const)(
    "transfers the command snapshot while preserving the caller's %s bytes",
    async (kind) => {
      const store = await open(databasePath());
      const storage =
        kind === "pooled" ? Buffer.allocUnsafe(12).fill(91) : new Uint8Array(12).fill(91);
      const value = kind === "full" ? storage : storage.subarray(4, 8);
      const expected = Buffer.from(value).toString("hex");
      const sent: Array<{ before: number; after: number }> = [];
      // oxlint-disable-next-line typescript/unbound-method -- call restores the sending worker below.
      const original = Worker.prototype.postMessage;
      vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
        this: Worker,
        request: SqliteWorkerRequest,
        transferList,
      ) {
        if (request.type !== "execute") {
          return original.call(this, request, transferList);
        }
        const before = request.input.byteLength;
        const result = original.call(this, request, transferList);
        sent.push({ before, after: request.input.byteLength });
        return result;
      });
      const pending = store.execute({ type: "appendBytes", input: { value } });
      expect(storage.byteLength).toBe(12);
      value.fill(17);
      expect([...value]).toEqual(Array.from({ length: value.length }, () => 17));
      expect(await pending).toMatchObject({ writes: 1 });
      expect(await store.execute({ type: "read", input: undefined })).toEqual([expected]);
      expect(sent).toHaveLength(2);
      for (const input of sent) {
        expect(input.before).toBeGreaterThan(0);
        expect(input.after).toBe(0);
      }
    },
  );

  it.each([40, 72])("snapshots and persists one %s MiB append across reopening", async (mib) => {
    const file = databasePath();
    const store = await open(file);
    const value = payload(mib);
    const inputFrames: Array<{ visible: number; backing: number; after: number }> = [];
    const receivedFrames: Array<{ visible: number; backing: number; framed: boolean }> = [];
    const commands: SqliteWorkerRequest["type"][] = [];
    // oxlint-disable-next-line typescript/unbound-method -- call restores the sending worker below.
    const originalPost = Worker.prototype.postMessage;
    vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
      this: Worker,
      request: SqliteWorkerRequest,
      transferList,
    ) {
      commands.push(request.type);
      if (request.type === "execute-frame") {
        const visible = request.input.byteLength;
        const backing = request.input.buffer.byteLength;
        const result = originalPost.call(this, request, transferList);
        inputFrames.push({
          visible,
          backing,
          after: request.input.byteLength,
        });
        return result;
      }
      return originalPost.call(this, request, transferList);
    });
    // oxlint-disable-next-line typescript/unbound-method -- Reflect.apply restores the emitting worker.
    const originalEmit = Worker.prototype.emit;
    vi.spyOn(Worker.prototype, "emit").mockImplementation(function (
      this: Worker,
      event: string | symbol,
      ...args: unknown[]
    ) {
      const reply = args[0] as SqliteWorkerReply;
      if (event === "message" && reply.ok) {
        receivedFrames.push({
          visible: reply.value.byteLength,
          backing: reply.value.buffer.byteLength,
          framed: reply.transfer === "frame",
        });
      }
      return Reflect.apply(originalEmit, this, [event, ...args]);
    });
    const command = { type: "append" as const, input: { value } };
    const admitted = store.execute(command);
    command.input.value = "caller changed the input";
    expect(await admitted).toMatchObject({ writes: 1 });
    expect(commands.filter((kind) => kind === "execute-start")).toHaveLength(1);
    expect(inputFrames.length).toBeGreaterThan(1);
    await expectRows(store, [value]);
    await store.close();
    await expectRows(await open(file), [value]);
    for (const frame of inputFrames) {
      expect(frame.visible).toBeLessThanOrEqual(SQLITE_WORKER_TRANSFER_FRAME_BYTES + 1024);
      expect(frame.backing).toBeLessThanOrEqual(SQLITE_WORKER_TRANSFER_FRAME_BYTES + 1024);
      expect(frame.after).toBe(0);
    }
    for (const frame of receivedFrames) {
      const limit = frame.framed
        ? SQLITE_WORKER_TRANSFER_FRAME_BYTES + 1024
        : SQLITE_WORKER_MAX_RESULT_BYTES;
      expect(frame.visible).toBeLessThanOrEqual(limit);
      expect(frame.backing).toBeLessThanOrEqual(limit);
    }
    if (mib === 72) {
      expect(receivedFrames.some((frame) => frame.framed)).toBe(true);
    }
  });

  it("charges a queued 40 MiB command in full and frees its credits on cancellation", async () => {
    const store = await open(databasePath());
    const hold = holdReply(() => true);
    const ahead = append(store, "ahead");
    const cancelQueued = new AbortController();
    const replacementCancel = new AbortController();
    let queued: Promise<unknown> | undefined;
    let replacement: Promise<unknown> | undefined;
    try {
      await Promise.race([hold.held, ahead]);
      queued = append(store, payload(40), cancelQueued.signal);
      await expect(append(store, payload(30))).rejects.toMatchObject({ code: "overloaded" });
      const reason = new Error("cancel queued input");
      cancelQueued.abort(reason);
      await expect(queued).rejects.toBe(reason);
      replacement = append(store, payload(30), replacementCancel.signal);
      replacementCancel.abort(reason);
      await expect(replacement).rejects.toBe(reason);
      hold.release();
      expect(await ahead).toMatchObject({ writes: 1 });
      await expectRows(store, ["ahead"]);
    } finally {
      cancelQueued.abort();
      replacementCancel.abort();
      hold.release();
      await Promise.allSettled([ahead, queued, replacement]);
    }
  });

  it("reserves 32 MiB for active oversized input while preserving cancellation and queue credit", async () => {
    const store = await open(databasePath());
    const hold = holdFirstStagedChunk();
    const activeCancel = new AbortController();
    const queuedCancel = new AbortController();
    const replacementCancel = new AbortController();
    const value = payload(72);
    const active = append(store, value, activeCancel.signal);
    let queued: Promise<unknown> | undefined;
    let replacement: Promise<unknown> | undefined;
    try {
      await Promise.race([hold.held, active]);
      await expect(append(store, payload(72))).rejects.toMatchObject({ code: "overloaded" });
      await expect(append(store, payload(40))).rejects.toMatchObject({ code: "overloaded" });
      queued = append(store, payload(24), queuedCancel.signal);
      await expect(append(store, payload(16))).rejects.toMatchObject({ code: "overloaded" });
      const reason = new Error("cancel queued bytes");
      queuedCancel.abort(reason);
      await expect(queued).rejects.toBe(reason);
      replacement = append(store, payload(16), replacementCancel.signal);
      replacementCancel.abort(reason);
      await expect(replacement).rejects.toBe(reason);
      activeCancel.abort(new Error("owner stopped after dispatch"));
      hold.release();
      expect(await active).toMatchObject({ writes: 1 });
      await expectRows(store, [value]);
    } finally {
      queuedCancel.abort();
      replacementCancel.abort();
      hold.release();
      await Promise.allSettled([active, queued, replacement]);
    }
  });

  it.each(["malformed frame", "throw after transfer"] as const)(
    "retires staging after %s before any append executes and releases credits for recovery",
    async (failure) => {
      const file = databasePath();
      const store = await open(file);
      // oxlint-disable-next-line typescript/unbound-method -- call restores the sending worker below.
      const original = Worker.prototype.postMessage;
      const post = vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
        this: Worker,
        request: SqliteWorkerRequest,
        transferList,
      ) {
        if (request.type === "execute-frame") {
          post.mockRestore();
          if (failure === "throw after transfer") {
            original.call(this, request, transferList);
            throw new Error("Fixture transport failed after transferring input");
          }
          const frame = deserialize(request.input) as SqliteWorkerTransferFrame;
          const input = ownedWorkerBytes(serialize({ ...frame, sequence: frame.sequence + 1 }));
          return original.call(this, { ...request, input }, [input.buffer]);
        }
        return original.call(this, request, transferList);
      });
      const value = payload(failure === "throw after transfer" ? 40 : 72);
      const staged = append(store, value);
      const queued = append(store, "must not run");
      try {
        expect(await Promise.allSettled([staged, queued])).toEqual([
          { status: "rejected", reason: expect.objectContaining({ code: "outcome-unknown" }) },
          { status: "rejected", reason: expect.objectContaining({ code: "unavailable" }) },
        ]);
        stores.delete(store);
        await expect(store.close()).rejects.toMatchObject({ code: "unavailable" });
        const recovered = await open(file);
        await expectRows(recovered, []);
        expect(await append(recovered, value)).toMatchObject({ writes: 1 });
        await expectRows(recovered, [value]);
      } finally {
        post.mockRestore();
        await Promise.allSettled([staged, queued, store.close()]);
        stores.delete(store);
      }
    },
  );

  it("joins native exit after the first command transfer throws without replaying its write", async () => {
    const file = databasePath();
    const store = await open(file);
    let exited = false;
    // oxlint-disable-next-line typescript/unbound-method -- call restores the sending worker below.
    const original = Worker.prototype.postMessage;
    const post = vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
      this: Worker,
      request: SqliteWorkerRequest,
      transferList,
    ) {
      post.mockRestore();
      this.once("exit", () => {
        exited = true;
      });
      original.call(this, request, transferList);
      throw new Error("Fixture first post failed after transferring input");
    });
    const value = payload(1);
    const sent = append(store, value);
    const queued = append(store, "must not run");
    try {
      expect(await Promise.allSettled([sent, queued])).toEqual([
        { status: "rejected", reason: expect.objectContaining({ code: "outcome-unknown" }) },
        { status: "rejected", reason: expect.objectContaining({ code: "unavailable" }) },
      ]);
      expect(exited).toBe(true);
      await expect(store.close()).rejects.toMatchObject({ code: "unavailable" });
      stores.delete(store);
      const recovered = await open(file);
      const rows = await recovered.execute({ type: "read", input: undefined });
      // Native termination can precede or follow commit; neither result permits an automatic replay.
      expect(rows.length).toBeLessThanOrEqual(1);
      expect(rows.map(digest)).toEqual(rows.length === 1 ? [digest(value)] : []);
      expect(await append(recovered, "after recovery")).toMatchObject({ writes: 1 });
      await expectRows(recovered, [...rows, "after recovery"]);
    } finally {
      post.mockRestore();
      await Promise.allSettled([sent, queued, store.close()]);
      stores.delete(store);
    }
  });

  it.each(["client", "global"] as const)(
    "drains partial command staging on %s close",
    async (kind) => {
      const file = databasePath();
      const store = await open(file);
      const hold = holdFirstStagedChunk();
      const value = payload(72);
      const pending = append(store, value);
      let closing: Promise<void> | undefined;
      let closed = false;
      try {
        await Promise.race([hold.held, pending]);
        closing = (
          kind === "client" ? store.close() : drainGlobalSingletonLifecycleState("restart")
        ).then(() => {
          closed = true;
        });
        await expect(append(store, "after close")).rejects.toMatchObject({ code: "closed" });
        expect(closed).toBe(false);
        hold.release();
        expect(await pending).toMatchObject({ writes: 1 });
        await closing;
        expect(closed).toBe(true);
        await expectRows(await open(file), [value]);
      } finally {
        hold.release();
        await Promise.allSettled([pending, closing]);
      }
    },
  );
});
