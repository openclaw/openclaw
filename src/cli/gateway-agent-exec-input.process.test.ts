// Real CLI children must not turn agent-exec reports into operator Gateway input.
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { WebSocketServer } from "ws";
import {
  buildMinimalGatewayHelloOkPayload as helloPayload,
  closeMinimalGatewayServer,
  parseMinimalGatewayRequestFrame,
  sendMinimalGatewayConnectChallenge,
  sendMinimalGatewayResponse as sendResponse,
} from "../gateway/minimal-gateway.test-helpers.js";
import {
  prepareGatewayCliFixture,
  runIsolatedGatewayCli,
  tempDirs,
} from "./gateway-backed-exit.process.test-support.js";

const message = "Worker result";
const params = JSON.stringify({ key: "agent:main:target", message });
const commands = {
  "sessions.send": ["gateway", "call", "sessions.send", "--params", params, "--json"],
  agent: ["agent", "--agent", "main", "--model", "test/model", "--message", message, "--json"],
};

it.each(
  Object.entries(commands).flatMap(([method, args]) => [
    { method, args, shell: "exec" },
    { method, args, shell: undefined },
  ]),
)("operator CLI $method with exec marker $shell", async ({ args, method, shell }) => {
  const root = tempDirs.make("openclaw-cli-input-origin-");
  const token = "cli-input-fixture-token";
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const calls: string[] = [];
  let connections = 0;
  server.on("connection", (socket) => {
    connections += 1;
    sendMinimalGatewayConnectChallenge(socket);
    socket.on("message", (data) => {
      const frame = parseMinimalGatewayRequestFrame(data);
      if (!frame.id || frame.type !== "req") {
        return;
      }
      if (frame.method === "connect") {
        expect(frame.params?.auth?.token).toBe(token);
        sendResponse(
          socket,
          frame.id,
          helloPayload({
            methods: [method],
            auth: { role: "operator", scopes: ["operator.admin"] },
          }),
        );
        return;
      }
      calls.push(frame.method ?? "");
      sendResponse(
        socket,
        frame.id,
        method === "agent"
          ? { runId: "fixture-run", status: "ok", result: { payloads: [{ text: "done" }] } }
          : { runId: "fixture-run", status: "started" },
      );
    });
  });
  try {
    await once(server, "listening");
    const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const fixture = await prepareGatewayCliFixture(root, {
      mode: "remote",
      remote: { url, token },
    });
    const result = await runIsolatedGatewayCli({
      args,
      root,
      ...fixture,
      env: { OPENCLAW_SHELL: shell, OPENCLAW_SUBAGENT_EXEC: undefined },
    });
    const blocked = shell === "exec";
    const expectedCalls = blocked ? [] : [method];
    expect(result, result.stderr).toMatchObject({ code: blocked ? 1 : 0, signal: null });
    expect({ connections, calls }).toEqual({
      connections: expectedCalls.length,
      calls: expectedCalls,
    });
    if (blocked) {
      expect(result.stdout + result.stderr).toContain("inter-session attribution");
      expect(result.stdout + result.stderr).toContain("normal subagent completion");
    } else {
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({ runId: "fixture-run" });
    }
  } finally {
    await closeMinimalGatewayServer(server);
  }
});
