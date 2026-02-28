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
    isDisallowedIntentsError?: (err: unknown) => boolean;
    pendingGatewayErrors?: unknown[];
  }) => {
    const start = vi.fn(params?.start ?? (async () => undefined));
    const stop = vi.fn(params?.stop ?? (async () => undefined));
    const threadStop = vi.fn();
    const runtimeLog = vi.fn();
    const runtimeError = vi.fn();
    const runtimeExit = vi.fn();
    const releaseEarlyGatewayErrorGuard = vi.fn();
    const runtime: RuntimeEnv = {
      log: runtimeLog,
      error: runtimeError,
      exit: runtimeExit,
    };
    return {
      start,
      stop,
      threadStop,
      runtimeError,
      releaseEarlyGatewayErrorGuard,
      lifecycleParams: {
        accountId: params?.accountId ?? "default",
        client: { getPlugin: vi.fn(() => undefined) } as unknown as Client,
        runtime,
        isDisallowedIntentsError: params?.isDisallowedIntentsError ?? (() => false),
        voiceManager: null,
        voiceManagerRef: { current: null },
        execApprovalsHandler: { start, stop },
        threadBindings: { stop: threadStop },
        pendingGatewayErrors: params?.pendingGatewayErrors,
        releaseEarlyGatewayErrorGuard,
      },
    };
  };

  function expectLifecycleCleanup(params: {
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    threadStop: ReturnType<typeof vi.fn>;
    waitCalls: number;
    releaseEarlyGatewayErrorGuard: ReturnType<typeof vi.fn>;
  }) {
    expect(params.start).toHaveBeenCalledTimes(1);
    expect(params.stop).toHaveBeenCalledTimes(1);
    expect(waitForDiscordGatewayStopMock).toHaveBeenCalledTimes(params.waitCalls);
    expect(unregisterGatewayMock).toHaveBeenCalledWith("default");
    expect(stopGatewayLoggingMock).toHaveBeenCalledTimes(1);
    expect(params.threadStop).toHaveBeenCalledTimes(1);
    expect(params.releaseEarlyGatewayErrorGuard).toHaveBeenCalledTimes(1);
  }

  it("cleans up thread bindings when exec approvals startup fails", async () => {
    const { runDiscordGatewayLifecycle } = await import("./provider.lifecycle.js");
    const { lifecycleParams, start, stop, threadStop, releaseEarlyGatewayErrorGuard } =
      createLifecycleHarness({
        start: async () => {
          throw new Error("startup failed");
        },
      });

    await expect(runDiscordGatewayLifecycle(lifecycleParams)).rejects.toThrow("startup failed");

    expectLifecycleCleanup({
      start,
      stop,
      threadStop,
      waitCalls: 0,
      releaseEarlyGatewayErrorGuard,
    });
  });

  it("cleans up when gateway wait fails after startup", async () => {
    const { runDiscordGatewayLifecycle } = await import("./provider.lifecycle.js");
    waitForDiscordGatewayStopMock.mockRejectedValueOnce(new Error("gateway wait failed"));
    const { lifecycleParams, start, stop, threadStop, releaseEarlyGatewayErrorGuard } =
      createLifecycleHarness();

    await expect(runDiscordGatewayLifecycle(lifecycleParams)).rejects.toThrow(
      "gateway wait failed",
    );

    expectLifecycleCleanup({
      start,
      stop,
      threadStop,
      waitCalls: 1,
      releaseEarlyGatewayErrorGuard,
    });
  });

  it("cleans up after successful gateway wait", async () => {
    const { runDiscordGatewayLifecycle } = await import("./provider.lifecycle.js");
    const { lifecycleParams, start, stop, threadStop, releaseEarlyGatewayErrorGuard } =
      createLifecycleHarness();

    await expect(runDiscordGatewayLifecycle(lifecycleParams)).resolves.toBeUndefined();

    expectLifecycleCleanup({
      start,
      stop,
      threadStop,
      waitCalls: 1,
      releaseEarlyGatewayErrorGuard,
    });
  });

  it("handles queued disallowed intents errors without waiting for gateway events", async () => {
    const { runDiscordGatewayLifecycle } = await import("./provider.lifecycle.js");
    const {
      lifecycleParams,
      start,
      stop,
      threadStop,
      runtimeError,
      releaseEarlyGatewayErrorGuard,
    } = createLifecycleHarness({
      pendingGatewayErrors: [new Error("Fatal Gateway error: 4014")],
      isDisallowedIntentsError: (err) => String(err).includes("4014"),
    });

    await expect(runDiscordGatewayLifecycle(lifecycleParams)).resolves.toBeUndefined();

    expect(runtimeError).toHaveBeenCalledWith(
      expect.stringContaining("discord: gateway closed with code 4014"),
    );
    expectLifecycleCleanup({
      start,
      stop,
      threadStop,
      waitCalls: 0,
      releaseEarlyGatewayErrorGuard,
    });
  });

  it("throws queued non-disallowed fatal gateway errors", async () => {
    const { runDiscordGatewayLifecycle } = await import("./provider.lifecycle.js");
    const { lifecycleParams, start, stop, threadStop, releaseEarlyGatewayErrorGuard } =
      createLifecycleHarness({
        pendingGatewayErrors: [new Error("Fatal Gateway error: 4000")],
      });

    await expect(runDiscordGatewayLifecycle(lifecycleParams)).rejects.toThrow(
      "Fatal Gateway error: 4000",
    );

    expectLifecycleCleanup({
      start,
      stop,
      threadStop,
      waitCalls: 0,
      releaseEarlyGatewayErrorGuard,
    });
  });
});

