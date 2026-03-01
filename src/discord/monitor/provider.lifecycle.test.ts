import { EventEmitter } from "node:events";
import type { Client } from "@buape/carbon";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../../runtime.js";

const {
  attachDiscordGatewayLoggingMock,
  getDiscordGatewayEmitterMock,
  registerGatewayMock,
  stopGatewayLoggingMock,
  unregisterGatewayMock,
  waitForDiscordGatewayStopMock,
} = vi.hoisted(() => {
  const stopGatewayLoggingMock = vi.fn();
  return {
    attachDiscordGatewayLoggingMock: vi.fn(() => stopGatewayLoggingMock),
    getDiscordGatewayEmitterMock: vi.fn(() => undefined),
    waitForDiscordGatewayStopMock: vi.fn(() => Promise.resolve()),
    registerGatewayMock: vi.fn(),
    unregisterGatewayMock: vi.fn(),
    stopGatewayLoggingMock,
  };
});

vi.mock("../gateway-logging.js", () => ({
  attachDiscordGatewayLogging: attachDiscordGatewayLoggingMock,
}));

vi.mock("../monitor.gateway.js", () => ({
  getDiscordGatewayEmitter: getDiscordGatewayEmitterMock,
  waitForDiscordGatewayStop: waitForDiscordGatewayStopMock,
}));

vi.mock("./gateway-registry.js", () => ({
  registerGateway: registerGatewayMock,
  unregisterGateway: unregisterGatewayMock,
}));

describe("runDiscordGatewayLifecycle", () => {
  beforeEach(() => {
    attachDiscordGatewayLoggingMock.mockClear();
    getDiscordGatewayEmitterMock.mockClear();
    waitForDiscordGatewayStopMock.mockClear();
    registerGatewayMock.mockClear();
    unregisterGatewayMock.mockClear();
    stopGatewayLoggingMock.mockClear();
  });

  const createLifecycleHarness = (params?: {
    accountId?: string;
    start?: () => Promise<void>;
    stop?: () => Promise<void>;
  }) => {
    const start = vi.fn(params?.start ?? (async () => undefined));
    const stop = vi.fn(params?.stop ?? (async () => undefined));
    const threadStop = vi.fn();
    return {
      start,
      stop,
      threadStop,
      lifecycleParams: {
        accountId: params?.accountId ?? "default",
        client: { getPlugin: vi.fn(() => undefined) } as unknown as Client,
        runtime: {} as RuntimeEnv,
        isDisallowedIntentsError: () => false,
        voiceManager: null,
        voiceManagerRef: { current: null },
        execApprovalsHandler: { start, stop },
        threadBindings: { stop: threadStop },
      },
    };
  };

  function expectLifecycleCleanup(params: {
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    threadStop: ReturnType<typeof vi.fn>;
    waitCalls: number;
  }) {
    expect(params.start).toHaveBeenCalledTimes(1);
    expect(params.stop).toHaveBeenCalledTimes(1);
    expect(waitForDiscordGatewayStopMock).toHaveBeenCalledTimes(params.waitCalls);
    expect(unregisterGatewayMock).toHaveBeenCalledWith("default");
    expect(stopGatewayLoggingMock).toHaveBeenCalledTimes(1);
    expect(params.threadStop).toHaveBeenCalledTimes(1);
  }

  it("cleans up thread bindings when exec approvals startup fails", async () => {
    const { runDiscordGatewayLifecycle } = await import("./provider.lifecycle.js");
    const { lifecycleParams, start, stop, threadStop } = createLifecycleHarness({
      start: async () => {
        throw new Error("startup failed");
      },
    });

    await expect(runDiscordGatewayLifecycle(lifecycleParams)).rejects.toThrow("startup failed");

    expectLifecycleCleanup({ start, stop, threadStop, waitCalls: 0 });
  });

  it("cleans up when gateway wait fails after startup", async () => {
    const { runDiscordGatewayLifecycle } = await import("./provider.lifecycle.js");
    waitForDiscordGatewayStopMock.mockRejectedValueOnce(new Error("gateway wait failed"));
    const { lifecycleParams, start, stop, threadStop } = createLifecycleHarness();

    await expect(runDiscordGatewayLifecycle(lifecycleParams)).rejects.toThrow(
      "gateway wait failed",
    );

    expectLifecycleCleanup({ start, stop, threadStop, waitCalls: 1 });
  });

  it("cleans up after successful gateway wait", async () => {
    const { runDiscordGatewayLifecycle } = await import("./provider.lifecycle.js");
    const { lifecycleParams, start, stop, threadStop } = createLifecycleHarness();

    await expect(runDiscordGatewayLifecycle(lifecycleParams)).resolves.toBeUndefined();

    expectLifecycleCleanup({ start, stop, threadStop, waitCalls: 1 });
  });
});

