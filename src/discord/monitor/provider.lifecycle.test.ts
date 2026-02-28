import type { Client } from "@buape/carbon";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
