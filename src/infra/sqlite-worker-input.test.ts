import { createHash } from "node:crypto";
import { deserialize, serialize } from "node:v8";
import { Worker } from "node:worker_threads";
import { expect, it, onTestFinished, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { onInternalDiagnosticEvent, waitForDiagnosticEventsDrained } from "./diagnostic-events.js";
import type { DiagnosticWorkerRequestFields } from "./diagnostic-process-types.js";
import {
  SQLITE_WORKER_MAX_RESULT_BYTES,
  type SqliteWorkerReply,
  type SqliteWorkerRequest,
} from "./sqlite-worker-contract.js";
import {
  useSqliteWorkerStoreFixture,
  appendWorkerRow as append,
} from "./sqlite-worker-fixture.test-support.js";
import {
  reserveSqliteWorkerInputPreparation,
  type SqliteWorkerStore,
} from "./sqlite-worker-store.js";
import type { FixtureOperations } from "./sqlite-worker-store.test-support.js";
import {
  SQLITE_WORKER_TRANSFER_FRAME_BYTES,
  type SqliteWorkerTransferFrame,
} from "./sqlite-worker-transfer.js";

const { stores, databasePath, open } = useSqliteWorkerStoreFixture("sqlite-worker-input-", () => {
  vi.restoreAllMocks();
});
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const payload = (mib: number) => "x".repeat(mib * 1024 * 1024);
const frameSizes = (bytes: Uint8Array) => [bytes.byteLength, bytes.buffer.byteLength];

function interceptPosts(transform: (request: SqliteWorkerRequest) => SqliteWorkerRequest) {
  // oxlint-disable-next-line typescript/unbound-method -- call preserves the sending worker.
  const original = Worker.prototype.postMessage;
  function post(this: Worker, ...args: Parameters<Worker["postMessage"]>) {
    return original.call(this, transform(args[0]), args[1]);
  }
  return vi.spyOn(Worker.prototype, "postMessage").mockImplementation(post);
}

function interceptReplies(
  observe: (reply: SqliteWorkerReply, publish: () => boolean) => boolean | void,
) {
  // oxlint-disable-next-line typescript/unbound-method -- Reflect.apply preserves the emitting worker.
  const original = Worker.prototype.emit;
  function emit(this: Worker, ...args: Parameters<Worker["emit"]>) {
    const publish = () => Reflect.apply(original, this, args);
    return args[0] === "message" && observe(args[1] as SqliteWorkerReply, publish)
      ? true
      : publish();
  }
  return vi.spyOn(Worker.prototype, "emit").mockImplementation(emit);
}

async function expectRows(store: SqliteWorkerStore<FixtureOperations>, expected: string[]) {
  const rows = await store.execute({ type: "read", input: undefined });
  const fingerprint = (row: string) => ({ length: row.length, digest: digest(row) });
  expect(rows.map(fingerprint)).toEqual(expected.map(fingerprint));
}

function holdFirstStagedChunk() {
  const held = createDeferredCore();
  let publish: (() => void) | undefined;
  let acknowledgments = 0;
  const messages = interceptReplies((reply, emit) => {
    if (reply.ok && reply.input === "next" && ++acknowledgments === 2) {
      publish = emit;
      held.resolve();
      return true;
    }
    return false;
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

it("snapshots and persists a 72 MiB append across reopening with bounded frames", async () => {
  const file = databasePath();
  const store = await open(file);
  await waitForDiagnosticEventsDrained();
  const completed: DiagnosticWorkerRequestFields[] = [];
  onTestFinished(
    onInternalDiagnosticEvent(
      (event) => {
        if (event.type === "worker.request" && event.phase === "completed") {
          completed.push(event);
        }
      },
      { include: ["worker.request"] },
    ),
  );
  const replyTimings: Array<NonNullable<DiagnosticWorkerRequestFields["timing"]>> = [];
  const value = payload(72);
  const inputFrames: number[][] = [];
  const dispatchedInputs: Uint8Array[] = [];
  const receivedFrames: Array<{ size: number; framed: boolean }> = [];
  const commands: SqliteWorkerRequest["type"][] = [];
  interceptPosts((request) => {
    commands.push(request.type);
    if ("input" in request) {
      dispatchedInputs.push(request.input);
    }
    if (request.type === "execute-frame") {
      inputFrames.push(frameSizes(request.input));
    }
    return request;
  });
  interceptReplies((reply) => {
    if (reply.ok) {
      if (reply.timing) {
        replyTimings.push(reply.timing);
      }
      receivedFrames.push({
        size: Math.max(...frameSizes(reply.value)),
        framed: reply.transfer === "frame",
      });
    }
  });
  const command = { type: "append" as const, input: { value } };
  const admitted = store.execute(command);
  command.input.value = "caller changed the input";
  expect(await admitted).toMatchObject({ writes: 1 });
  expect(commands.filter((kind) => kind === "execute-start")).toHaveLength(1);
  expect(inputFrames.length).toBeGreaterThan(1);
  expect(dispatchedInputs.every((input) => input.byteLength === 0)).toBe(true);
  await waitForDiagnosticEventsDrained();
  expect(completed).toHaveLength(1);
  const appendTiming = completed[0]?.timing;
  expect(replyTimings.length).toBeGreaterThan(1);
  expect(replyTimings[0]?.inputReady).toBeUndefined();
  expect(appendTiming?.received).toBe(replyTimings[0]?.received);
  expect(appendTiming?.inputReady).toBeGreaterThanOrEqual(replyTimings[0]!.replied!);
  expect(appendTiming?.executeFinished).toBeGreaterThanOrEqual(appendTiming!.inputReady!);
  const appendReplyCount = replyTimings.length;
  await expectRows(store, [value]);
  await waitForDiagnosticEventsDrained();
  expect(completed).toHaveLength(2);
  const readTiming = completed[1]?.timing;
  const readReplies = replyTimings.slice(appendReplyCount);
  expect(readReplies.length).toBeGreaterThan(1);
  expect(readTiming?.received).toBeGreaterThan(appendTiming!.received!);
  for (const timing of readReplies) {
    expect(timing.received).toBe(readTiming?.received);
    expect(timing.inputReady).toBe(readTiming?.inputReady);
    expect(timing.executeStarted).toBe(readTiming?.executeStarted);
    expect(timing.executeFinished).toBe(readTiming?.executeFinished);
    expect(timing.serialized).toBe(readTiming?.serialized);
  }
  expect(readTiming?.replied).toBeGreaterThan(readReplies[0]!.replied!);
  expect(readTiming?.replyReceived).toBeGreaterThanOrEqual(readTiming!.replied!);
  await store.close();
  await expectRows(await open(file), [value]);
  expect(Math.max(...inputFrames.flat())).toBeLessThanOrEqual(
    SQLITE_WORKER_TRANSFER_FRAME_BYTES + 1024,
  );
  for (const frame of receivedFrames) {
    const limit = frame.framed
      ? SQLITE_WORKER_TRANSFER_FRAME_BYTES + 1024
      : SQLITE_WORKER_MAX_RESULT_BYTES;
    expect(frame.size).toBeLessThanOrEqual(limit);
  }
  expect(receivedFrames.some((frame) => frame.framed)).toBe(true);
});

it("reserves 32 MiB for active oversized input while preserving cancellation and queue credit", async () => {
  const store = await open(databasePath());
  const concurrentInputs = Array.from({ length: 3 }, () =>
    reserveSqliteWorkerInputPreparation(64 * 1024 * 1024),
  );
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
    for (const prepared of concurrentInputs) {
      prepared.release();
    }
    queuedCancel.abort();
    replacementCancel.abort();
    hold.release();
    await Promise.allSettled([active, queued, replacement]);
  }
});

it("retires failed staging before any append executes and releases credits for recovery", async () => {
  const file = databasePath();
  const store = await open(file);
  const post = interceptPosts((request) => {
    if (request.type === "execute-frame") {
      post.mockRestore();
      const frame = deserialize(request.input) as SqliteWorkerTransferFrame;
      return { ...request, input: serialize({ ...frame, sequence: frame.sequence + 1 }) };
    }
    return request;
  });
  const value = payload(72);
  const staged = append(store, value);
  const queued = append(store, "must not run");
  try {
    expect(await Promise.allSettled([staged, queued])).toEqual([
      { status: "rejected", reason: expect.objectContaining({ code: "outcome-unknown" }) },
      { status: "rejected", reason: expect.objectContaining({ code: "unavailable" }) },
    ]);
    stores.delete(store);
    await expect(store.close()).resolves.toBeUndefined();
    const recovered = await open(file);
    await expectRows(recovered, []);
    expect(await append(recovered, value)).toMatchObject({ writes: 1 });
    await expectRows(recovered, [value]);
  } finally {
    post.mockRestore();
    await Promise.allSettled([staged, queued, store.close()]);
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
