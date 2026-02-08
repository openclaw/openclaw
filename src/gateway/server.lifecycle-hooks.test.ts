import { beforeEach, describe, expect, test, vi } from "vitest";

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
});
