import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createProcessSupervisor } from "./supervisor.js";
import { createStubChildAdapter } from "./supervisor.test-support.js";

const { createChild } = vi.hoisted(() => ({
  createChild: vi.fn<typeof import("./adapters/child.js").createChildAdapter>(),
}));
vi.mock("./adapters/child.js", () => ({ createChildAdapter: createChild }));
afterEach(() => {
  createChild.mockReset();
  vi.useRealTimers();
});

it("keeps construction cancellation active after subscribing to output", async () => {
  vi.useFakeTimers();
  const ready = createDeferred();
  const cleanup = createDeferred();
  const adapter = createStubChildAdapter();
  const subscribed = createDeferred();
  const subscribe = adapter.onStdout;
  adapter.onStdout = (...args) => {
    subscribe(...args);
    subscribed.resolve();
  };
  const abort = vi.fn();
  createChild.mockImplementationOnce(async (input) => {
    input.onSpawnCleanup?.(cleanup.promise);
    input.abortSignal?.addEventListener("abort", abort, { once: true });
    return { adapter: { ...adapter, onExit: vi.fn(), onError: vi.fn() }, ready: ready.promise };
  });
  const supervisor = createProcessSupervisor();
  const starting = supervisor.spawn({
    mode: "child",
    argv: ["synthetic-child"],
    runId: "pending-private-input",
    noOutputTimeoutMs: 10,
  });
  await subscribed.promise;
  adapter.emitStdout("early");
  await vi.advanceTimersByTimeAsync(10);
  await vi.advanceTimersToNextTimerAsync();
  const run = await starting;
  await expect(run.wait()).resolves.toMatchObject({ reason: "no-output-timeout", stdout: "early" });
  expect(abort).toHaveBeenCalledOnce();
  cleanup.resolve();
  const closed = vi.fn();
  const shutdown = supervisor.shutdown().then(closed);
  await Promise.resolve();
  expect(closed).not.toHaveBeenCalled();
  expect(adapter.disposeMock).not.toHaveBeenCalled();
  ready.reject(new Error("private input aborted"));
  await shutdown;
  expect(closed).toHaveBeenCalledOnce();
  expect(adapter.disposeMock).toHaveBeenCalledOnce();
});

it("preserves a readiness error while retaining a failed cleanup owner", async () => {
  const ready = createDeferred();
  const cleanup = createDeferred();
  const subscribed = createDeferred();
  const adapter = createStubChildAdapter();
  adapter.onStdout = () => subscribed.resolve();
  createChild.mockImplementationOnce(async (input) => {
    input.onSpawnCleanup?.(cleanup.promise);
    return { adapter: { ...adapter, onExit: vi.fn(), onError: vi.fn() }, ready: ready.promise };
  });
  const supervisor = createProcessSupervisor();
  const starting = supervisor.spawn({ mode: "child", argv: ["synthetic-child"] });
  const startupFailure = expect(starting).rejects.toThrow("private input failed");
  await subscribed.promise;
  ready.reject(new Error("private input failed"));
  await startupFailure;
  expect(adapter.disposeMock).not.toHaveBeenCalled();
  cleanup.reject(new Error("cleanup identity lost"));
  await expect(supervisor.shutdown()).rejects.toThrow("cleanup identity lost");
  expect(adapter.disposeMock).toHaveBeenCalledOnce();
});

it("retains an early run failure until the caller requests its result", async () => {
  const result = createDeferred<{ code: number | null; signal: NodeJS.Signals | null }>();
  const cleanup = createDeferred();
  const adapter = {
    ...createStubChildAdapter(),
    onExit: vi.fn(),
    onError: vi.fn(),
    wait: () => result.promise,
    waitForExtinction: () => cleanup.promise,
  };
  createChild.mockResolvedValue({ adapter, ready: Promise.resolve() });
  const supervisor = createProcessSupervisor();
  const run = await supervisor.spawn({ mode: "child", argv: ["synthetic-child"] });
  const unhandled = vi.fn();
  const failure = new Error("synthetic early result failure");
  process.on("unhandledRejection", unhandled);
  try {
    result.reject(failure);
    await nextTurn();
    await nextTurn();
    expect(unhandled).not.toHaveBeenCalled();
    await expect(run.wait()).rejects.toBe(failure);
  } finally {
    await run.wait().catch(() => undefined);
    cleanup.resolve();
    await supervisor.shutdown();
    process.off("unhandledRejection", unhandled);
  }
});
