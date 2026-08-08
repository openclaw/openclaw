import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => {
  const log = {
    child: vi.fn(),
    warn: vi.fn(),
  };
  log.child.mockReturnValue(log);
  return {
    startupError: new Error("gateway startup failed"),
    cleanupError: new Error("gateway cleanup failed"),
    log,
    beginClosePrelude: vi.fn(),
    clearFallbackGatewayContext: vi.fn(),
    closeHandler: vi.fn(),
    closeOnStartupFailure: vi.fn(),
    createCloseHandler: vi.fn(),
    finishGatewayStartup: vi.fn(),
    runClosePreludeAfterFence: vi.fn(),
    runCleanupSequence: vi.fn(),
    runGlobalGatewayStopSafely: vi.fn(),
    startGatewayCoreRuntime: vi.fn(),
    stopRegisteredSidecars: vi.fn(),
    terminalSessionsDisposeAll: vi.fn(),
  };
});

vi.mock("../infra/path-env.js", () => ({ ensureOpenClawCliOnPath: vi.fn() }));
vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: vi.fn(() => hoisted.log),
  runtimeForLogger: vi.fn(() => ({})),
}));
vi.mock("../plugins/hook-runner-global.js", () => ({
  runGlobalGatewayStopSafely: hoisted.runGlobalGatewayStopSafely,
}));
vi.mock("./server-startup-bootstrap.js", () => ({
  prepareGatewayServerBootstrap: vi.fn(async () => ({ diagnosticsEnabled: false })),
}));
vi.mock("./server-runtime-state-prepare.js", () => ({
  prepareGatewayRuntimeState: vi.fn(async () => ({})),
}));
vi.mock("./server-lifecycle.js", () => ({
  prepareGatewayLifecycle: vi.fn(async () => ({
    beginClosePrelude: hoisted.beginClosePrelude,
    clearFallbackGatewayContextForServer: {
      get: () => hoisted.clearFallbackGatewayContext,
      set: vi.fn(),
    },
    closeOnStartupFailure: hoisted.closeOnStartupFailure,
    createCloseHandler: hoisted.createCloseHandler,
    runClosePreludeAfterFence: hoisted.runClosePreludeAfterFence,
    stopRegisteredSidecars: hoisted.stopRegisteredSidecars,
    terminalSessions: { disposeAll: hoisted.terminalSessionsDisposeAll },
  })),
  runGatewayCleanupSequence: hoisted.runCleanupSequence,
}));
vi.mock("./server-core-runtime.js", () => ({
  startGatewayCoreRuntime: hoisted.startGatewayCoreRuntime,
}));
vi.mock("./server-startup-finish.js", () => ({
  finishGatewayStartup: hoisted.finishGatewayStartup,
}));

const { startGatewayServer } = await import("./server-start.js");

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.log.child.mockReturnValue(hoisted.log);
  hoisted.closeOnStartupFailure.mockRejectedValue(hoisted.cleanupError);
  hoisted.createCloseHandler.mockReturnValue(hoisted.closeHandler);
  hoisted.finishGatewayStartup.mockResolvedValue(undefined);
  hoisted.runCleanupSequence.mockImplementation(async (steps) => {
    let firstError: { value: unknown } | undefined;
    for (const [, run] of steps) {
      try {
        await run();
      } catch (error) {
        firstError ??= { value: error };
      }
    }
    if (firstError) {
      throw firstError.value;
    }
  });
  hoisted.startGatewayCoreRuntime.mockRejectedValue(hoisted.startupError);
});

describe("gateway startup failure cleanup", () => {
  it("preserves the initiating startup error when cleanup rejects", async () => {
    await expect(startGatewayServer()).rejects.toBe(hoisted.startupError);

    expect(hoisted.closeOnStartupFailure).toHaveBeenCalledOnce();
    expect(hoisted.log.warn).toHaveBeenCalledWith(
      `gateway startup cleanup failed: ${String(hoisted.cleanupError)}`,
    );
  });

  it("runs the full explicit cleanup sequence after a sidecar failure", async () => {
    const sidecarFailure = new Error("sidecar stop failed");
    const order: string[] = [];
    hoisted.startGatewayCoreRuntime.mockResolvedValue({});
    hoisted.beginClosePrelude.mockImplementation(() => order.push("prelude-fence"));
    hoisted.terminalSessionsDisposeAll.mockImplementation(() => order.push("terminals"));
    hoisted.stopRegisteredSidecars.mockImplementation(async () => {
      order.push("sidecars");
      throw sidecarFailure;
    });
    hoisted.runGlobalGatewayStopSafely.mockImplementation(async () => {
      order.push("gateway-stop-hook");
    });
    hoisted.runClosePreludeAfterFence.mockImplementation(async () => {
      order.push("close-prelude");
    });
    hoisted.closeHandler.mockImplementation(async () => {
      order.push("close");
    });
    hoisted.clearFallbackGatewayContext.mockImplementation(() => {
      order.push("fallback");
    });

    const server = await startGatewayServer();
    await expect(server.close()).rejects.toBe(sidecarFailure);

    expect(order).toEqual([
      "prelude-fence",
      "terminals",
      "sidecars",
      "gateway-stop-hook",
      "close-prelude",
      "close",
      "fallback",
    ]);
  });

  it("runs post-fence prelude cleanup after the fence join rejects", async () => {
    const fenceFailure = new Error("prelude fence failed");
    const order: string[] = [];
    hoisted.startGatewayCoreRuntime.mockResolvedValue({});
    hoisted.beginClosePrelude.mockImplementation(async () => {
      order.push("prelude-fence");
      throw fenceFailure;
    });
    hoisted.runClosePreludeAfterFence.mockImplementation(() => {
      order.push("close-prelude");
    });
    hoisted.closeHandler.mockImplementation(() => {
      order.push("close");
    });
    hoisted.clearFallbackGatewayContext.mockImplementation(() => {
      order.push("fallback");
    });

    const server = await startGatewayServer();
    await expect(server.close()).rejects.toBe(fenceFailure);

    expect(order).toEqual(["prelude-fence", "close-prelude", "close", "fallback"]);
  });
});
