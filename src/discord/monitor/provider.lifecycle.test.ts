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

  it("cleans up thread bindings when exec approvals startup fails", async () => {
    const { runDiscordGatewayLifecycle } = await import("./provider.lifecycle.js");

    const start = vi.fn(async () => {
      throw new Error("startup failed");
    });
    const stop = vi.fn(async () => undefined);
    const threadStop = vi.fn();

    await expect(
      runDiscordGatewayLifecycle({
        accountId: "default",
        client: { getPlugin: vi.fn(() => undefined) } as unknown as Client,
        runtime: {} as RuntimeEnv,
        isDisallowedIntentsError: () => false,
        voiceManager: null,
        voiceManagerRef: { current: null },
        execApprovalsHandler: { start, stop },
        threadBindings: { stop: threadStop },
      }),
    ).rejects.toThrow("startup failed");

    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(waitForDiscordGatewayStopMock).not.toHaveBeenCalled();
    expect(unregisterGatewayMock).toHaveBeenCalledWith("default");
    expect(stopGatewayLoggingMock).toHaveBeenCalledTimes(1);
    expect(threadStop).toHaveBeenCalledTimes(1);
  });

  it("cleans up when gateway wait fails after startup", async () => {
    const { runDiscordGatewayLifecycle } = await import("./provider.lifecycle.js");
    waitForDiscordGatewayStopMock.mockRejectedValueOnce(new Error("gateway wait failed"));

    const start = vi.fn(async () => undefined);
    const stop = vi.fn(async () => undefined);
    const threadStop = vi.fn();

    await expect(
      runDiscordGatewayLifecycle({
        accountId: "default",
        client: { getPlugin: vi.fn(() => undefined) } as unknown as Client,
        runtime: {} as RuntimeEnv,
        isDisallowedIntentsError: () => false,
        voiceManager: null,
        voiceManagerRef: { current: null },
        execApprovalsHandler: { start, stop },
        threadBindings: { stop: threadStop },
      }),
    ).rejects.toThrow("gateway wait failed");

    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(waitForDiscordGatewayStopMock).toHaveBeenCalledTimes(1);
    expect(unregisterGatewayMock).toHaveBeenCalledWith("default");
    expect(stopGatewayLoggingMock).toHaveBeenCalledTimes(1);
    expect(threadStop).toHaveBeenCalledTimes(1);
  });
});
