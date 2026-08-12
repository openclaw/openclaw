import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  closeOnStartupFailure: vi.fn(async () => {}),
  closeStartupTrace: vi.fn(),
  createGatewayHttpTransport: vi.fn(),
  createGatewayKernel: vi.fn(),
  finishGatewayStartup: vi.fn(),
}));

vi.mock("./server-kernel.js", () => ({
  createGatewayKernel: mocks.createGatewayKernel,
  gatewayKernelLogs: {
    log: { warn: vi.fn() },
    logChannels: {},
    logCron: {},
    logHealth: {},
    logHooks: {},
    logReload: {},
    logTailscale: {},
    logWsControl: {},
  },
  resetPreparedModelCatalogForTestCore: vi.fn(),
}));

vi.mock("./server-runtime-state.js", () => ({
  createGatewayHttpTransport: mocks.createGatewayHttpTransport,
}));

vi.mock("./server-startup-finish.js", () => ({
  finishGatewayStartup: mocks.finishGatewayStartup,
}));

import { startGatewayServerCore } from "./server-start.js";

function createKernel() {
  return {
    beginClosePrelude: vi.fn(),
    clearFallbackGatewayContextForServer: { get: () => vi.fn() },
    closeOnStartupFailure: mocks.closeOnStartupFailure,
    createCloseHandler: vi.fn(),
    createHttpTransportOptions: vi.fn(() => ({})),
    runClosePrelude: vi.fn(),
    startupTrace: { close: mocks.closeStartupTrace },
    stopRegisteredGatewayLifetimeSidecars: vi.fn(),
    stopRegisteredPostReadySidecars: vi.fn(),
    terminalSessions: { disposeAll: vi.fn() },
    transportBridge: { attach: vi.fn() },
  };
}

describe("gateway server startup failure cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createGatewayKernel.mockResolvedValue(createKernel());
    mocks.createGatewayHttpTransport.mockResolvedValue({});
    mocks.finishGatewayStartup.mockResolvedValue(undefined);
  });

  it.each([
    ["transport creation", mocks.createGatewayHttpTransport],
    ["startup finalization", mocks.finishGatewayStartup],
  ])("closes tracing before teardown when %s fails", async (_label, fail) => {
    const order: string[] = [];
    fail.mockRejectedValueOnce(new Error("startup failed"));
    mocks.closeStartupTrace.mockImplementationOnce(() => order.push("trace"));
    mocks.closeOnStartupFailure.mockImplementationOnce(async () => {
      order.push("teardown");
    });

    await expect(startGatewayServerCore()).rejects.toThrow("startup failed");

    expect(order).toEqual(["trace", "teardown"]);
  });
});
