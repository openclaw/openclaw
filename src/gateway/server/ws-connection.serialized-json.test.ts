import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { expect, it, vi } from "vitest";
import * as Ws from "../../../packages/gateway-client/src/websocket.test-support.js";
import { SerializedJsonArray } from "../serialized-json.js";
import { attachGatewayWsConnectionHandler } from "./ws-connection.js";
import { attachGatewayWsForTest, type GatewayWsTestSocket } from "./ws-connection.test-helpers.js";
import type { GatewayWsMessageHandlerParams } from "./ws-connection/message-handler-types.js";

const attachHandler = vi.hoisted(() => vi.fn<(params: GatewayWsMessageHandlerParams) => void>());
vi.mock("./ws-connection/message-handler.js", () => ({
  attachGatewayWsMessageHandler: attachHandler,
}));

it("delivers transferred history bytes as a JSON text frame", async () => {
  const server = new Ws.WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const accepted = once(server, "connection");
  const peer = new Ws.WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`);
  await once(peer, "open");
  const [socket] = (await accepted) as [Ws.WebSocket];
  try {
    const challenge = once(peer, "message");
    attachGatewayWsForTest({
      attach: attachGatewayWsConnectionHandler,
      socket: socket as unknown as GatewayWsTestSocket,
    });
    await vi.dynamicImportSettled();
    await challenge;
    const handler = attachHandler.mock.calls[0]![0];
    const messages = [{ role: "assistant", content: "é🦞\nready" }];
    const received = once(peer, "message");
    expect(
      handler.send({
        type: "res",
        id: "history",
        ok: true,
        payload: { messages: new SerializedJsonArray(Buffer.from(JSON.stringify(messages))) },
      }),
    ).toEqual({ kind: "sent" });
    const [data, isBinary] = (await received) as [Buffer, boolean];
    expect(isBinary).toBe(false);
    expect(JSON.parse(data.toString())).toEqual({
      type: "res",
      id: "history",
      ok: true,
      payload: { messages },
    });
  } finally {
    peer.terminate();
    socket.terminate();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
