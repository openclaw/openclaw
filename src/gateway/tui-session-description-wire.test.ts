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
    let holdDescription = false;
    const heldRequest = createDeferred();
    let client: GatewayChatClient | undefined;
    server.on("connection", (socket) => {
      sendMinimalGatewayConnectChallenge(socket);
      socket.on("message", (data) => {
        const frame = parseMinimalGatewayRequestFrame(data);
        if (!frame.id || !frame.method) {
          return;
        }
        if (frame.method === "connect") {
          const hello = buildMinimalGatewayHelloOkPayload({
            methods: ["sessions.describe", "sessions.list"],
          });
          sendMinimalGatewayResponse(socket, frame.id, {
            ...hello,
            server: { ...hello.server, version: "2026.9.4" },
          });
          return;
        }
        requests.push({ method: frame.method, params: frame.params });
        if (frame.method === "sessions.describe" && validateSessionsDescribeParams(frame.params)) {
          if (holdDescription) {
            heldRequest.resolve();
            return;
          }
          sendMinimalGatewayResponse(socket, frame.id, {
            session: {
              key: responseKey,
              sessionId: "selected-transcript",
              model: "selected-model",
            },
          });
        } else if (frame.method === "sessions.list" && validateSessionsListParams(frame.params)) {
          sendMinimalGatewayResponse(socket, frame.id, {
            ts: 0,
            path: "synthetic-store",
            count: 0,
            sessions: [],
            defaults: { model: "default-model" },
          });
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
      for (const testCase of [
        { sessionKey: "agent:ops:notes", key: "agent:ops:notes", owner: "ops" },
        { sessionKey: "agent:ops:main", key: "global", owner: "ops" },
        { sessionKey: "main", agentId: "ops", key: "global", owner: "ops" },
        { sessionKey: "global", agentId: "ops", key: "global", owner: "ops" },
        { sessionKey: "unknown", key: "unknown", owner: undefined },
      ]) {
        requests.length = 0;
        responseKey = testCase.key;
        await expect(
          client.describeSession({
            sessionKey: testCase.sessionKey,
            ...(testCase.agentId ? { agentId: testCase.agentId } : {}),
          }),
        ).resolves.toEqual({
          session: { key: testCase.key, sessionId: "selected-transcript", model: "selected-model" },
          defaults: { model: "default-model" },
        });
        expect(requests).toEqual([
          {
            method: "sessions.describe",
            params: {
              key: testCase.sessionKey,
              ...(testCase.agentId ? { agentId: testCase.agentId } : {}),
            },
          },
          {
            method: "sessions.list",
            params: {
              ...(testCase.owner ? { agentId: testCase.owner } : {}),
              limit: 1,
            },
          },
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
