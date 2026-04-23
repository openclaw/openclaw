import { describe, expect, it } from "vitest";
import { connectTestGatewayClient } from "./gateway-cli-backend.live-helpers.js";
import { getFreePort, installGatewayTestHooks, startGatewayServer } from "./test-helpers.js";

const GATEWAY_CONNECT_TIMEOUT_MS = 10_000;

describe("gateway cli backend connect", () => {
  installGatewayTestHooks();

  it(
    "connects a same-process test gateway client in minimal mode",
    async () => {
      const token = `test-${Date.now()}`;
      const port = await getFreePort();
      const server = await startGatewayServer(port, {
        bind: "loopback",
        auth: { mode: "token", token },
        controlUiEnabled: false,
      });
      let client: Awaited<ReturnType<typeof connectTestGatewayClient>> | undefined;

      try {
        client = await connectTestGatewayClient({
          url: `ws://127.0.0.1:${port}`,
          token,
          timeoutMs: 5_000,
          maxAttemptTimeoutMs: 5_000,
          requestTimeoutMs: 5_000,
        });
        const health = await client.request("health", undefined, {
          timeoutMs: 5_000,
        });
        expect(health).toMatchObject({
          ok: true,
        });
      } finally {
        await client?.stopAndWait({ timeoutMs: 1_000 }).catch(() => {});
        await server.close({ reason: "gateway connect regression complete" });
      }
    },
    GATEWAY_CONNECT_TIMEOUT_MS,
  );
});
