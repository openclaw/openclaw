import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Worker } from "node:worker_threads";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { probeSqliteNativeClose } from "./bun-sqlite-close-probe.js";

vi.hoisted(() => vi.resetModules());

vi.mock("./runtime-worker-url.js", () => ({
  resolveRuntimeWorkerUrl: () => new URL("file:///fixture/sqlite-close-probe.js"),
}));

const workers: Pick<Worker, "emit" | "terminate" | "unref">[] = [];
const state = vi.hoisted(() => ({
  join: Promise.resolve(1),
  remove: vi.fn(async () => {}),
  warn: vi.fn(),
}));
vi.mock("node:fs/promises", () => ({
  mkdtemp: async () => "/private/close-probe",
  realpath: async (path: string) => path,
  rm: state.remove,
}));
vi.mock("node:timers/promises", () => ({ setImmediate: async () => {} }));
vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  Worker: class extends EventEmitter {
    terminate = vi.fn(() => state.join);
    unref = vi.fn(() => this);
    constructor() {
      super();
      workers.push(this);
    }
  },
}));

beforeEach(() => {
  vi.useFakeTimers();
  workers.length = 0;
  state.join = Promise.resolve(1);
  state.remove.mockClear();
  state.warn.mockClear();
  vi.spyOn(process, "emitWarning").mockImplementation(state.warn);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function start(stuck = false) {
  const join = createDeferredCore<number>();
  if (stuck) {
    state.join = join.promise;
  }
  const result = probeSqliteNativeClose();
  const settled = vi.fn();
  void result.then(settled);
  await vi.advanceTimersByTimeAsync(0);
  const worker = workers[0];
  assert(worker);
  return { worker, result, settled, join };
}

function expectConservative(settled: ReturnType<typeof vi.fn>, reason: string) {
  expect(settled).toHaveBeenCalledExactlyOnceWith({
    explicitSqliteCloseReleasesNativeResources: false,
    reason: expect.stringContaining(reason),
  });
}
function expectRetained() {
  expect(state.warn).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining("retained /private/close-probe"),
    { code: "SQLITE_CLOSE_PROBE_CLEANUP" },
  );
  expect(state.remove).not.toHaveBeenCalled();
}
async function expectFinished() {
  await vi.advanceTimersByTimeAsync(0);
  expect(state.remove).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
}

it.each([
  ["timeout", undefined, "timed out", false],
  ["error", new Error("native probe failed"), "native probe failed", false],
  ["exit", 1, "exited before its reply", false],
  ["message", undefined, "Invalid SQLite close check reply", false],
  ["message", "SQLite close check cannot establish WAL mode", "WAL", false],
  ["timeout", undefined, "timed out", true],
  ["error", new Error("probe failed"), "probe failed", true],
] as const)(
  "returns a conservative %s decision (%s / %s, stuck termination: %s)",
  async (event, value, reason, stuck) => {
    const { worker, settled, join } = await start(stuck);
    if (event === "timeout") {
      await vi.advanceTimersByTimeAsync(9_999);
      expect(settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
    } else {
      worker.emit(event, value);
      await vi.advanceTimersByTimeAsync(0);
    }
    expectConservative(settled, reason);
    expect(worker.terminate).toHaveBeenCalledOnce();
    if (!stuck) {
      expect(state.remove).toHaveBeenCalledOnce();
      return;
    }
    expect(worker.unref).toHaveBeenCalled();
    expect(state.remove).not.toHaveBeenCalled();
    expect(state.warn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    expectRetained();
    if (event === "error") {
      join.reject(new Error("late termination failure"));
    } else {
      join.resolve(1);
    }
    await expectFinished();
  },
);

it.each(["joined", "timeout", "rejection"] as const)(
  "accepts a successful reply only after native termination: %s",
  async (failure) => {
    const { worker, result, settled, join } = await start(true);
    worker.emit("message", "");
    await vi.advanceTimersByTimeAsync(0);
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(state.remove).not.toHaveBeenCalled();
    if (failure === "joined") {
      join.resolve(1);
      expect(await result).toMatchObject({ explicitSqliteCloseReleasesNativeResources: true });
      expect(state.remove).toHaveBeenCalledExactlyOnceWith("/private/close-probe", {
        recursive: true,
        force: true,
      });
      expect(vi.getTimerCount()).toBe(0);
      expect(worker.unref).not.toHaveBeenCalled();
      expect(state.warn).not.toHaveBeenCalled();
      return;
    }
    if (failure === "timeout") {
      await vi.advanceTimersByTimeAsync(4_999);
      expect(settled).not.toHaveBeenCalled();
      expect(state.remove).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
    } else {
      join.reject(new Error("native join failed"));
      await vi.advanceTimersByTimeAsync(0);
    }
    expectConservative(
      settled,
      failure === "timeout" ? "termination timed out" : "native join failed",
    );
    expect(worker.unref).toHaveBeenCalledOnce();
    expectRetained();
    join.resolve(1);
    await expectFinished();
  },
);
