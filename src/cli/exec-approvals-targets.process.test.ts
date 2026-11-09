// Real CLI process coverage for mutually exclusive approvals targets.
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { expect, it, onTestFinished } from "vitest";
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

it.each([
  {
    name: "conflicting get",
    args: ["get", "--gateway", "--node", "proof-node"],
    conflict: true,
    methods: [],
  },
  {
    name: "conflicting mutation",
    args: ["allowlist", "add", "/usr/bin/uname", "--gateway", "--node", "proof-node"],
    conflict: true,
    methods: [],
  },
  {
    name: "gateway-only get",
    args: ["get", "--gateway"],
    conflict: false,
    methods: ["exec.approvals.get", "config.get"],
  },
  {
    name: "node-only get",
    args: ["get", "--node", "proof-node"],
    conflict: false,
    methods: ["node.list", "exec.approvals.node.get", "config.get"],
  },
])("R0891 CLI process: $name", async ({ args, conflict, methods }) => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  onTestFinished(() => closeMinimalGatewayServer(server));
  const calls: string[] = [];
  const unexpected: string[] = [];
  const nodeTargets: unknown[] = [];
  let connections = 0;
  let policy: unknown = { version: 1, agents: {} };
  const before = JSON.stringify(policy);
  server.on("connection", (socket) => {
    connections += 1;
    sendMinimalGatewayConnectChallenge(socket);
    socket.on("message", (data) => {
      try {
        const frame = parseMinimalGatewayRequestFrame(data);
        if (frame.type !== "req" || !frame.id || !frame.method) {
          unexpected.push("non-request frame");
          return;
        }
        if (frame.method === "connect") {
          if (frame.params?.auth?.token !== "proof-token") {
            unexpected.push("wrong token");
          }
          sendMinimalGatewayResponse(
            socket,
            frame.id,
            buildMinimalGatewayHelloOkPayload({
              auth: { role: "operator", scopes: ["operator.admin"] },
            }),
          );
          return;
        }
        calls.push(frame.method);
        let payload: unknown;
        if (frame.method === "node.list") {
          payload = {
            nodes: [{ nodeId: "proof-node", displayName: "proof-node", connected: true }],
          };
        } else if (frame.method === "config.get") {
          payload = { config: {} };
        } else if (
          ["exec.approvals.get", "exec.approvals.node.get", "exec.approvals.set"].includes(
            frame.method,
          )
        ) {
          if (frame.method === "exec.approvals.node.get") {
            nodeTargets.push(frame.params?.nodeId);
          }
          if (frame.method === "exec.approvals.set") {
            policy = frame.params?.file;
          }
          payload = {
            path: "/synthetic/exec-approvals.json",
            exists: true,
            hash: "proof-hash",
            file: policy,
          };
        } else {
          unexpected.push(frame.method);
          socket.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: false,
              error: { code: "INVALID_REQUEST", message: "unexpected proof RPC" },
            }),
          );
          return;
        }
        sendMinimalGatewayResponse(socket, frame.id, payload);
      } catch (error) {
        unexpected.push(String(error));
        socket.terminate();
      }
    });
  });
  await once(server, "listening");
  const url = "ws://127.0.0.1:" + (server.address() as AddressInfo).port;
  const root = tempDirs.make("openclaw-r0891-process-");
  const fixture = await prepareGatewayCliFixture(root, {
    mode: "remote",
    remote: { url, token: "proof-token" },
  });
  const result = await runIsolatedGatewayCli({
    root,
    ...fixture,
    args: ["approvals", ...args, "--url", url, "--token", "proof-token", "--json"],
  });
  expect(result.signal).toBeNull();
  expect(unexpected).toEqual([]);
  if (conflict) {
    expect(result.code).toBe(1);
    expect(result.stderr + result.stdout).toContain("Pass only one of --gateway or --node.");
    expect(connections).toBe(0);
  } else {
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).hash).toBe("proof-hash");
    expect(connections).toBeGreaterThan(0);
  }
  expect(calls).toEqual(methods);
  expect(nodeTargets).toEqual(args.includes("--node") && !conflict ? ["proof-node"] : []);
  expect(JSON.stringify(policy)).toBe(before);
});
