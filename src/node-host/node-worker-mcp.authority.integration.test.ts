import assert from "node:assert/strict";
import { expect, it } from "vitest";
import { GATEWAY_CLIENT_IDS } from "../../packages/gateway-protocol/src/client-info.js";
import { startRequesterScopedMcpProofServer } from "../agents/agent-bundle-mcp-requester.test-support.js";
import { updateNodeRunnerInventory } from "../gateway/node-registry-private.js";
import { NodeRegistry } from "../gateway/node-registry.js";
import { makeClient, registerNodeSession } from "../gateway/node-registry.test-helpers.js";
import {
  NODE_MCP_TOOLS_CALL_COMMAND,
  NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND,
} from "../infra/node-commands.js";
import { NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE } from "../infra/node-runner-inventory.js";
import { startNodeHostMcpManager } from "./mcp.js";
import { NodeWorkerMcpPolicy } from "./node-worker-mcp.js";
import {
  createRetainedWorkerFixture,
  retainedTurn,
} from "./node-worker-retained-child.test-support.js";
import { mocks } from "./node-worker-supervisor.mock.test-support.js";
import { TEST_WORKER_ENDPOINT } from "./node-worker-supervisor.test-support.js";

it("enforces turn and connection authority before tools/call reaches the MCP server", async ({
  onTestFinished,
  annotate,
}) => {
  const server = await startRequesterScopedMcpProofServer();
  onTestFinished(() => server.close());
  const manager = await startNodeHostMcpManager({
    fixture: {
      transport: "streamable-http",
      url: server.url,
      headers: { Authorization: "Bearer proof-token" },
    },
  });
  onTestFinished(() => manager.close());
  expect(manager.descriptors).toMatchObject([
    { mcp: { server: "fixture", tool: "requester_probe" } },
  ]);
  const command = NODE_MCP_TOOLS_CALL_COMMAND;
  const registry = new NodeRegistry({
    getConfig: () => ({ gateway: { nodes: { commands: { allow: [command] } } } }),
  });
  onTestFinished(() => {
    for (const node of registry.listConnected()) {
      registry.unregister(node.connId);
    }
  });
  function connect(connId: string) {
    const policy = new NodeWorkerMcpPolicy();
    const nodeId = "worker-node";
    const client = makeClient(connId, nodeId, [], {
      clientId: GATEWAY_CLIENT_IDS.NODE_HOST,
      platform: "linux",
      commands: [command],
    });
    // Deliver the real registry event to its own physical supervisor. Only the socket is in memory.
    client.socket.send = (data) => {
      const frame = JSON.parse(String(data));
      if (frame.event === "node.worker.localMcpPolicy") {
        policy.setAllowed(frame.payload.allowed);
      }
    };
    registerNodeSession(registry, client, { pairingGeneration: "paired-worker-generation" });
    updateNodeRunnerInventory({
      registry,
      nodeId,
      connId,
      declaration: {
        protocolFeatures: [NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE],
        workerHost: { enabled: true, localMcp: true, capacity: { total: 1, available: 1 } },
      },
    });
    expect(policy.signal.aborted, connId).toBe(false);
    return () => {
      const session = policy.sessionForCommand(NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND, manager);
      assert(session);
      return session;
    };
  }
  function turn(turnId: string, handle: string) {
    const launch = retainedTurn(turnId);
    launch.descriptor.assignment.toolAuthority.mcpTools = [
      { id: handle, server: "fixture", tool: "requester_probe" },
    ];
    return launch;
  }
  const receipt = (requestId: string, turnId: string, toolId: string) =>
    ({ type: "mcp-call", requestId, turnId, toolId, arguments: {} }) as const;
  type Owner = { emit: (frame: ReturnType<typeof receipt>) => Promise<void> };
  async function attempt(
    owner: Owner,
    requestId: string,
    turnId: string,
    toolId: string,
    allowed: boolean,
  ) {
    const before = server.toolRequests.length;
    const reply = Promise.withResolvers<unknown>();
    mocks.send.mockImplementationOnce(async (_adapter, response) => {
      reply.resolve(response);
    });
    await owner.emit(receipt(requestId, turnId, toolId));
    const response = await reply.promise;
    if (allowed) {
      expect(response, requestId).not.toHaveProperty("error");
    }
    expect(response).toMatchObject({
      type: "mcp-result",
      requestId,
      turnId,
      ...(allowed
        ? { result: { content: [{ type: "text", text: server.session.current }] } }
        : { error: "Worker MCP tool is unavailable for this turn" }),
    });
    const delta = server.toolRequests.length - before;
    expect(delta, requestId).toBe(allowed ? 1 : 0);
    await annotate(`${requestId}: server received ${delta} tools/call`);
  }

  let newSession: ReturnType<typeof connect>;
  {
    const oldSession = connect("original");
    await using original = createRetainedWorkerFixture(1, false, oldSession);
    const first = turn("first-turn", "first-handle");
    const owner = await original.launch(first);
    await attempt(owner, "allowed", first.launchId, "first-handle", true);
    await attempt(owner, "ungranted", first.launchId, "unknown-handle", false);
    registry.refreshRuntimePolicy({ gateway: { nodes: { commands: { deny: [command] } } } });
    await attempt(owner, "revoked", first.launchId, "first-handle", false);
    registry.refreshRuntimePolicy({ gateway: { nodes: { commands: { allow: [command] } } } });
    await attempt(owner, "original-grant-after-reallow", first.launchId, "first-handle", false);

    await owner.complete(first.launchId, "idle");
    const second = turn("second-turn", "second-handle");
    await original.supervisor.launch(second, TEST_WORKER_ENDPOINT, undefined, oldSession());
    // The stale frame is silently discarded. Send a valid request afterwards as an I/O barrier.
    const beforeStale = server.toolRequests.length;
    await owner.emit(receipt("previous-turn-frame", first.launchId, "first-handle"));
    await attempt(owner, "previous-handle-on-current-turn", second.launchId, "first-handle", false);
    await attempt(owner, "allowed-current-turn", second.launchId, "second-handle", true);
    const staleCalls = server.toolRequests.length - beforeStale - 1; // Exclude the admitted current-turn call.
    expect(staleCalls).toBe(0);
    expect(mocks.send).not.toHaveBeenCalledWith(
      owner.adapter,
      expect.objectContaining({ requestId: "previous-turn-frame" }),
    );

    await annotate(
      `previous-turn-frame: no reply; server received ${staleCalls} tools/call before the current-turn control`,
    );

    newSession = connect("replacement");
    await attempt(owner, "replaced-connection", second.launchId, "second-handle", false);
    await owner.complete(second.launchId);
  }

  await using replacement = createRetainedWorkerFixture(1, false, newSession);
  const third = turn("replacement-turn", "replacement-handle");
  const newOwner = await replacement.launch(third);
  await attempt(newOwner, "allowed-new-connection", third.launchId, "replacement-handle", true);
  await newOwner.complete(third.launchId);
  expect(server.toolRequests).toEqual(["requester_probe", "requester_probe", "requester_probe"]);
  expect(server.session.calls).toBe(3);
});
