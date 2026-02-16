import { beforeEach, describe, expect, test, vi } from "vitest";
import { PluginHookExecutionError } from "../plugins/hooks.js";

const mocked = vi.hoisted(() => ({
  hookRunner: {
    runGatewayPreStart: vi.fn(async () => {}),
    runGatewayStart: vi.fn(async () => {}),
    runGatewayPreStop: vi.fn(async () => {}),
    runGatewayStop: vi.fn(async () => {}),
  },
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => mocked.hookRunner,
}));

import { getFreePort, installGatewayTestHooks, startGatewayServer } from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

describe("gateway lifecycle hook wiring", () => {
  beforeEach(() => {
    mocked.hookRunner.runGatewayPreStart.mockClear();
    mocked.hookRunner.runGatewayStart.mockClear();
    mocked.hookRunner.runGatewayPreStop.mockClear();
    mocked.hookRunner.runGatewayStop.mockClear();
  });

  test("fires gateway lifecycle hooks on startup and close", async () => {
    const port = await getFreePort();
    const server = await startGatewayServer(port);
    try {
      expect(mocked.hookRunner.runGatewayPreStart).toHaveBeenCalledWith({ port }, { port });
      expect(mocked.hookRunner.runGatewayStart).toHaveBeenCalledWith({ port }, { port });
    } finally {
      await server.close({ reason: "test-shutdown" });
    }

    expect(mocked.hookRunner.runGatewayPreStop).toHaveBeenCalledWith(
      { reason: "test-shutdown" },
      { port },
    );
    expect(mocked.hookRunner.runGatewayStop).toHaveBeenCalledWith(
      { reason: "test-shutdown" },
      { port },
    );
  });

  test("does not fail startup/close when gateway lifecycle hooks throw", async () => {
    mocked.hookRunner.runGatewayPreStart.mockRejectedValueOnce(new Error("pre-start boom"));
    mocked.hookRunner.runGatewayStart.mockRejectedValueOnce(new Error("start boom"));
    mocked.hookRunner.runGatewayPreStop.mockRejectedValueOnce(new Error("pre-stop boom"));
    mocked.hookRunner.runGatewayStop.mockRejectedValueOnce(new Error("stop boom"));

    const port = await getFreePort();
    const server = await startGatewayServer(port);
    await expect(server.close({ reason: "test-shutdown" })).resolves.toBeUndefined();

    expect(mocked.hookRunner.runGatewayPreStart).toHaveBeenCalledWith({ port }, { port });
    expect(mocked.hookRunner.runGatewayStart).toHaveBeenCalledWith({ port }, { port });
    expect(mocked.hookRunner.runGatewayPreStop).toHaveBeenCalledWith(
      { reason: "test-shutdown" },
      { port },
    );
    expect(mocked.hookRunner.runGatewayStop).toHaveBeenCalledWith(
      { reason: "test-shutdown" },
      { port },
    );
  });

  test("fails startup when gateway pre-start hook throws fail-closed error", async () => {
    mocked.hookRunner.runGatewayPreStart.mockRejectedValueOnce(
      new PluginHookExecutionError({
        hookName: "gateway_pre_start",
        pluginId: "policy",
        message: "hard-stop",
      }),
    );
    const port = await getFreePort();
    await expect(startGatewayServer(port)).rejects.toThrow("hard-stop");
  });

  test("does not block close when gateway stop hooks throw fail-closed errors", async () => {
    const port = await getFreePort();
    const server = await startGatewayServer(port);
    mocked.hookRunner.runGatewayPreStop.mockRejectedValueOnce(
      new PluginHookExecutionError({
        hookName: "gateway_pre_stop",
        pluginId: "policy",
        message: "pre-stop denied",
      }),
    );
    mocked.hookRunner.runGatewayStop.mockRejectedValueOnce(
      new PluginHookExecutionError({
        hookName: "gateway_stop",
        pluginId: "policy",
        message: "stop denied",
      }),
    );

    await expect(server.close({ reason: "test-shutdown" })).resolves.toBeUndefined();
  });
});
