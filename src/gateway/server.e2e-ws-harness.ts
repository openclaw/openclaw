// Gateway websocket E2E harness.
// Starts an unauthenticated loopback gateway and opens connected test clients.
import { WebSocket } from "ws";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { captureEnv } from "../test-utils/env.js";
import { gatewayFixtureLifetime } from "./gateway-fixture-lifetime.test-support.js";
import { connectOk, startTestGatewayServer, trackConnectChallengeNonce } from "./test-helpers.js";
import { reserveGatewayTestListener } from "./test-helpers.listener.js";

type GatewayWsClient = {
  ws: WebSocket;
  hello: unknown;
};

export type GatewayServerHarness = {
  port: number;
  server: Awaited<ReturnType<typeof startTestGatewayServer>>;
  openClient: (opts?: Parameters<typeof connectOk>[1]) => Promise<GatewayWsClient>;
  close: () => Promise<void>;
};

/** Start a loopback Gateway server with a helper for opening authenticated test clients. */
export async function startGatewayServerHarness(): Promise<GatewayServerHarness> {
  gatewayFixtureLifetime.assertAdmission();
  const reservation = await reserveGatewayTestListener();
  try {
    gatewayFixtureLifetime.assertAdmission();
  } catch (error) {
    return await runQaGatewayFixture(async (): Promise<never> => {
      throw error;
    }, reservation.closeUnadopted);
  }
  const { port } = reservation;
  const envSnapshot = captureEnv(["OPENCLAW_GATEWAY_TOKEN"]);
  const clients = new Set<WebSocket>();
  delete process.env.OPENCLAW_GATEWAY_TOKEN;
  const server = await reservation
    .start(() =>
      startTestGatewayServer(
        { port, release: reservation.closeUnadopted },
        { auth: { mode: "none" }, bind: "loopback", controlUiEnabled: false },
      ),
    )
    .catch((error: unknown) =>
      runQaGatewayFixture(
        async (): Promise<never> => {
          throw error;
        },
        reservation.closeUnadopted,
        () => {
          // Failed startup must not restore over another closing owner.
          if (gatewayFixtureLifetime.canAdmit()) {
            envSnapshot.restore();
          }
        },
      ),
    );

  const openClient = async (opts?: Parameters<typeof connectOk>[1]): Promise<GatewayWsClient> => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}`,
      opts?.browserOrigin ? { headers: { origin: opts.browserOrigin } } : {},
    );
    clients.add(ws);
    ws.once("close", () => clients.delete(ws));
    trackConnectChallengeNonce(ws);
    try {
      await new Promise<void>((resolve) => {
        ws.once("open", resolve);
      });
      const hello = await connectOk(ws, opts);
      return { ws, hello };
    } catch (error) {
      ws.terminate();
      throw error;
    }
  };

  const close = async () => {
    const forceCloseTimer = setTimeout(() => {
      // Tests often call ws.close() without waiting for the closing handshake.
      // Force any stragglers down so suite teardown cannot block indefinitely.
      for (const ws of clients) {
        ws.terminate();
      }
    }, 5_000);
    forceCloseTimer.unref?.();
    try {
      await server.close();
    } finally {
      clearTimeout(forceCloseTimer);
      if (gatewayFixtureLifetime.canReleaseState(server)) {
        envSnapshot.restore();
      }
    }
  };

  return { port, server, openClient, close };
}
