import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { prepareEmbeddedAttemptTimeout } from "../agents/embedded-agent-runner/run/attempt-timeout-prepare.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { acquireSystemAgentInferenceOwner } from "./inference-owner.js";
const m = vi.hoisted(() => ({
  acquire: vi.fn(),
  resolve: vi.fn(),
  caller: vi.fn(),
  signal: undefined as AbortSignal | undefined,
}));
vi.mock("../agents/prepared-model-runtime.js", () => ({
  acquirePublishedPreparedModelRuntime: m.acquire,
  preparedModelRuntimeConfigsMatch: (a: unknown, b: unknown) =>
    JSON.stringify(a) === JSON.stringify(b),
}));
vi.mock("./verified-inference.js", () => ({ resolveSystemAgentVerifiedInferenceState: m.resolve }));
vi.mock("../agents/tools/gateway-caller-context.js", () => ({
  captureGatewayToolCallerAssertion: () => m.caller,
  getGatewayToolCallerIdentity: () => ({ approvalSignals: m.signal ? [m.signal] : [] }),
}));
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const cfg = { label: "verified" };
const state = { config: cfg, route: { agentId: "owner", agentDir: "/synthetic" } };
function lease() {
  return {
    snapshot: { config: cfg },
    pluginGeneration: {},
    [Symbol.asyncDispose]: vi.fn(async () => {}),
  };
}
function start(timeoutMs = 10000) {
  return acquireSystemAgentInferenceOwner({
    binding: {} as never,
    deps: {},
    timeoutMs,
    isBindingCurrent: () => true,
  });
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  m.signal = undefined;
  m.resolve.mockResolvedValue(state);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
describe("selected-owner admission deadline and custody", () => {
  it("stops admission deadline at handoff and preserves real approval pause and resume", async () => {
    const l = lease();
    m.acquire.mockResolvedValue(l);
    const result = await start(40);
    const abortRun = vi.fn();
    const timeout = prepareEmbeddedAttemptTimeout({
      attempt: { runId: "review-pause", sessionId: "review-pause-session", timeoutMs: 40 },
      activeSession: { isCompacting: false, isStreaming: false },
      compactionState: { isCompacting: () => false },
      compactionTimeoutMs: 50,
      runAbortSignal: result.signal,
      isProbeSession: true,
      abortRun,
      markTimedOutDuringCompaction: vi.fn(),
      markTimedOutByRunBudget: vi.fn(),
    });
    emitAgentEvent({
      runId: "review-pause",
      sessionId: "review-pause-session",
      stream: "lifecycle",
      data: { phase: "waiting-approval", approvalId: "review-approval" },
    });
    expect(timeout.getRunAbortDeadlineAtMs()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(65);
    expect(abortRun).not.toHaveBeenCalled();
    expect(result.signal.aborted).toBe(false);
    emitAgentEvent({
      runId: "review-pause",
      sessionId: "review-pause-session",
      stream: "lifecycle",
      data: { phase: "approval-resolved", approvalId: "review-approval" },
    });
    await vi.advanceTimersByTimeAsync(39);
    expect(abortRun).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(abortRun).toHaveBeenCalledExactlyOnceWith(true);
    timeout.clearTimers();
    await result[Symbol.asyncDispose]();
  });
  it("preserves the real embedded compaction grace after successful handoff", async () => {
    const l = lease();
    m.acquire.mockResolvedValue(l);
    const result = await start(40);
    const abortRun = vi.fn();
    const timeout = prepareEmbeddedAttemptTimeout({
      attempt: {
        runId: "review-compaction",
        sessionId: "review-compaction-session",
        timeoutMs: 40,
      },
      activeSession: { isCompacting: true, isStreaming: false },
      compactionState: { isCompacting: () => true },
      compactionTimeoutMs: 100,
      runAbortSignal: result.signal,
      isProbeSession: true,
      abortRun,
      markTimedOutDuringCompaction: vi.fn(),
      markTimedOutByRunBudget: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(65);
    expect(abortRun).not.toHaveBeenCalled();
    expect(result.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(74);
    expect(abortRun).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(abortRun).toHaveBeenCalledExactlyOnceWith(true);
    timeout.clearTimers();
    await result[Symbol.asyncDispose]();
  });
  it("unlimited sentinel arms no admission or embedded finite timer", async () => {
    const timer = vi.spyOn(globalThis, "setTimeout");
    const native = vi.spyOn(AbortSignal, "timeout");
    const l = lease();
    m.acquire.mockResolvedValue(l);
    const result = await start(MAX_TIMER_TIMEOUT_MS);
    const timeout = prepareEmbeddedAttemptTimeout({
      attempt: {
        runId: "unlimited",
        sessionId: "unlimited-session",
        timeoutMs: MAX_TIMER_TIMEOUT_MS,
      },
      activeSession: { isCompacting: false, isStreaming: false },
      compactionState: { isCompacting: () => false },
      compactionTimeoutMs: 100,
      runAbortSignal: result.signal,
      isProbeSession: true,
      abortRun: vi.fn(),
      markTimedOutDuringCompaction: vi.fn(),
      markTimedOutByRunBudget: vi.fn(),
    });
    expect(timer).not.toHaveBeenCalled();
    expect(native).not.toHaveBeenCalled();
    expect(timeout.getRunAbortDeadlineAtMs()).toBeUndefined();
    timeout.clearTimers();
    await result[Symbol.asyncDispose]();
  });
  it("handoff clears admission timer before preparation and retains caller cancellation", async () => {
    const c = new AbortController();
    m.signal = c.signal;
    m.acquire.mockResolvedValue(lease());
    const result = await start(40);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(result.signal.aborted).toBe(false);
    c.abort();
    expect(result.signal.aborted).toBe(true);
    await result[Symbol.asyncDispose]();
  });
  it("admission deadline cancels a known pending acquisition and disposes its late lease exactly once", async () => {
    const entered = deferred<void>(),
      pending = deferred<ReturnType<typeof lease>>(),
      l = lease();
    m.acquire.mockImplementation(() => {
      entered.resolve();
      return pending.promise;
    });
    const result = start(25);
    const rejection = expect(result).rejects.toThrow(/aborted|timeout/i);
    await entered.promise;
    await vi.advanceTimersByTimeAsync(25);
    await rejection;
    expect(l[Symbol.asyncDispose]).not.toHaveBeenCalled();
    pending.resolve(l);
    await vi.advanceTimersByTimeAsync(0);
    expect(l[Symbol.asyncDispose]).toHaveBeenCalledTimes(1);
  });
  it.each(["abort-first", "lease-first"])(
    "same-turn %s settlement releases once",
    async (order) => {
      const entered = deferred<void>(),
        pending = deferred<ReturnType<typeof lease>>(),
        l = lease();
      const c = new AbortController();
      m.signal = c.signal;
      m.acquire.mockImplementation(() => {
        entered.resolve();
        return pending.promise;
      });
      const result = start();
      const rejection = expect(result).rejects.toThrow(/abort/i);
      await entered.promise;
      if (order === "abort-first") {
        c.abort();
        pending.resolve(l);
      } else {
        pending.resolve(l);
        c.abort();
      }
      await rejection;
      await vi.advanceTimersByTimeAsync(0);
      expect(l[Symbol.asyncDispose]).toHaveBeenCalledTimes(1);
    },
  );
  it("aborts post-acquisition revalidation without leaking retained lease", async () => {
    const entered = deferred<void>(),
      pending = deferred<typeof state>(),
      l = lease();
    const c = new AbortController();
    m.signal = c.signal;
    m.acquire.mockResolvedValue(l);
    m.resolve.mockResolvedValueOnce(state).mockImplementationOnce(() => {
      entered.resolve();
      return pending.promise;
    });
    const result = start();
    const rejection = expect(result).rejects.toThrow(/abort/i);
    await entered.promise;
    c.abort();
    await rejection;
    expect(l[Symbol.asyncDispose]).toHaveBeenCalledTimes(1);
    pending.resolve(state);
    await Promise.resolve();
    expect(l[Symbol.asyncDispose]).toHaveBeenCalledTimes(1);
  });
  it("rejects a config/publication mismatch and releases lease", async () => {
    const l = lease();
    m.acquire.mockResolvedValue(l);
    m.resolve
      .mockResolvedValueOnce(state)
      .mockResolvedValueOnce({ ...state, config: { label: "unpublished" } });
    await expect(start()).rejects.toThrow();
    expect(l[Symbol.asyncDispose]).toHaveBeenCalledTimes(1);
  });
  it("transfers successful custody without early disposal and preserves disposable symbol", async () => {
    const l = lease();
    m.acquire.mockResolvedValue(l);
    const result = await start();
    expect(l[Symbol.asyncDispose]).not.toHaveBeenCalled();
    expect(result.pluginGeneration).toBe(l.pluginGeneration);
    await result[Symbol.asyncDispose]();
    expect(l[Symbol.asyncDispose]).toHaveBeenCalledTimes(1);
  });
});
