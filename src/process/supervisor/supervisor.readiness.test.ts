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

it.each(["manual-cancel", "overall-timeout", "no-output-timeout"] as const)(
  "keeps %s construction cancellation active after subscribing to output",
  async (reason) => {
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
      ...(reason === "overall-timeout" ? { timeoutMs: 10 } : {}),
      ...(reason === "no-output-timeout" ? { noOutputTimeoutMs: 10 } : {}),
    });
    await subscribed.promise;
    adapter.emitStdout("early");
    if (reason === "manual-cancel") {
      supervisor.cancel("pending-private-input");
    } else {
      await vi.advanceTimersByTimeAsync(10);
    }
    const run = await starting;
    await expect(run.wait()).resolves.toMatchObject({ reason, stdout: "early" });
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
  },
);

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
