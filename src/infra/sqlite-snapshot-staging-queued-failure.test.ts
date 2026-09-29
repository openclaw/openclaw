import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../shared/deferred.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import type { RetainedOperation } from "./retained-operation.js";
import {
  cleanupSnapshotOperations,
  removeTempDirectoryAsync,
} from "./sqlite-readonly-location-cleanup.js";
import { captureSqliteReadOnlyWorkerLaunch } from "./sqlite-readonly-worker.js";
import {
  allocateWorkerOwnedSqliteSnapshotDirectory,
  captureSqliteSnapshotStagingOwner,
} from "./sqlite-snapshot-staging-owner.js";
import type { SqliteSnapshotStagingRequest } from "./sqlite-snapshot-staging.types.js";
import { captureRetainedNativeWorkerSource } from "./worker-native-lifecycle.js";
import type { RetainedNativeWorker } from "./worker-native-lifecycle.types.js";

type NativeSubscription =
  | [event: "message", listener: (message: unknown) => void]
  | [event: "error" | "messageerror", listener: (error: Error) => void]
  | [event: "started", listener: () => void]
  | [event: "execution-exit" | "exit", listener: (code: number | undefined) => void];

function holdAllocatedReply(
  native: RetainedNativeWorker,
  receive: (directory: string) => boolean,
): void {
  const on = native.on.bind(native);
  function listen(event: "message", listener: (message: unknown) => void): unknown;
  function listen(event: "error" | "messageerror", listener: (error: Error) => void): unknown;
  function listen(event: "started", listener: () => void): unknown;
  function listen(event: "execution-exit", listener: (code: number | undefined) => void): unknown;
  function listen(event: "exit", listener: (code: number | undefined) => void): unknown;
  function listen(...[event, listener]: NativeSubscription): unknown {
    if (event !== "message") {
      return Reflect.apply(on, native, [event, listener]);
    }
    return on("message", (message) => {
      if (
        isRecord(message) &&
        message.status === "ok" &&
        typeof message.taskId === "number" &&
        isRecord(message.value) &&
        message.value.type === "allocated" &&
        typeof message.value.directory === "string" &&
        receive(message.value.directory)
      ) {
        return;
      }
      listener(message);
    });
  }
  native.on = listen;
}

const directories = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupSnapshotOperations();
    cleanup();
  });
});

it("rejects a queued retained allocation after its earlier native owner fails while host callbacks are blocked", async () => {
  const root = directories.make("staging-queued-owner-failure-");
  const owner = captureSqliteSnapshotStagingOwner();
  const source = captureRetainedNativeWorkerSource({ runtimeGeneration: undefined });
  const create = source.create.bind(source);
  const allocated = createDeferredCore<{ native: RetainedNativeWorker; directory: string }>();
  let heldReply = false;
  const creation = vi.spyOn(source, "create").mockImplementation((...args) => {
    const native = create(...args);
    holdAllocatedReply(native, (directory) => {
      if (heldReply) {
        return false;
      }
      heldReply = true;
      allocated.resolve({ native, directory });
      return true;
    });
    return native;
  });
  const start = owner.start.bind(owner);
  const captured: { first?: SqliteSnapshotStagingRequest } = {};
  const admission = vi.spyOn(owner, "start").mockImplementation((...args) => {
    const request = start(...args);
    captured.first ??= request;
    return request;
  });
  let directory: string | undefined;
  let native: RetainedNativeWorker | undefined;
  let nativeJoined = false;
  let firstSettled = false;
  let second: SqliteSnapshotStagingRequest | undefined;
  let stopping: RetainedOperation<void> | undefined;
  let later: Awaited<ReturnType<typeof allocateWorkerOwnedSqliteSnapshotDirectory>> | undefined;
  const first = allocateWorkerOwnedSqliteSnapshotDirectory(root, false);
  const firstOutcome = first.then(
    () => {
      throw new Error("Lost allocation delivery unexpectedly succeeded");
    },
    (error: unknown) => {
      firstSettled = true;
      return {
        error,
        directoryExists: directory !== undefined && fs.existsSync(directory),
        nativeJoined,
      };
    },
  );
  void firstOutcome.catch(() => undefined);
  try {
    const held = await Promise.race([
      allocated.promise,
      first.then(() => {
        throw new Error("First allocation settled before its reply gate");
      }),
    ]);
    ({ native, directory } = held);
    creation.mockRestore();
    admission.mockRestore();
    native.once("exit", () => {
      nativeJoined = true;
    });
    const before = fs.readdirSync(root);
    expect(before).toEqual([path.basename(directory)]);
    const { env, cwd } = captureSqliteReadOnlyWorkerLaunch();
    second = owner.start({
      type: "allocate",
      root,
      allowLegacyWorker: false,
      launch: { env, cwd, transport: { kind: "native" } },
    });
    expect(second.read()).toEqual({ status: "pending" });
    expect(captured.first?.read()).toEqual({ status: "pending" });
    stopping = native.stop();
    void stopping.result.catch(() => undefined);
    let microtaskRan = false;
    queueMicrotask(() => {
      microtaskRan = true;
    });
    const pause = new Int32Array(new SharedArrayBuffer(4));
    const deadline = performance.now() + 10_000;
    let outcome = second.read();
    while (outcome.status === "pending" && performance.now() < deadline) {
      // Only B drives real progress; A's async wrapper cannot run its catch/startClose yet.
      second.service();
      outcome = second.read();
      if (outcome.status === "pending") {
        Atomics.wait(pause, 0, 0, 2);
      }
    }
    expect(microtaskRan).toBe(false);
    expect(firstSettled).toBe(false);
    expect(native.executionStopped).toBe(true);
    expect(captured.first?.read().status).not.toBe("fulfilled");
    expect(nativeJoined).toBe(false);
    expect(fs.readdirSync(root)).toEqual(before);
    const token = new (requireNodeSqlite().DatabaseSync)(path.join(directory, "owner.sqlite"), {
      timeout: 0,
    });
    try {
      expect(() => token.exec("BEGIN IMMEDIATE")).toThrow(/locked|busy/i);
    } finally {
      if (token.isTransaction) {
        token.exec("ROLLBACK");
      }
      token.close();
    }
    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected") {
      throw new Error("Queued allocation retained input behind a failed native owner");
    }
    expect(outcome.error).toBeInstanceOf(Error);
    // Now yield: the original async allocation wrapper owns A's cleanup and rejection.
    const rejected = await firstOutcome;
    expect(rejected.error).toBeInstanceOf(Error);
    expect(rejected.directoryExists).toBe(false);
    expect(rejected.nativeJoined).toBe(true);
    await second.startClose().result;
    expect(fs.readdirSync(root)).toEqual([]);
    later = await allocateWorkerOwnedSqliteSnapshotDirectory(root, false);
    expect(fs.existsSync(later.directory)).toBe(true);
    expect(await removeTempDirectoryAsync(later.directory)).toBe(true);
    later = undefined;
  } finally {
    creation.mockRestore();
    admission.mockRestore();
    // Failed assertions still join the original A and B resources without changing their results.
    const closes = [captured.first?.startClose().result, second?.startClose().result].filter(
      (close) => close !== undefined,
    );
    await Promise.all(closes);
    await Promise.allSettled(
      [first, firstOutcome, second?.result, stopping?.result].filter(
        (result) => result !== undefined,
      ),
    );
    if (native) {
      await native.stop().result;
    }
    if (later) {
      expect(await removeTempDirectoryAsync(later.directory)).toBe(true);
    }
  }
  expect(fs.readdirSync(root)).toEqual([]);
});
