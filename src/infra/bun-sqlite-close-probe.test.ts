import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { probeSqliteNativeClose } from "./bun-sqlite-close-probe.js";

vi.hoisted(() => vi.resetModules());

vi.mock("./runtime-process-entrypoints.js", () => ({
  runtimeProcessEntrypoints: { sqliteCloseProbe: {} },
}));
vi.mock("./runtime-worker-url.js", () => ({
  resolveRuntimeWorkerUrl: () => new URL("file:///fixture/sqlite-close-probe.js"),
}));

const state = vi.hoisted(() => {
  const workers: (EventEmitter & {
    terminate: ReturnType<typeof vi.fn>;
    unref: ReturnType<typeof vi.fn>;
  })[] = [];
  return {
    workers,
    join: Promise.resolve(1),
    remove: vi.fn(async () => {}),
    warn: vi.fn(),
  };
});
vi.mock("node:fs/promises", () => ({
  mkdtemp: async () => "/private/close-probe",
  realpath: async (path: string) => path,
  rm: state.remove,
}));
vi.mock("node:timers/promises", () => ({ setImmediate: async () => {} }));
vi.mock("node:worker_threads", () => ({
  Worker: class extends EventEmitter {
    terminate = vi.fn(() => state.join);
    unref = vi.fn(() => this);
    constructor() {
      super();
      state.workers.push(this);
    }
  },
}));

beforeEach(() => {
  vi.useFakeTimers();
  state.workers.length = 0;
  state.join = Promise.resolve(1);
  state.remove.mockClear();
  state.warn.mockClear();
  vi.spyOn(process, "emitWarning").mockImplementation(state.warn);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function start() {
  const result = probeSqliteNativeClose();
  await vi.advanceTimersByTimeAsync(0);
  const worker = state.workers[0];
  assert(worker);
  return { worker, result };
}

it("joins the probe before deleting its private files or accepting success", async () => {
  const join = createDeferredCore<number>();
  state.join = join.promise;
  const { worker, result } = await start();
  worker.emit("message", "");
  await vi.advanceTimersByTimeAsync(0);
  expect(worker.terminate).toHaveBeenCalledOnce();
  expect(state.remove).not.toHaveBeenCalled();
  join.resolve(1);
  expect(await result).toMatchObject({ explicitSqliteCloseReleasesNativeResources: true });
  expect(state.remove).toHaveBeenCalledExactlyOnceWith("/private/close-probe", {
    recursive: true,
    force: true,
  });
  expect(vi.getTimerCount()).toBe(0);
  expect(worker.unref).not.toHaveBeenCalled();
  expect(state.warn).not.toHaveBeenCalled();
});

it("times out conservatively and joins before cleanup", async () => {
  const { worker, result } = await start();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(await result).toMatchObject({
    explicitSqliteCloseReleasesNativeResources: false,
    reason: expect.stringContaining("timed out"),
  });
  expect(worker.terminate).toHaveBeenCalledOnce();
  expect(state.remove).toHaveBeenCalledOnce();
});

it.each(["timeout", "error"] as const)(
  "returns a conservative %s decision without waiting for native termination",
  async (failure) => {
    const join = createDeferredCore<number>();
    state.join = join.promise;
    const { worker, result } = await start();
    const settled = vi.fn();
    void result.then(settled);
    if (failure === "timeout") {
      await vi.advanceTimersByTimeAsync(9_999);
      expect(settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
    } else {
      worker.emit("error", new Error("probe failed"));
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(settled).toHaveBeenCalledExactlyOnceWith({
      explicitSqliteCloseReleasesNativeResources: false,
      reason: expect.stringContaining(failure === "timeout" ? "timed out" : "probe failed"),
    });
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(worker.unref).toHaveBeenCalled();
    expect(state.remove).not.toHaveBeenCalled();
    expect(state.warn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(state.warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("retained /private/close-probe"),
      { code: "SQLITE_CLOSE_PROBE_CLEANUP" },
    );
    expect(state.remove).not.toHaveBeenCalled();
    if (failure === "error") {
      join.reject(new Error("late termination failure"));
    } else {
      join.resolve(1);
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(state.remove).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("bounds native termination after a successful reply and retains unconfirmed files", async () => {
  const join = createDeferredCore<number>();
  state.join = join.promise;
  const { worker, result } = await start();
  const settled = vi.fn();
  void result.then(settled);
  worker.emit("message", "");
  await vi.advanceTimersByTimeAsync(4_999);
  expect(settled).not.toHaveBeenCalled();
  expect(state.remove).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(settled).toHaveBeenCalledExactlyOnceWith({
    explicitSqliteCloseReleasesNativeResources: false,
    reason: expect.stringContaining("termination timed out"),
  });
  expect(worker.unref).toHaveBeenCalledOnce();
  expect(state.warn).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining("retained /private/close-probe"),
    { code: "SQLITE_CLOSE_PROBE_CLEANUP" },
  );
  join.resolve(1);
  await vi.advanceTimersByTimeAsync(0);
  expect(state.remove).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it.each([
  ["error", new Error("native probe failed"), "native probe failed"],
  ["exit", 1, "exited before its reply"],
  ["message", undefined, "Invalid SQLite close probe reply"],
  ["message", "SQLite close probe cannot establish WAL mode", "WAL"],
] as const)(
  "records conservative %s failures and cleans up after joining",
  async (event, value, reason) => {
    const { worker, result } = await start();
    worker.emit(event, value);
    expect(await result).toMatchObject({
      explicitSqliteCloseReleasesNativeResources: false,
      reason: expect.stringContaining(reason),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(state.remove).toHaveBeenCalledOnce();
  },
);

it("retains files and refuses success when native termination fails", async () => {
  const { worker, result } = await start();
  worker.terminate.mockRejectedValueOnce(new Error("native join failed"));
  worker.emit("message", "");
  expect(await result).toMatchObject({
    explicitSqliteCloseReleasesNativeResources: false,
    reason: expect.stringContaining("native join failed"),
  });
  expect(state.remove).not.toHaveBeenCalled();
});
