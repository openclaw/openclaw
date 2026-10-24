import { once } from "node:events";
import { expect, it } from "vitest";
import { WebSocketServer } from "ws";
import {
  validateSessionsDescribeParams,
  validateSessionsListParams,
} from "../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { GatewayChatClient } from "../tui/gateway-chat.js";
import {
  buildMinimalGatewayHelloOkPayload,
  closeMinimalGatewayServer,
  parseMinimalGatewayRequestFrame,
  sendMinimalGatewayConnectChallenge,
  sendMinimalGatewayResponse,
} from "./minimal-gateway.test-helpers.js";

it("describes sessions over the published wire without changing legacy key semantics", async () => {
  await withOpenClawTestState({ label: "tui-description-wire" }, async (state) => {
    const token = "tui-description-fixture-token";
    await state.writeConfig({ gateway: { mode: "local", auth: { mode: "token", token } } });
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    const requests: Array<{ method: string; params: unknown }> = [];
    let responseKey = "";
    const session = (key: string) => ({ key, sessionId: "transcript", model: "selected-model" });
    const defaults = { model: "default-model" };
    let holdDescription = false;
    const heldRequest = createDeferred();
    let client: GatewayChatClient | undefined;
    server.on("connection", (socket) => {
      sendMinimalGatewayConnectChallenge(socket);
      socket.on("message", (data) => {
        const frame = parseMinimalGatewayRequestFrame(data);
        const { id } = frame;
        if (!id || !frame.method) {
          return;
        }
        const reply = (payload: unknown) => sendMinimalGatewayResponse(socket, id, payload);
        if (frame.method === "connect") {
          const hello = buildMinimalGatewayHelloOkPayload({
            methods: ["sessions.describe", "sessions.list"],
          });
          hello.server.version = "2026.9.4";
          reply(hello);
          return;
        }
        requests.push({ method: frame.method, params: frame.params });
        if (frame.method === "sessions.describe" && validateSessionsDescribeParams(frame.params)) {
          if (holdDescription) {
            heldRequest.resolve();
            return;
          }
          reply({ session: session(responseKey) });
        } else if (frame.method === "sessions.list" && validateSessionsListParams(frame.params)) {
          reply({ defaults });
        } else {
          socket.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: false,
              error: { code: "INVALID_REQUEST", message: "Unexpected metadata request shape" },
            }),
          );
        }
      });
    });
    try {
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected a loopback TCP listener");
      }
      client = new GatewayChatClient({ url: `ws://127.0.0.1:${address.port}`, token });
      const connected = createDeferred();
      client.onConnected = () => connected.resolve();
      client.onConnectError = (error) => connected.reject(error);
      client.start();
      await connected.promise;
      for (const { sessionKey, key, owner, agentId } of [
        { sessionKey: "agent:ops:notes", key: "agent:ops:notes", owner: "ops" },
        { sessionKey: "agent:ops:main", key: "global", owner: "ops" },
        { sessionKey: "main", agentId: "ops", key: "global", owner: "ops" },
        { sessionKey: "global", agentId: "ops", key: "global", owner: "ops" },
        { sessionKey: "unknown", key: "unknown", owner: undefined },
      ]) {
        requests.length = 0;
        responseKey = key;
        const agent = agentId ? { agentId } : {};
        await expect(client.describeSession({ sessionKey, ...agent })).resolves.toEqual({
          session: session(key),
          defaults,
        });
        expect(requests).toEqual([
          { method: "sessions.describe", params: { key: sessionKey, ...agent } },
          { method: "sessions.list", params: { ...(owner ? { agentId: owner } : {}), limit: 1 } },
        ]);
      }
      holdDescription = true;
      const pending = client.describeSession({ sessionKey: "agent:ops:notes" });
      const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
      await heldRequest.promise;
      await client.stop();
      await rejected;
    } finally {
      await client?.stop();
      await closeMinimalGatewayServer(server);
    }
  });
});
