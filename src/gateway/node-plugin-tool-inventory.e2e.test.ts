import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { McpServer } from "@modelcontextprotocol/server";
import { afterEach, expect, it } from "vitest";
import {
  closeHttpServer,
  listenLoopback,
} from "../../test/helpers/gateway-integration-fixtures.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readMcpFixtureMessage } from "../agents/agent-bundle-mcp-lifecycle.test-support.js";
import { resolveOpenClawPluginToolsForOptions } from "../agents/openclaw-plugin-tools.js";
import { approveNodePairing, requestNodePairing } from "../infra/device-pairing-node.js";
import { NODE_MCP_TOOLS_CALL_COMMAND } from "../infra/node-commands.js";
import { coerceNodeInvokePayload } from "../node-host/invoke-payload.js";
import { handleInvoke } from "../node-host/invoke.js";
import { startNodeHostMcpManager } from "../node-host/mcp.js";
import { createNodeHostInventory } from "../node-host/runtime-manifest.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { pairDeviceIdentity } from "./device-authz.test-helpers.js";
import { listConnectedNodePluginTools } from "./node-plugin-tool-snapshot.js";
import { connectGatewayClient } from "./test-helpers.e2e.js";
import { installGatewayTestHooks } from "./test-helpers.js";
import { installConnectedControlUiServerSuite } from "./test-with-server.js";

installGatewayTestHooks({ scope: "suite" });
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let port = 0;
installConnectedControlUiServerSuite((started) => {
  port = started.port;
});

it("keeps a node MCP inventory above 128 callable through the paired Gateway", async ({
  onTestFinished,
}) => {
  const mcp = new McpServer({ name: "node-inventory-proof", version: "1.0.0" });
  const calls: string[] = [];
  for (let index = 0; index < 130; index += 1) {
    const name = `tool_${String(index).padStart(3, "0")}`;
    mcp.registerTool(name, { description: `Echo ${name}` }, async () => {
      calls.push(name);
      return { content: [{ type: "text", text: `called ${name}` }] };
    });
  }
  const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
  await mcp.connect(transport);
  const server = http.createServer((request, response) => {
    void (async () => {
      const body = request.method === "POST" ? await readMcpFixtureMessage(request) : undefined;
      await transport.handleRequest(request, response, body);
    })().catch(() => {
      if (!response.headersSent) {
        response.writeHead(500).end();
      }
    });
  });
  const origin = await listenLoopback(server);
  onTestFinished(async () => {
    await mcp.close();
    await closeHttpServer(server);
  });
  const manager = await startNodeHostMcpManager({
    fixture: { url: `${origin}/mcp`, transport: "streamable-http" },
  });
  onTestFinished(() => manager.close());
  expect(manager.descriptors).toHaveLength(130);

  const { identity } = await pairDeviceIdentity({
    name: "inventory-node",
    role: "node",
    scopes: [],
    clientId: GATEWAY_CLIENT_NAMES.NODE_HOST,
    clientMode: GATEWAY_CLIENT_MODES.NODE,
    platform: "linux",
  });
  const pairing = await requestNodePairing({
    nodeId: identity.deviceId,
    platform: "linux",
    commands: [NODE_MCP_TOOLS_CALL_COMMAND],
  });
  await approveNodePairing(pairing.request.requestId, {
    callerScopes: ["operator.admin", "operator.write"],
  });
  const pending = new Set<Promise<void>>();
  const node = await connectGatewayClient({
    url: `ws://127.0.0.1:${port}`,
    token: process.env.OPENCLAW_GATEWAY_TOKEN,
    deviceIdentity: identity,
    role: "node",
    clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
    platform: "linux",
    mode: GATEWAY_CLIENT_MODES.NODE,
    commands: [NODE_MCP_TOOLS_CALL_COMMAND],
    onEvent: (event) => {
      if (event.event !== "node.invoke.request") {
        return;
      }
      const frame = coerceNodeInvokePayload(event.payload);
      assert(frame);
      const work = handleInvoke(frame, node, { current: async () => [] }, manager);
      pending.add(work);
      void work.finally(() => pending.delete(work));
    },
  });
  onTestFinished(async () => {
    await Promise.all(pending);
    await node.stopAndWait();
  });
  const env = captureEnv(["OPENCLAW_GATEWAY_URL"]);
  onTestFinished(() => env.restore());
  setTestEnvValue("OPENCLAW_GATEWAY_URL", `ws://127.0.0.1:${port}`);

  const inventory = createNodeHostInventory(null, [], manager.descriptors);
  expect(inventory.pluginTools).toHaveLength(130);
  await node.request("node.pluginTools.update", { tools: inventory.pluginTools });
  expect(
    listConnectedNodePluginTools().filter((entry) => entry.nodeId === identity.deviceId),
  ).toHaveLength(130);
  const config = { plugins: { enabled: false } };
  const tools = resolveOpenClawPluginToolsForOptions({
    resolvedConfig: config,
    options: { config, workspaceDir: tempDirs.make("node-inventory-"), senderIsOwner: true },
  });
  expect(tools).toHaveLength(130);
  const last = tools.find((tool) => tool.name === "fixture_tool_129");
  assert(last, "the final tool must survive both publication boundaries");
  await expect(last.execute("inventory-last-call", {})).resolves.toMatchObject({
    content: [{ type: "text", text: "called tool_129" }],
  });
  expect(calls).toEqual(["tool_129"]);
  await node.stopAndWait();
  await expect
    .poll(
      () =>
        listConnectedNodePluginTools().filter((entry) => entry.nodeId === identity.deviceId).length,
    )
    .toBe(0);
  await expect(last.execute("inventory-disconnected-call", {})).rejects.toThrow();
  expect(calls).toEqual(["tool_129"]);
}, 120_000);
