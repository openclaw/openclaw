import { once } from "node:events";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { withinTest } from "../../test/helpers/promise.js";
import { CliPluginInvocationResources } from "../cli/plugin-invocation-resources.js";
import {
  mocks,
  resetRunnerTestState,
  runNodeHost,
  withReadyNodeHost,
} from "./runner.test-support.js";

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
    mocks.activeRuntime.cancelAll.mockReset().mockResolvedValue(undefined);
    vi.restoreAllMocks();
  });

  it.for(["before entry", "during config read"])(
    "honors CLI cancellation %s",
    async (stage, { signal }) => {
      mocks.useRealGatewayClient = false;
      mocks.startGatewayClientWhenEventLoopReady.mockResolvedValue(mocks.readiness(true));
      const previousExitCode = process.exitCode;
      const on = vi.spyOn(process, "on");
      const resources = new CliPluginInvocationResources();
      const cancel = () =>
        resources.beginClose(new DOMException("CLI stopping (SIGTERM)", "AbortError"));
      if (stage === "during config read") {
        mocks.loadNodeHostConfig.mockImplementationOnce(async () => {
          cancel();
          return null;
        });
      }
      const running = resources.run(() => {
        if (stage === "before entry") {
          cancel();
        }
        return runNodeHost({ gatewayHost: "127.0.0.1", gatewayPort: 18789 });
      });
      try {
        await expect(withinTest(running, signal)).resolves.toBeUndefined();
        expect(mocks.activeRuntime.close).toHaveBeenCalledTimes(stage === "before entry" ? 0 : 1);
      } finally {
        on.mock.calls.find(([event]) => event === "SIGTERM")?.[1]?.("SIGTERM");
        await running;
        await resources.release();
        process.exitCode = previousExitCode;
      }
    },
  );

  it("does not restart runtime cleanup when the stopped transport closes", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
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
      mocks.activeRuntime.cancelAll.mockImplementation(async () => {
        cleanupRestartedAfterClose ||= runtimeClosed;
      });
      await withReadyNodeHost(
        async ({ running, stop }) => {
          await vi.waitFor(() => expect(server.clients.size).toBe(1));
          const socket = await connected;
          const socketClosed = once(socket, "close");
          stop();
          await running;
          await socketClosed;
          await setImmediate();
          expect(mocks.activeRuntime.close).toHaveBeenCalledOnce();
          expect(cleanupRestartedAfterClose).toBe(false);
        },
        { gatewayPort: address.port },
      );
    } finally {
      for (const socket of server.clients) {
        socket.terminate();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
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
