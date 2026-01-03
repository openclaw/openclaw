import { createServer } from "node:net";
import { describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import { GatewayLockError } from "../infra/gateway-lock.js";
import {
  connectOk,
  getFreePort,
  installGatewayTestHooks,
  occupyPort,
  onceMessage,
  startGatewayServer,
  startServerWithClient,
  testState,
  testTailnetIPv4,
} from "./test-helpers.js";

installGatewayTestHooks();

describe("gateway server misc", () => {
  test("hello-ok advertises the gateway port for canvas host", async () => {
    const prevToken = process.env.CLAWDIS_GATEWAY_TOKEN;
    process.env.CLAWDIS_GATEWAY_TOKEN = "secret";
    testTailnetIPv4.value = "100.64.0.1";
    testState.gatewayBind = "lan";
    const canvasPort = await getFreePort();
    testState.canvasHostPort = canvasPort;

    const port = await getFreePort();
    const server = await startGatewayServer(port, {
      bind: "lan",
      allowCanvasHostInTests: true,
    });
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { Host: `100.64.0.1:${port}` },
    });
    await new Promise<void>((resolve) => ws.once("open", resolve));

    const hello = await connectOk(ws, { token: "secret" });
    expect(hello.canvasHostUrl).toBe(`http://100.64.0.1:${canvasPort}`);

    ws.close();
    await server.close();
    if (prevToken === undefined) {
      delete process.env.CLAWDIS_GATEWAY_TOKEN;
    } else {
      process.env.CLAWDIS_GATEWAY_TOKEN = prevToken;
    }
  });

  test("send dedupes by idempotencyKey", { timeout: 8000 }, async () => {
    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const idem = "same-key";
    const res1P = onceMessage(ws, (o) => o.type === "res" && o.id === "a1");
    const res2P = onceMessage(ws, (o) => o.type === "res" && o.id === "a2");
    const sendReq = (id: string) =>
      ws.send(
        JSON.stringify({
          type: "req",
          id,
          method: "send",
          params: { to: "+15550000000", message: "hi", idempotencyKey: idem },
        }),
      );
    sendReq("a1");
    sendReq("a2");

    const res1 = await res1P;
    const res2 = await res2P;
    expect(res1.ok).toBe(true);
    expect(res2.ok).toBe(true);
    expect(res1.payload).toEqual(res2.payload);
    ws.close();
    await server.close();
  });

  test("refuses to start when port already bound", async () => {
    const { server: blocker, port } = await occupyPort();
    await expect(startGatewayServer(port)).rejects.toBeInstanceOf(
      GatewayLockError,
    );
    await expect(startGatewayServer(port)).rejects.toThrow(
      /already listening/i,
    );
    blocker.close();
  });

  test("releases port after close", async () => {
    const port = await getFreePort();
    const server = await startGatewayServer(port);
    await server.close();

    const probe = createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(port, "127.0.0.1", () => resolve());
    });
    await new Promise<void>((resolve, reject) =>
      probe.close((err) => (err ? reject(err) : resolve())),
    );
  });
});
