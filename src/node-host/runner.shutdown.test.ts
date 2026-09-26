import { once } from "node:events";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { mocks, resetRunnerTestState, runNodeHost } from "./runner.test-support.js";

const { GatewayClient } =
  await vi.importActual<typeof import("../gateway/client.js")>("../gateway/client.js");

describe("node runner shutdown", () => {
  beforeEach(() => {
    resetRunnerTestState();
    mocks.useFakeRuntime = true;
    mocks.useRealGatewayClient = true;
  });
  afterEach(() => {
    mocks.activeRuntime.close.mockReset().mockResolvedValue(undefined);
    mocks.activeRuntime.cancelAll.mockReset();
    vi.restoreAllMocks();
  });

  it("does not restart runtime cleanup when the stopped transport closes", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    const processOn = vi.spyOn(process, "on");
    const previousExitCode = process.exitCode;
    let running: Promise<void> | undefined;
    const stop = () =>
      processOn.mock.calls.find(([event]) => event === "SIGTERM")?.[1]?.("SIGTERM");
    try {
      await once(server, "listening");
      const address = server.address();
      if (typeof address === "string" || address === null) {
        throw new Error("test WebSocket server has no TCP address");
      }
      const connected = new Promise<WebSocket>((resolve) => {
        server.once("connection", resolve);
      });
      mocks.startGatewayClientWhenEventLoopReady.mockImplementationOnce(async (client) => {
        client.start();
        return { ready: true, aborted: false, elapsedMs: 0, maxDriftMs: 0, checks: 1 };
      });
      let runtimeClosed = false;
      let cleanupRestartedAfterClose = false;
      mocks.activeRuntime.close.mockImplementationOnce(async () => {
        runtimeClosed = true;
      });
      mocks.activeRuntime.cancelAll.mockImplementation(() => {
        cleanupRestartedAfterClose ||= runtimeClosed;
      });
      running = runNodeHost({ gatewayHost: "127.0.0.1", gatewayPort: address.port });
      await vi.waitFor(() => expect(server.clients.size).toBe(1));
      const socket = await connected;
      const socketClosed = once(socket, "close");
      stop();
      await running;
      await socketClosed;
      await setImmediate();

      expect(mocks.activeRuntime.close).toHaveBeenCalledOnce();
      expect(cleanupRestartedAfterClose).toBe(false);
    } finally {
      stop();
      await running;
      for (const socket of server.clients) {
        socket.terminate();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      process.exitCode = previousExitCode;
    }
  });

  it.each([false, true])(
    "closes the runtime after client drainage rejects (runtime also rejects: %s)",
    async (runtimeRejects) => {
      const clientFailure = new Error("accepted client cleanup failed");
      const runtimeFailure = new Error("runtime cleanup failed");
      vi.spyOn(GatewayClient.prototype, "stopAndWait").mockRejectedValueOnce(clientFailure);
      if (runtimeRejects) {
        mocks.activeRuntime.close.mockRejectedValueOnce(runtimeFailure);
      }
      const running = runNodeHost({ gatewayHost: "127.0.0.1", gatewayPort: 18789 });

      if (runtimeRejects) {
        await expect(running).rejects.toMatchObject({ errors: [clientFailure, runtimeFailure] });
      } else {
        await expect(running).rejects.toBe(clientFailure);
      }
      expect(mocks.activeRuntime.close).toHaveBeenCalledOnce();
    },
  );
});
