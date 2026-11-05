import { beforeAll, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  acquireGatewayTestWebSocket,
  closeGatewayTestWebSocket,
} from "../../test/helpers/gateway-websocket.js";
import { tryListenOnPort } from "../infra/ports-probe.js";
import { captureEnv } from "../test-utils/env.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import { installGatewayTestHooks, startTestGatewayServer } from "./test-helpers.js";
import { createGatewayRuntimeStateForTest } from "./test-helpers.server-runtime-state.js";

type GatewayServerForTest = Awaited<ReturnType<typeof startTestGatewayServer>>;

installGatewayTestHooks({ scope: "suite" });

let loopbackAliasBindable = false;

beforeAll(async () => {
  loopbackAliasBindable = await tryListenOnPort({
    host: "127.0.0.2",
    port: 0,
    exclusive: true,
  }).then(
    () => true,
    () => false,
  );
});

it("attaches websocket upgrade handlers before exposing the listen step", async () => {
  const runtimeState = await createGatewayRuntimeStateForTest();
  try {
    expect(runtimeState.httpBindHosts).toEqual([]);
    expect(runtimeState.httpServer.listenerCount("upgrade")).toBeGreaterThan(0);
  } finally {
    runtimeState.wss.close();
  }
});

it("serves a specific IPv4 bind and its required loopback alias", async ({ skip }) => {
  if (!loopbackAliasBindable) {
    skip("127.0.0.2 is not bindable on this host");
    return;
  }
  const env = captureEnv(["OPENCLAW_TEST_MINIMAL_GATEWAY"]);
  process.env.OPENCLAW_TEST_MINIMAL_GATEWAY = "0";
  let server: GatewayServerForTest | undefined;
  const clients: WebSocket[] = [];
  try {
    const portClaim = await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] });
    server = await startTestGatewayServer(portClaim, {
      host: "127.0.0.2",
      auth: { mode: "none" },
    });

    clients.push(
      await acquireGatewayTestWebSocket(new WebSocket(`ws://127.0.0.1:${portClaim.port}`), 5_000),
      await acquireGatewayTestWebSocket(new WebSocket(`ws://127.0.0.2:${portClaim.port}`), 5_000),
    );
  } finally {
    await Promise.all(clients.map(closeGatewayTestWebSocket));
    await server?.close();
    env.restore();
  }
});

it("releases the loopback alias when the selected bind fails", async () => {
  const portClaim = await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] });

  await expect(
    startTestGatewayServer(portClaim, {
      bind: "lan",
      host: "192.0.2.1",
      auth: { mode: "token", token: "test-token" },
    }),
  ).rejects.toThrow("failed to bind gateway socket");

  await expect(
    tryListenOnPort({ host: "127.0.0.1", port: portClaim.port, exclusive: true }),
  ).resolves.toBeUndefined();
});
