import { EventEmitter } from "node:events";
import type { Client } from "@buape/carbon";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../../runtime.js";
import type { WaitForDiscordGatewayStopParams } from "../monitor.gateway.js";

const {
  attachDiscordGatewayLoggingMock,
  getDiscordGatewayEmitterMock,
  registerGatewayMock,
  stopGatewayLoggingMock,
  unregisterGatewayMock,
  waitForDiscordGatewayStopMock,
} = vi.hoisted(() => {
  const stopGatewayLoggingMock = vi.fn();
  const getDiscordGatewayEmitterMock = vi.fn<() => EventEmitter | undefined>(() => undefined);
  return {
    attachDiscordGatewayLoggingMock: vi.fn(() => stopGatewayLoggingMock),
    getDiscordGatewayEmitterMock,
    waitForDiscordGatewayStopMock: vi.fn((_params: WaitForDiscordGatewayStopParams) =>
      Promise.resolve(),
    ),
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
    gateway?: {
      isConnected?: boolean;
      options?: Record<string, unknown>;
      disconnect?: () => void;
      connect?: (resume?: boolean) => void;
      state?: {
        sessionId?: string | null;
        resumeGatewayUrl?: string | null;
        sequence?: number | null;
      };
      sequence?: number | null;
      emitter?: EventEmitter;
    };
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
      runtimeLog,
      runtimeError,
      releaseEarlyGatewayErrorGuard,
      lifecycleParams: {
        accountId: params?.accountId ?? "default",
        client: {
          getPlugin: vi.fn((name: string) => (name === "gateway" ? params?.gateway : undefined)),
        } as unknown as Client,
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

  it("retries stalled HELLO with resume before forcing fresh identify", async () => {
    vi.useFakeTimers();
    try {
      const { runDiscordGatewayLifecycle } = await import("./provider.lifecycle.js");
      const emitter = new EventEmitter();
      const gateway = {
        isConnected: false,
        options: {},
        disconnect: vi.fn(),
        connect: vi.fn(),
        state: {
          sessionId: "session-1",
          resumeGatewayUrl: "wss://gateway.discord.gg",
          sequence: 123,
        },
        sequence: 123,
        emitter,
      };
      getDiscordGatewayEmitterMock.mockReturnValueOnce(emitter);
      waitForDiscordGatewayStopMock.mockImplementationOnce(async () => {
        emitter.emit("debug", "WebSocket connection opened");
        await vi.advanceTimersByTimeAsync(30000);
        emitter.emit("debug", "WebSocket connection opened");
        await vi.advanceTimersByTimeAsync(30000);
        emitter.emit("debug", "WebSocket connection opened");
        await vi.advanceTimersByTimeAsync(30000);
      });

      const { lifecycleParams } = createLifecycleHarness({ gateway });
      await expect(runDiscordGatewayLifecycle(lifecycleParams)).resolves.toBeUndefined();

      expect(gateway.disconnect).toHaveBeenCalledTimes(3);
      expect(gateway.connect).toHaveBeenNthCalledWith(1, true);
      expect(gateway.connect).toHaveBeenNthCalledWith(2, true);
      expect(gateway.connect).toHaveBeenNthCalledWith(3, false);
      expect(gateway.state.sessionId).toBeNull();
      expect(gateway.state.resumeGatewayUrl).toBeNull();
      expect(gateway.state.sequence).toBeNull();
      expect(gateway.sequence).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("resets HELLO stall counter after a successful reconnect that drops quickly", async () => {
    vi.useFakeTimers();
    try {
      const { runDiscordGatewayLifecycle } = await import("./provider.lifecycle.js");
      const emitter = new EventEmitter();
      const gateway = {
        isConnected: false,
        options: {},
        disconnect: vi.fn(),
        connect: vi.fn(),
        state: {
          sessionId: "session-2",
          resumeGatewayUrl: "wss://gateway.discord.gg",
          sequence: 456,
        },
        sequence: 456,
        emitter,
      };
      getDiscordGatewayEmitterMock.mockReturnValueOnce(emitter);
      waitForDiscordGatewayStopMock.mockImplementationOnce(async () => {
        emitter.emit("debug", "WebSocket connection opened");
        await vi.advanceTimersByTimeAsync(30000);

        // Successful reconnect (READY/RESUMED sets isConnected=true), then
        // quick drop before the HELLO timeout window finishes.
        gateway.isConnected = true;
        emitter.emit("debug", "WebSocket connection opened");
        await vi.advanceTimersByTimeAsync(10);
        emitter.emit("debug", "WebSocket connection closed with code 1006");
        gateway.isConnected = false;

        emitter.emit("debug", "WebSocket connection opened");
        await vi.advanceTimersByTimeAsync(30000);

        emitter.emit("debug", "WebSocket connection opened");
        await vi.advanceTimersByTimeAsync(30000);
      });

      const { lifecycleParams } = createLifecycleHarness({ gateway });
      await expect(runDiscordGatewayLifecycle(lifecycleParams)).resolves.toBeUndefined();

      expect(gateway.connect).toHaveBeenCalledTimes(3);
      expect(gateway.connect).toHaveBeenNthCalledWith(1, true);
      expect(gateway.connect).toHaveBeenNthCalledWith(2, true);
      expect(gateway.connect).toHaveBeenNthCalledWith(3, true);
      expect(gateway.connect).not.toHaveBeenCalledWith(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("force-stops when reconnect stalls after a close event", async () => {
    vi.useFakeTimers();
    try {
      const { runDiscordGatewayLifecycle } = await import("./provider.lifecycle.js");
      const emitter = new EventEmitter();
      const gateway = {
        isConnected: false,
        options: {},
        disconnect: vi.fn(),
        connect: vi.fn(),
        emitter,
      };
      getDiscordGatewayEmitterMock.mockReturnValueOnce(emitter);
      waitForDiscordGatewayStopMock.mockImplementationOnce(
        (waitParams: WaitForDiscordGatewayStopParams) =>
          new Promise<void>((_resolve, reject) => {
            waitParams.registerForceStop?.((err) => reject(err));
          }),
      );
      const { lifecycleParams } = createLifecycleHarness({ gateway });

      const lifecyclePromise = runDiscordGatewayLifecycle(lifecycleParams);
      lifecyclePromise.catch(() => {});
      emitter.emit("debug", "WebSocket connection closed with code 1006");

      await vi.advanceTimersByTimeAsync(5 * 60_000 + 1_000);
      await expect(lifecyclePromise).rejects.toThrow("reconnect watchdog timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not force-stop when reconnect resumes before watchdog timeout", async () => {
    vi.useFakeTimers();
    try {
      const { runDiscordGatewayLifecycle } = await import("./provider.lifecycle.js");
      const emitter = new EventEmitter();
      const gateway = {
        isConnected: false,
        options: {},
        disconnect: vi.fn(),
        connect: vi.fn(),
        emitter,
      };
      getDiscordGatewayEmitterMock.mockReturnValueOnce(emitter);
      let resolveWait: (() => void) | undefined;
      waitForDiscordGatewayStopMock.mockImplementationOnce(
        (waitParams: WaitForDiscordGatewayStopParams) =>
          new Promise<void>((resolve, reject) => {
            resolveWait = resolve;
            waitParams.registerForceStop?.((err) => reject(err));
          }),
      );
      const { lifecycleParams, runtimeLog } = createLifecycleHarness({ gateway });

      const lifecyclePromise = runDiscordGatewayLifecycle(lifecycleParams);
      emitter.emit("debug", "WebSocket connection closed with code 1006");
      await vi.advanceTimersByTimeAsync(60_000);

      gateway.isConnected = true;
      emitter.emit("debug", "WebSocket connection opened");
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 1_000);

      expect(runtimeLog).not.toHaveBeenCalledWith(
        expect.stringContaining("reconnect watchdog timeout"),
      );
      resolveWait?.();
      await expect(lifecyclePromise).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
