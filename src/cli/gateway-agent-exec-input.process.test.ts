// Real CLI children must not turn agent-exec reports into operator Gateway input.
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import {
  buildMinimalGatewayHelloOkPayload,
  closeMinimalGatewayServer,
  parseMinimalGatewayRequestFrame,
  sendMinimalGatewayConnectChallenge,
  sendMinimalGatewayResponse,
} from "../gateway/minimal-gateway.test-helpers.js";
import {
  prepareGatewayCliFixture,
  runIsolatedGatewayCli,
  tempDirs,
} from "./gateway-backed-exit.process.test-support.js";

const cases = [
  {
    name: "raw session send",
    args: [
      "gateway",
      "call",
      "sessions.send",
      "--params",
      JSON.stringify({ key: "agent:main:target", message: "Worker result" }),
      "--json",
    ],
    method: "sessions.send",
  },
  {
    name: "raw chat send",
    args: [
      "gateway",
      "call",
      "chat.send",
      "--params",
      JSON.stringify({ sessionKey: "agent:main:target", message: "Worker result" }),
      "--json",
    ],
    method: "chat.send",
  },
  {
    name: "agent command",
    args: ["agent", "--agent", "main", "--message", "Worker result", "--json"],
    method: "agent",
  },
  {
    name: "agent command with model override",
    args: [
      "agent",
      "--agent",
      "main",
      "--model",
      "test/model",
      "--message",
      "Worker result",
      "--json",
    ],
    method: "agent",
  },
];

describe("operator CLI versus agent exec message admission", () => {
  it.each(
    cases.flatMap((testCase) => [
      { ...testCase, shell: "exec" },
      { ...testCase, shell: undefined },
    ]),
  )("$name with exec marker $shell", async ({ args, method, shell }) => {
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
          sendMinimalGatewayResponse(
            socket,
            frame.id,
            buildMinimalGatewayHelloOkPayload({
              methods: [method],
              auth: { role: "operator", scopes: ["operator.admin"] },
            }),
          );
          return;
        }
        calls.push(frame.method ?? "");
        sendMinimalGatewayResponse(
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
      if (shell === "exec") {
        expect(result, result.stderr).toMatchObject({ code: 1, signal: null });
        expect(result.stdout + result.stderr).toContain("inter-session attribution");
        expect(result.stdout + result.stderr).toContain("normal subagent completion");
        expect(connections).toBe(0);
        expect(calls).toEqual([]);
      } else {
        expect(result, result.stderr).toMatchObject({ code: 0, signal: null, stderr: "" });
        expect(JSON.parse(result.stdout)).toMatchObject({ runId: "fixture-run" });
        expect(connections).toBe(1);
        expect(calls).toEqual([method]);
      }
    } finally {
      await closeMinimalGatewayServer(server);
    }
  });
});
