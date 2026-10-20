// A real paired node accepts but never answers: the Gateway must return dispatch provenance.
import assert from "node:assert/strict";
import { expect, it } from "vitest";
import type { WebSocket } from "ws";
import { createNodePluginTools } from "../agents/node-plugin-tools.js";
import { approveDevicePairing } from "../infra/device-pairing-approval.js";
import { approveNodePairing, requestNodePairing } from "../infra/device-pairing-node.js";
import { listDevicePairing } from "../infra/device-pairing.js";
import { getActiveRuntimePluginRegistry } from "../plugins/active-runtime-registry.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { replaceConnectedNodePluginTools } from "./node-plugin-tool-snapshot.js";
import { connectGatewayClient } from "./test-helpers.e2e.js";
import { installGatewayTestHooks, rpcReq } from "./test-helpers.js";
import { installConnectedControlUiServerSuite } from "./test-with-server.js";

installGatewayTestHooks({ scope: "suite" });

const NODE_DISPLAY_NAME = "Slow Studio Node";
const NODE_COMMAND = "remote.echo";
// One Gateway deadline (30s) plus the caller grace, plus room for pairing setup.
const PROOF_TIMEOUT_MS = 240_000;

let ws: WebSocket;
let port = 0;

installConnectedControlUiServerSuite((started) => {
  ws = started.ws;
  port = started.port;
});

function installNodeCommandPolicy(): void {
  const registry = getActiveRuntimePluginRegistry();
  assert(registry, "active plugin registry is required for node invoke policy tests");
  if (registry.nodeInvokePolicies.some((entry) => entry.policy.commands.includes(NODE_COMMAND))) {
    return;
  }
  registry.nodeInvokePolicies.push({
    pluginId: "remote-demo",
    pluginName: "Remote Demo",
    source: "test",
    rootDir: "extensions/remote-demo",
    pluginConfig: {},
    policy: {
      commands: [NODE_COMMAND],
      defaultPlatforms: ["ios", "android", "macos", "windows", "unknown"],
      foregroundRestrictedOnIos: false,
      handle: (ctx) => ctx.invokeNode(),
    },
  });
}

it(
  "returns the Gateway timeout with dispatch provenance when the node never answers",
  async () => {
    installNodeCommandPolicy();
    const dispatchedToNode: { timeoutMs?: number }[] = [];

    const connectNode = () =>
      connectGatewayClient({
        url: `ws://127.0.0.1:${port}`,
        token: process.env.OPENCLAW_GATEWAY_TOKEN,
        role: "node",
        clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
        clientVersion: "1.0.0",
        clientDisplayName: NODE_DISPLAY_NAME,
        platform: "macos",
        mode: GATEWAY_CLIENT_MODES.NODE,
        scopes: [],
        commands: [NODE_COMMAND],
        onEvent: (event) => {
          if (event.event === "node.invoke.request") {
            dispatchedToNode.push(event.payload as { timeoutMs?: number });
          }
        },
        timeoutMessage: "timeout waiting for node to connect",
      });

    const connectWithDevicePairing = async () => {
      try {
        return await connectNode();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("pairing required")) {
          throw error;
        }
        const pairings = await listDevicePairing();
        for (const pending of pairings.pending) {
          await approveDevicePairing(pending.requestId, {
            callerScopes: pending.scopes ?? ["operator.admin"],
          });
        }
        return await connectNode();
      }
    };

    const findNodeId = async () => {
      const listed = await rpcReq<{
        nodes?: { nodeId: string; displayName?: string; connected?: boolean }[];
      }>(ws, "node.list", {});
      return (listed.payload?.nodes ?? []).find(
        (entry) => entry.connected && entry.displayName === NODE_DISPLAY_NAME,
      )?.nodeId;
    };

    const provisional = await connectWithDevicePairing();
    const provisionalNodeId = await findNodeId();
    assert(provisionalNodeId, "expected a connected node id before pairing");
    await provisional.stopAndWait();
    const pairing = await requestNodePairing({
      nodeId: provisionalNodeId,
      displayName: NODE_DISPLAY_NAME,
      platform: "macos",
      commands: [NODE_COMMAND],
    });
    await approveNodePairing(pairing.request.requestId, {
      callerScopes: ["operator.admin", "operator.write"],
    });
    const node = await connectNode();
    // The shared Gateway fixture snapshots no such key, so leaving it set would
    // point later tests in this worker at this stopped ephemeral server.
    const gatewayUrlEnv = captureEnv(["OPENCLAW_GATEWAY_URL"]);

    try {
      const nodeId = (await findNodeId()) ?? provisionalNodeId;
      replaceConnectedNodePluginTools({
        nodeId,
        displayName: NODE_DISPLAY_NAME,
        tools: [
          {
            descriptor: {
              pluginId: "remote-demo",
              name: "remote_echo",
              description: "Echo through a remote node",
              parameters: { type: "object", properties: { text: { type: "string" } } },
              command: NODE_COMMAND,
            },
            registered: false,
          },
        ],
      });
      setTestEnvValue("OPENCLAW_GATEWAY_URL", `ws://127.0.0.1:${port}`);

      const tool = createNodePluginTools({})[0];
      assert(tool, "expected a materialized node plugin tool");
      // A client timeout lacks the Gateway's message and dispatch provenance.
      await expect(tool.execute("deadline-proof-call", { text: "ping" })).rejects.toMatchObject({
        message: expect.stringContaining("node invoke timed out"),
        details: { nodeCommandDispatched: true },
      });
      // The command really reached the node, so the answer must not claim retry safety.
      expect(dispatchedToNode).toHaveLength(1);
      expect(dispatchedToNode[0]?.timeoutMs).toBeGreaterThan(0);
    } finally {
      gatewayUrlEnv.restore();
      await node.stopAndWait();
    }
  },
  PROOF_TIMEOUT_MS,
);
