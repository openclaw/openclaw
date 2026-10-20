// A real paired node accepts but never answers: the Gateway must return dispatch provenance.
import assert from "node:assert/strict";
import { expect, it } from "vitest";
import { createNodePluginTools } from "../agents/node-plugin-tools.js";
import { approveNodePairing, requestNodePairing } from "../infra/device-pairing-node.js";
import { getActiveRuntimePluginRegistry } from "../plugins/active-runtime-registry.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { pairDeviceIdentity } from "./device-authz.test-helpers.js";
import { replaceConnectedNodePluginTools } from "./node-plugin-tool-snapshot.js";
import { connectGatewayClient } from "./test-helpers.e2e.js";
import { installGatewayTestHooks } from "./test-helpers.js";
import { installConnectedControlUiServerSuite } from "./test-with-server.js";

installGatewayTestHooks({ scope: "suite" });

const NODE_DISPLAY_NAME = "Slow Studio Node";
const NODE_COMMAND = "remote.echo";
// One Gateway deadline (30s) plus the caller grace, plus room for pairing setup.
const PROOF_TIMEOUT_MS = 240_000;

let port = 0;

installConnectedControlUiServerSuite((started) => {
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
    const { identity } = await pairDeviceIdentity({
      name: "deadline-node",
      role: "node",
      scopes: [],
      clientId: GATEWAY_CLIENT_NAMES.NODE_HOST,
      clientMode: GATEWAY_CLIENT_MODES.NODE,
      platform: "macos",
    });
    const nodeId = identity.deviceId;
    const pairing = await requestNodePairing({
      nodeId,
      displayName: NODE_DISPLAY_NAME,
      platform: "macos",
      commands: [NODE_COMMAND],
    });
    await approveNodePairing(pairing.request.requestId, {
      callerScopes: ["operator.admin", "operator.write"],
    });
    const node = await connectGatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token: process.env.OPENCLAW_GATEWAY_TOKEN,
      deviceIdentity: identity,
      role: "node",
      clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
      clientDisplayName: NODE_DISPLAY_NAME,
      platform: "macos",
      mode: GATEWAY_CLIENT_MODES.NODE,
      commands: [NODE_COMMAND],
      onEvent: (event) => {
        if (event.event === "node.invoke.request") {
          dispatchedToNode.push(event.payload as { timeoutMs?: number });
        }
      },
    });
    // The shared Gateway fixture snapshots no such key, so leaving it set would
    // point later tests in this worker at this stopped ephemeral server.
    const gatewayUrlEnv = captureEnv(["OPENCLAW_GATEWAY_URL"]);

    try {
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