describe("reconnect watchdog", () => {
  // Each test uses fake timers so we can advance the 5-minute watchdog without
  // waiting for real wall-clock time.
  afterEach(() => {
    vi.useRealTimers();
    attachDiscordGatewayLoggingMock.mockReset();
    getDiscordGatewayEmitterMock.mockReset();
    waitForDiscordGatewayStopMock.mockReset();
    registerGatewayMock.mockReset();
    unregisterGatewayMock.mockReset();
    stopGatewayLoggingMock.mockReset();
    attachDiscordGatewayLoggingMock.mockImplementation(() => stopGatewayLoggingMock);
    getDiscordGatewayEmitterMock.mockReturnValue(undefined);
    waitForDiscordGatewayStopMock.mockResolvedValue(undefined);
  });

  /**
   * Build a test harness where:
   * - The gateway has a real EventEmitter so debug events can be simulated.
   * - `waitForDiscordGatewayStop` is mocked to capture the `registerForceStop`
   *   callback and expose it to the test, allowing the test to both trigger the
   *   watchdog (by emitting "WebSocket connection closed" and advancing timers)
   *   and to resolve the wait normally when needed.
   */
  function createWatchdogHarness() {
    const emitter = new EventEmitter();
    getDiscordGatewayEmitterMock.mockReturnValue(emitter);

    let resolveWait: (() => void) | undefined;
    let rejectWait: ((err: unknown) => void) | undefined;

    waitForDiscordGatewayStopMock.mockImplementation(
      (params: {
        registerForceStop?: (fn: (err: unknown) => void) => void;
        [key: string]: unknown;
      }) => {
        const p = new Promise<void>((resolve, reject) => {
          resolveWait = resolve;
          rejectWait = reject;
        });
        // Simulate what the real waitForDiscordGatewayStop does: hand out
        // finishReject to the caller via registerForceStop.
        params.registerForceStop?.(rejectWait!);
        return p;
      },
    );

    const runtimeError = vi.fn();
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: runtimeError,
      exit: vi.fn(),
    };
    const threadStop = vi.fn();

    const lifecycleParams = {
      accountId: "default",
      client: { getPlugin: vi.fn(() => undefined) } as unknown as Client,
      runtime,
      isDisallowedIntentsError: () => false,
      voiceManager: null,
      voiceManagerRef: { current: null },
      execApprovalsHandler: null,
      threadBindings: { stop: threadStop },
    };

    return {
      emitter,
      runtimeError,
      threadStop,
      lifecycleParams,
      resolveWait: () => resolveWait?.(),
    };
  }

  it("force-stops the lifecycle when WebSocket stays closed beyond the watchdog timeout", async () => {
    vi.useFakeTimers();
    const { runDiscordGatewayLifecycle } = await import("./provider.lifecycle.js");

    const { emitter, runtimeError, threadStop, lifecycleParams } = createWatchdogHarness();

    const lifecyclePromise = runDiscordGatewayLifecycle(lifecycleParams);
    // Attach an early catch so Node.js does not report an "unhandledRejection"
    // during the gap between the timer firing and the assertion below.
    lifecyclePromise.catch(() => {});

    // Simulate the gateway WebSocket closing (the carbon library emits this
    // debug message when the connection drops).
    emitter.emit("debug", "WebSocket connection closed");

    // Advance past the 5-minute reconnect watchdog timeout.
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1000);

    // The watchdog should have called forceStop, causing the lifecycle to
    // reject with the watchdog error.
    await expect(lifecyclePromise).rejects.toThrow("reconnect watchdog timeout");

    expect(runtimeError).toHaveBeenCalledWith(expect.stringContaining("reconnect watchdog"));
    expect(threadStop).toHaveBeenCalledTimes(1);
    expect(unregisterGatewayMock).toHaveBeenCalledWith("default");
  });

  it("clears the watchdog when the WebSocket reconnects before the timeout", async () => {
    vi.useFakeTimers();
    const { runDiscordGatewayLifecycle } = await import("./provider.lifecycle.js");

    const { emitter, runtimeError, resolveWait, lifecycleParams } = createWatchdogHarness();

    const lifecyclePromise = runDiscordGatewayLifecycle(lifecycleParams);

    // Connection drops.
    emitter.emit("debug", "WebSocket connection closed");

    // Advance only 2 minutes (less than the 5-minute watchdog).
    await vi.advanceTimersByTimeAsync(2 * 60_000);

    // Connection re-established — watchdog should be cleared.
    emitter.emit("debug", "WebSocket connection opened");

    // Advance past where the original watchdog would have fired (still safe).
    await vi.advanceTimersByTimeAsync(3 * 60_000 + 1000);

    // Lifecycle resolves normally (no watchdog rejection).
    resolveWait();
    await expect(lifecyclePromise).resolves.toBeUndefined();

    expect(runtimeError).not.toHaveBeenCalledWith(expect.stringContaining("reconnect watchdog"));
  });

  it("does not fire the watchdog if no 'WebSocket connection closed' event is emitted", async () => {
    vi.useFakeTimers();
    const { runDiscordGatewayLifecycle } = await import("./provider.lifecycle.js");

    const { runtimeError, resolveWait, lifecycleParams } = createWatchdogHarness();

    const lifecyclePromise = runDiscordGatewayLifecycle(lifecycleParams);

    // No connection-closed event — advance well past the watchdog window.
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    resolveWait();
    await expect(lifecyclePromise).resolves.toBeUndefined();

    expect(runtimeError).not.toHaveBeenCalledWith(expect.stringContaining("reconnect watchdog"));
  });
});