describe("discord gateway circuit breaker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    attachDiscordGatewayLoggingMock.mockClear();
    waitForDiscordGatewayStopMock.mockClear();
    registerGatewayMock.mockClear();
    unregisterGatewayMock.mockClear();
    stopGatewayLoggingMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createCircuitBreakerHarness() {
    const { EventEmitter } = require("node:events");
    const emitter = new EventEmitter();
    const runtimeLog = vi.fn();
    const runtimeError = vi.fn();
    const runtimeExit = vi.fn();
    const runtime: RuntimeEnv = {
      log: runtimeLog,
      error: runtimeError,
      exit: runtimeExit,
    };
    const gatewayState = { sessionId: "test-session", resumeGatewayUrl: "wss://test.discord.gg" };
    const disconnectMock = vi.fn();
    const connectMock = vi.fn();
    const gateway = {
      isConnected: false,
      state: gatewayState,
      disconnect: disconnectMock,
      connect: connectMock,
      options: { reconnect: { maxAttempts: 50 } },
    };
    const abort = new AbortController();

    // Make getDiscordGatewayEmitter return our real emitter
    getDiscordGatewayEmitterMock.mockReturnValue(emitter);

    // Make getPlugin return our mock gateway
    const client = {
      getPlugin: vi.fn(() => gateway),
    } as unknown as Client;

    // waitForDiscordGatewayStop should hang until abort
    waitForDiscordGatewayStopMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          abort.signal.addEventListener("abort", () => resolve(), { once: true });
        }),
    );

    const start = vi.fn(async () => undefined);
    const stop = vi.fn(async () => undefined);
    const threadStop = vi.fn();
    const releaseEarlyGatewayErrorGuard = vi.fn();

    return {
      emitter,
      gateway,
      gatewayState,
      disconnectMock,
      connectMock,
      runtimeLog,
      runtimeError,
      abort,
      lifecycleParams: {
        accountId: "test",
        client,
        runtime,
        isDisallowedIntentsError: () => false,
        voiceManager: null,
        voiceManagerRef: { current: null },
        execApprovalsHandler: { start, stop },
        threadBindings: { stop: threadStop },
        releaseEarlyGatewayErrorGuard,
      },
    };
  }

  it("clears session state after 5 consecutive stalls", async () => {
    const { runDiscordGatewayLifecycle } = await import("./provider.lifecycle.js");
    const {
      emitter,
      gatewayState,
      disconnectMock,
      connectMock,
      runtimeLog,
      abort,
      lifecycleParams,
    } = createCircuitBreakerHarness();

    const lifecyclePromise = runDiscordGatewayLifecycle(lifecycleParams);

    // Simulate 5 consecutive stalls: WS opens but no HELLO within 30s
    for (let i = 0; i < 5; i++) {
      emitter.emit("debug", "WebSocket connection opened");
      await vi.advanceTimersByTimeAsync(30001);
    }

    // After 5 stalls, session state should be cleared
    expect(gatewayState.sessionId).toBeNull();
    expect(gatewayState.resumeGatewayUrl).toBeNull();

    // The log should mention clearing session for fresh IDENTIFY
    expect(runtimeLog).toHaveBeenCalledWith(
      expect.stringContaining("clearing session to force fresh IDENTIFY"),
    );

    // disconnect + connect should have been called on each stall
    expect(disconnectMock).toHaveBeenCalledTimes(5);
    expect(connectMock).toHaveBeenCalledTimes(5);

    abort.abort();
    await lifecyclePromise;
  });

  it("resets stall counter when gateway connects before timeout", async () => {
    const { runDiscordGatewayLifecycle } = await import("./provider.lifecycle.js");
    const harness = createCircuitBreakerHarness();
    const { emitter, gatewayState, abort, lifecycleParams } = harness;

    const lifecyclePromise = runDiscordGatewayLifecycle(lifecycleParams);

    // Simulate 3 stalls (gateway stays disconnected)
    for (let i = 0; i < 3; i++) {
      emitter.emit("debug", "WebSocket connection opened");
      await vi.advanceTimersByTimeAsync(30001);
    }

    // Next WS open — this time HELLO arrives (gateway becomes connected)
    emitter.emit("debug", "WebSocket connection opened");
    harness.gateway.isConnected = true;
    await vi.advanceTimersByTimeAsync(30001);

    // Counter should be reset. 3 more stalls should NOT trigger the breaker.
    harness.gateway.isConnected = false;
    for (let i = 0; i < 3; i++) {
      emitter.emit("debug", "WebSocket connection opened");
      await vi.advanceTimersByTimeAsync(30001);
    }

    // Only 3 stalls since reset — session state should still be intact
    expect(gatewayState.sessionId).toBe("test-session");
    expect(gatewayState.resumeGatewayUrl).toBe("wss://test.discord.gg");

    abort.abort();
    await lifecyclePromise;
  });

  it("logs stall count on each non-final stall", async () => {
    const { runDiscordGatewayLifecycle } = await import("./provider.lifecycle.js");
    const { emitter, runtimeLog, abort, lifecycleParams } = createCircuitBreakerHarness();

    const lifecyclePromise = runDiscordGatewayLifecycle(lifecycleParams);

    // Trigger 3 stalls
    for (let i = 0; i < 3; i++) {
      emitter.emit("debug", "WebSocket connection opened");
      await vi.advanceTimersByTimeAsync(30001);
    }

    // Should see stall count in log messages
    expect(runtimeLog).toHaveBeenCalledWith(expect.stringContaining("stall 1/5"));
    expect(runtimeLog).toHaveBeenCalledWith(expect.stringContaining("stall 2/5"));
    expect(runtimeLog).toHaveBeenCalledWith(expect.stringContaining("stall 3/5"));

    abort.abort();
    await lifecyclePromise;
  });

  it("does not trigger circuit breaker when gateway is connected", async () => {
    const { runDiscordGatewayLifecycle } = await import("./provider.lifecycle.js");
    const harness = createCircuitBreakerHarness();
    const { emitter, gatewayState, disconnectMock, abort, lifecycleParams } = harness;

    const lifecyclePromise = runDiscordGatewayLifecycle(lifecycleParams);

    // Mark gateway as connected — timeout should reset the counter, not stall
    harness.gateway.isConnected = true;

    for (let i = 0; i < 10; i++) {
      emitter.emit("debug", "WebSocket connection opened");
      await vi.advanceTimersByTimeAsync(30001);
    }

    // Gateway is connected, so disconnect should never be called
    expect(disconnectMock).toHaveBeenCalledTimes(0);
    expect(gatewayState.sessionId).toBe("test-session");

    // Even after going disconnected again, counter was reset by successful
    // connections — 4 stalls should not trigger the breaker
    harness.gateway.isConnected = false;
    for (let i = 0; i < 4; i++) {
      emitter.emit("debug", "WebSocket connection opened");
      await vi.advanceTimersByTimeAsync(30001);
    }

    expect(gatewayState.sessionId).toBe("test-session");

    abort.abort();
    await lifecyclePromise;
  });
});
