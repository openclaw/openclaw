import { randomUUID } from "node:crypto";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { McpServer } from "@modelcontextprotocol/server";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { startMcpHttpFixture } from "../../agents/agent-bundle-mcp-lifecycle.test-support.js";
import { createMcpClientElicitationHandler } from "../../agents/mcp-client-elicitation.js";
import {
  NODE_MCP_ELICITATION_CAPABILITY,
  NODE_MCP_TOOLS_CALL_COMMAND,
} from "../../infra/node-commands.js";
import type { NodeHostClient } from "../../node-host/client.js";
import { coerceNodeInvokePayload } from "../../node-host/invoke-payload.js";
import { handleInvoke } from "../../node-host/invoke.js";
import { startNodeHostMcpManager } from "../../node-host/mcp.js";
import { createNodeWorkerMcpTurn } from "../../node-host/node-worker-mcp.js";
import { createWorkerLocalMcpClient } from "../../worker/worker-local-mcp.js";
import { createWorkerLaunchDescriptorForTest } from "../../worker/worker-process.test-support.js";
import {
  createSessionEventSubscriberRegistry,
  createSessionMessageSubscriberRegistry,
} from "../server-chat-state.js";
import { createGatewayNodeSessionRuntime } from "../server-node-session-runtime.js";
import type { GatewayWsClient } from "../server/ws-types.js";
import { nodeEventHandlers } from "./nodes.event.js";
import { handleNodeInvokeResult } from "./nodes.handlers.invoke-result.js";
import { expectNodeReply, invokeNodeRequest } from "./nodes.invoke.test-support.js";
import { createWorkerSupervisorNodeClient } from "./nodes.runner-inventory.test-support.js";
import {
  adminRequestClient,
  callQuestionRpc,
  installQuestionTestHooks,
  manager as questions,
  requestParams,
} from "./question.test-support.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const { recordHostStatsMock } = vi.hoisted(() => ({ recordHostStatsMock: vi.fn() }));
vi.mock("../../infra/device-pairing-node.js", () => ({
  recordPairedNodeHostStats: recordHostStatsMock,
}));
afterEach(() => vi.restoreAllMocks());

it("keeps the accepted event result independent of persistence", async () => {
  const stats = { cpuCount: 2, memoryTotalBytes: 4096, memoryFreeBytes: 1024 };
  const hostStats = { ...stats, updatedAtMs: 1_250 };
  const persistence = createDeferred<boolean>();
  recordHostStatsMock.mockReset().mockReturnValue(persistence.promise);
  vi.spyOn(Date, "now").mockReturnValue(1_250);
  const h = new NodeEventHarness();
  const client = h.register("conn-1");
  const { broadcast } = h;
  const respond = await h.send(client, stats, "node.host.stats");

  const result = { ok: true, event: "node.host.stats", handled: true, reason: "updated" };
  // The RPC has already completed while its store write is still pending.
  expect(respond).toHaveBeenCalledExactlyOnceWith(true, result, undefined);
  expect(recordHostStatsMock).toHaveBeenCalledExactlyOnceWith({
    nodeId: "node-1",
    hostStats,
    expectedPairingGeneration: { nodeId: "node-1", key: h.binding.generation },
  });
  expect(broadcast).toHaveBeenCalledWith(
    "node.hostStats",
    { nodeId: "node-1", hostStats },
    { dropIfSlow: true },
  );
  persistence.reject(new Error("stats store unavailable"));
  await persistence.promise.catch(() => undefined);
  expect(respond).toHaveBeenCalledExactlyOnceWith(true, result, undefined);
});
class NodeEventHarness {
  binding = { identity: "identity-1", generation: "generation-1" };
  resolvePairing = vi.fn(async () => this.binding);
  broadcast = vi.fn();
  warn = vi.fn();
  runtime = createGatewayNodeSessionRuntime({
    broadcast: this.broadcast,
    resolveCurrentPairingState: this.resolvePairing,
    isPairingStateCurrent: () => true,
    sessionEventSubscribers: createSessionEventSubscriberRegistry(),
    sessionMessageSubscribers: createSessionMessageSubscriberRegistry(),
  });
  context = {
    ...this.runtime,
    broadcast: this.broadcast,
    logGateway: { warn: this.warn },
  } as unknown as GatewayRequestHandlerOptions["context"];
  nodeRegistry = this.runtime.nodeRegistry;
  register(connId: string, nodeId = "node-1", clientId = "openclaw-macos", platform = "darwin") {
    const client = createWorkerSupervisorNodeClient(connId);
    Object.assign(client.connect, {
      role: "node",
      scopes: [],
      commands: [],
      device: { id: nodeId },
    });
    Object.assign(client.connect.client, { id: clientId, platform });
    this.nodeRegistry.register(client, {
      pairingIdentity: this.binding.identity,
      pairingGeneration: this.binding.generation,
    });
    onTestFinished(() => {
      this.nodeRegistry.unregister(connId);
    });
    return client;
  }
  send(client: GatewayWsClient, payload: unknown, event = "node.desktop.availability") {
    return invokeNodeRequest(
      nodeEventHandlers["node.event"]!,
      this.context,
      client,
      "node.event",
      { event, payload },
      "desktop-state",
    );
  }
  changes = () =>
    this.broadcast.mock.calls
      .filter(([event]) => event === "node.runnerInventory.changed")
      .map(([, payload]) => payload);
  node = () => this.nodeRegistry.get("node-1");
  active = () => this.nodeRegistry.getActiveNode();
}

const mcpQuestionCases = [
  ["Gateway", "granted"],
  ["Gateway", "grant retired"],
  ["Gateway", "pairing replaced"],
  ["Gateway", "legacy Gateway"],
  ["Gateway", "node opt-out"],
  ["worker", "granted"],
  ["worker", "grant retired"],
  ["worker", "turn ended"],
  ["worker", "pairing replaced"],
  ["worker", "execution only"],
] as const;

describe.each(mcpQuestionCases)("%s MCP questions (%s)", (route, scenario) => {
  installQuestionTestHooks();

  it("delivers an answer to the MCP server only while its requester is authorized", async () => {
    vi.useRealTimers();
    const h = new NodeEventHarness();
    const node = h.register("owner");
    const recipient = expectDefined(h.node(), "missing paired node");
    recipient.commands.push(NODE_MCP_TOOLS_CALL_COMMAND);
    const questionsEnabled = scenario !== "legacy Gateway" && scenario !== "execution only";
    h.context.getRuntimeConfig = () => ({ mcp: { apps: { enabled: questionsEnabled } } });
    const registered = createDeferred();
    const grant = new AbortController();
    const id = randomUUID();
    const answerReady = createDeferred<unknown>();
    const deliverAnswer = createDeferred();
    const handleQuestion = createMcpClientElicitationHandler({
      sessionKey: requestParams.sessionKey,
      agentId: requestParams.agentId,
      assertCurrent: () => grant.signal.throwIfAborted(),
      gatewayCall: async (method, _options, params) => {
        if (!isRecord(params)) {
          throw new Error("Missing question params");
        }
        if (method === "question.request") {
          expect(params.sessionKey).toBe(requestParams.sessionKey);
        }
        const [ok, result, error] = await callQuestionRpc(method, params, {
          client: adminRequestClient,
        });
        if (!ok) {
          throw new Error(error?.message);
        }
        if (method === "question.request") {
          registered.resolve();
        }
        return result;
      },
    });
    const retire = questionsEnabled
      ? h.nodeRegistry.mcpElicitation.register({
          id,
          node: recipient,
          signal: grant.signal,
          handle: async (request) => {
            const answer = await handleQuestion(request);
            answerReady.resolve(answer);
            // Exercise retirement after the user answers, while the node still awaits delivery.
            await deliverAnswer.promise;
            return answer;
          },
        })
      : undefined;
    const event = {
      id,
      requestId: randomUUID(),
      params: {
        message: "Which workspace?",
        requestedSchema: {
          type: "object" as const,
          properties: { workspace: { type: "string" as const } },
          required: ["workspace"],
        },
      },
    };
    const foreign = h.register("foreign", "node-2");
    expect((await h.send(foreign, event, "mcp.elicitation")).mock.calls[0]?.[0]).toBe(false);
    expect(questions.list()).toHaveLength(0);
    const mcp = new McpServer({ name: "fixture", version: "1" });

    const receivedByServer = createDeferred<unknown>();
    mcp.registerTool("choose", {}, async ({ mcpReq }) => {
      const answer = await mcpReq.elicitInput(event.params).catch((error: unknown) => {
        receivedByServer.resolve(error);
        throw error;
      });
      receivedByServer.resolve(answer);
      return { content: [], structuredContent: answer };
    });
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
    await mcp.connect(transport);
    const http = await startMcpHttpFixture((req, res) => transport.handleRequest(req, res));
    const gatewayMethods: string[] = [];
    const client: NodeHostClient = {
      serverCapabilities: new Set(
        scenario === "legacy Gateway" ? [] : [NODE_MCP_ELICITATION_CAPABILITY],
      ),
      request: async (method, params) => {
        gatewayMethods.push(method);
        if (!isRecord(params) || (method !== "node.event" && method !== "node.invoke.result")) {
          throw new Error("Unexpected node RPC");
        }
        if (method === "node.event") {
          expect(params.event).toBe("mcp.elicitation");
        }
        const response = await invokeNodeRequest(
          method === "node.event" ? nodeEventHandlers["node.event"]! : handleNodeInvokeResult,
          h.context,
          node,
          method,
          params,
        );
        const [ok, payload, error] = expectDefined(
          response.mock.calls[0],
          "missing node RPC response",
        );
        if (!ok) {
          throw new Error(error?.message);
        }
        return payload;
      },
    };
    const nodeMcp = await startNodeHostMcpManager(
      { fixture: { url: http.url, transport: "streamable-http" } },
      scenario === "node opt-out" ? {} : { elicitationClient: client },
    );
    onTestFinished(async () => {
      await nodeMcp.close();
      await mcp.close();
      await http.close();
    });
    async function callTool() {
      if (route === "worker") {
        // The Gateway may retire the turn before the worker receives its cancellation.
        const workerLifetime = new AbortController();
        onTestFinished(() => workerLifetime.abort());
        const descriptor = createWorkerLaunchDescriptorForTest({
          assignment: {
            toolAuthority: {
              allowedToolNames: ["choose"],
              mcpTools: [
                {
                  id,
                  server: "fixture",
                  tool: "choose",
                  ...(questionsEnabled && { allowElicitation: true as const }),
                },
              ],
            },
          },
        });
        const turn = expectDefined(
          createNodeWorkerMcpTurn(descriptor, {
            descriptors: nodeMcp.descriptors,
            callMcpTool: nodeMcp.callMcpTool,
            signal: workerLifetime.signal,
          }),
          "missing same-node MCP grant",
        );
        const worker = createWorkerLocalMcpClient(descriptor.assignment.turnId, async (frame) => {
          if (frame.type !== "mcp-call") {
            throw new Error("expected worker MCP call");
          }
          await turn.invoke(frame, async (result) => {
            worker.receive(result);
          });
        });
        return worker.call(id, {}, workerLifetime.signal);
      }
      const dispatched = createDeferred<string>();
      vi.spyOn(node.socket, "send").mockImplementation((frame) =>
        dispatched.resolve(frame.toString()),
      );
      const reply = h.nodeRegistry.invoke({
        nodeId: recipient.nodeId,
        command: NODE_MCP_TOOLS_CALL_COMMAND,
        params: {
          server: "fixture",
          tool: "choose",
          arguments: {},
          ...(questionsEnabled && { elicitationId: id }),
        },
        sessionKey: requestParams.sessionKey,
      });
      const frame = JSON.parse(
        await awaitGateBeforeSettlement(
          dispatched.promise,
          reply,
          "Gateway never dispatched the MCP tool",
        ),
      );
      expect(frame.event).toBe("node.invoke.request");
      await handleInvoke(
        expectDefined(coerceNodeInvokePayload(frame.payload), "missing MCP invoke frame"),
        client,
        { current: async () => [] },
        nodeMcp,
      );
      const result = await reply;
      if (!result.ok) {
        throw new Error(result.error?.message ?? "Gateway MCP invocation failed");
      }
      return result.payload;
    }
    const result = callTool().then(
      (payload) => ({ ok: true, payload }),
      (error: unknown) => ({ ok: false, error }),
    );
    if (scenario === "node opt-out") {
      await expect(result).resolves.toMatchObject({ ok: true, payload: { isError: true } });
      await expect(receivedByServer.promise).resolves.toMatchObject({
        message: expect.stringMatching(/does not support .*elicitation/i),
      });
      expect(gatewayMethods).toEqual(["node.invoke.result"]);
      return;
    }
    if (!questionsEnabled) {
      const decline = { action: "decline" };
      await expect(result).resolves.toMatchObject({
        ok: true,
        payload: { structuredContent: decline },
      });
      await expect(receivedByServer.promise).resolves.toEqual(decline);
      expect(gatewayMethods).toEqual(route === "worker" ? [] : ["node.invoke.result"]);
      expect(questions.list()).toHaveLength(0);
      return;
    }
    await awaitGateBeforeSettlement(registered.promise, result, "No question reached the Gateway");
    const question = expectDefined(questions.list()[0], "missing Gateway question");
    expect(question.sessionKey).toBe(requestParams.sessionKey);
    const field = expectDefined(question.questions[0], "missing workspace field");
    const [answered] = await callQuestionRpc(
      "question.resolve",
      {
        id: question.id,
        answers: { answers: { [field.questionId]: ["engineering"] } },
      },
      { client: adminRequestClient },
    );
    expect(answered).toBe(true);
    const accepted = { action: "accept", content: { workspace: "engineering" } };
    await expect(
      awaitGateBeforeSettlement(answerReady.promise, result, "The user did not answer"),
    ).resolves.toEqual(accepted);
    if (scenario === "grant retired") {
      expectDefined(retire, "missing active question grant")();
    } else if (scenario === "turn ended") {
      grant.abort();
    } else if (scenario === "pairing replaced") {
      h.binding = { identity: "replacement", generation: "next-generation" };
      h.register("new-connection");
    }
    deliverAnswer.resolve();
    await result;
    if (scenario === "granted") {
      await expect(receivedByServer.promise).resolves.toEqual(accepted);
      await expect(result).resolves.toMatchObject({
        ok: true,
        payload: { structuredContent: accepted },
      });
    } else {
      const reason =
        scenario === "pairing replaced" ? "MCP elicitation authority changed" : "AbortError";
      await expect(receivedByServer.promise).resolves.toMatchObject({
        message: expect.stringContaining(reason),
      });
    }
    expect(gatewayMethods).toEqual(
      route === "worker" ? ["node.event"] : ["node.event", "node.invoke.result"],
    );
    grant.abort();
    expect((await h.send(node, event, "mcp.elicitation")).mock.calls[0]?.[0]).toBe(false);
  });
});

it.each([
  "current",
  "foreign-node",
  "owner-epoch",
  "placement-generation",
  "moving",
  "reconnected",
  "payload-key",
])(
  "publishes worker process invalidations only for the current placement (%s)",
  async (scenario) => {
    const h = new NodeEventHarness();
    const client = h.register("process-node");
    const placement = {
      state: "active",
      executionMode: "worker-turn",
      environmentId: "environment-1",
      sessionId: "session-1",
      sessionKey: "agent:main:build",
      agentId: "main",
      activeOwnerEpoch: 3,
      generation: 2,
    };
    const environment = {
      nodeDeviceId: scenario === "foreign-node" ? "another-node" : "node-1",
      ownerEpoch: scenario === "owner-epoch" ? 4 : 3,
      state: "attached",
      destroyRequestedAtMs: null,
    };
    const release = vi.fn();
    const prepareRuntimeRefresh = vi.fn(async () => {
      if (scenario === "reconnected") {
        h.register("replacement-node");
      }
      return {
        placement,
        ...(scenario === "moving" ? { move: {} } : {}),
        assertCurrent() {},
        release,
      };
    });
    Object.assign(h.context, {
      workerSessionPlacementService: { prepareRuntimeRefresh },
      workerEnvironmentService: { get: () => environment },
    });
    const respond = await h.send(
      client,
      {
        environmentId: "environment-1",
        sessionId: "session-1",
        ownerEpoch: 3,
        placementGeneration: scenario === "placement-generation" ? 1 : 2,
        ...(scenario === "payload-key" ? { sessionKey: "agent:main:untrusted" } : {}),
      },
      "worker.processes.changed",
    );
    expectNodeReply(respond, {
      ok: true,
      event: "worker.processes.changed",
      handled: scenario === "current",
    });
    if (scenario === "current") {
      expect(h.broadcast).toHaveBeenCalledExactlyOnceWith(
        "sessions.processes.changed",
        { sessionKey: "agent:main:build", agentId: "main" },
        { sessionKeys: ["agent:main:build"], agentId: "main", dropIfSlow: true },
      );
    } else {
      expect(h.broadcast).not.toHaveBeenCalled();
    }
    if (scenario === "payload-key") {
      expect(prepareRuntimeRefresh).not.toHaveBeenCalled();
    } else {
      expect(release).toHaveBeenCalledOnce();
    }
  },
);

it("invalidates only the reporting node's inventory on state changes and connection retirement", async () => {
  const h = new NodeEventHarness();
  const first = h.register("conn-first");
  h.register("conn-other", "node-other");
  expectNodeReply(await h.send(first, { state: "locked" }), {
    ok: true,
    event: "node.desktop.availability",
    handled: true,
    reason: "updated",
  });
  expect(h.node()).toMatchObject({ desktopAvailability: { state: "locked" } });
  expect(h.nodeRegistry.get("node-other")).not.toHaveProperty("desktopAvailability");
  const unchanged = await h.send(first, { state: "locked" });
  expect(unchanged.mock.calls[0]?.[1]).toMatchObject({ handled: true, reason: "unchanged" });
  expect(h.changes()).toEqual([{ nodeId: "node-1" }]);

  const replacement = h.register("conn-replacement");
  expect(h.node()).not.toHaveProperty("desktopAvailability");
  expect(h.changes()).toHaveLength(2);
  const retiredCount = h.changes().length;
  expect(h.changes().at(-1)).toEqual({ nodeId: "node-1" });
  const stale = await h.send(first, { state: "locked" });
  expect(stale.mock.calls[0]?.[0]).toBe(false);
  expect(h.nodeRegistry.unregister(first.connId)).toBeNull();
  expect(h.changes()).toHaveLength(retiredCount);
  await h.send(replacement, { state: "unlocked" });
  expect(h.changes()).toHaveLength(3);
  expect(h.nodeRegistry.unregister(replacement.connId)).toBe("node-1");
  expect(h.node()).toBeUndefined();
  expect(h.changes()).toHaveLength(4);
  expect(h.changes().at(-1)).toEqual({ nodeId: "node-1" });
});

it("rejects malformed states and attempts to supply another node identity", async () => {
  const h = new NodeEventHarness();
  const client = h.register("conn-1");
  for (const payload of [null, [], {}, { state: "idle" }, { state: "locked", nodeId: "other" }]) {
    const respond = await h.send(client, payload);
    expect(respond.mock.calls[0]?.[1]).toMatchObject({
      handled: false,
      reason: "invalid_payload",
    });
  }
  expect(h.node()).not.toHaveProperty("desktopAvailability");
  expect(h.changes()).toEqual([]);
});

it.each(["replaced", "closed"])(
  "rejects an event whose connection is %s while pairing validation is pending",
  async (retirement) => {
    const h = new NodeEventHarness();
    const client = h.register("conn-first");
    const pending = createDeferred<typeof h.binding>();
    h.resolvePairing.mockReturnValueOnce(pending.promise);
    const receipt = h.send(client, { state: "locked" });
    await vi.waitFor(() => expect(h.resolvePairing).toHaveBeenCalledOnce());
    const replacement = retirement === "replaced" ? h.register("conn-replacement") : undefined;
    if (!replacement) {
      Object.defineProperty(client.socket, "readyState", { value: 3 });
    }
    pending.resolve(h.binding);
    const response = (await receipt).mock.calls[0];
    if (replacement) {
      expect(response?.[0]).toBe(false);
    } else {
      expect(response?.[1]).toMatchObject({ handled: false, reason: "stale_connection" });
    }
    expect(h.node()).not.toHaveProperty("desktopAvailability");
    expect(h.changes()).toEqual([]);
    if (!replacement) {
      return;
    }
    await h.send(replacement, { state: "unlocked" });
    expect(h.changes()).toHaveLength(1);
    h.nodeRegistry.invalidateConnectionForPairingChange(replacement.connId);
    expect(h.changes()).toHaveLength(2);
    expect(h.changes().at(-1)).toEqual({ nodeId: "node-1" });
    expect((await h.send(replacement, { state: "locked" })).mock.calls[0]?.[0]).toBe(false);
  },
);
it("preserves app presence on Accessibility revocation and replaces system activity on fallback", async () => {
  const h = new NodeEventHarness();
  const client = h.register("conn-1");
  const node = h.node()!;
  node.declaredPermissions = { accessibility: true };
  h.nodeRegistry.updateSurface("node-1", { commands: [], permissions: { accessibility: true } });
  const clock = vi.spyOn(Date, "now");
  for (const [now, idleSeconds, source, lastActiveAtMs] of [
    [100_000, 0, undefined, 100_000],
    [105_000, 20, "app", 85_000],
    [106_000, 30, "app", 85_000],
  ] as const) {
    clock.mockReturnValue(now);
    await h.send(client, { idleSeconds, source }, "node.presence.activity");
    expect(h.active()).toMatchObject({
      lastActiveAtMs,
      presenceActivitySource: source ?? "system",
    });
  }
  h.nodeRegistry.updateSurface("node-1", { commands: [], permissions: { accessibility: false } });
  expect(h.active()?.lastActiveAtMs).toBe(85_000);
});

it.each([
  { source: "app", clientId: "openclaw-macos", platform: "darwin", accepted: true },
  { source: "app", clientId: "openclaw-macos", platform: "macOS 26.0.1", accepted: true },
  { source: "system", clientId: "openclaw-macos", platform: "darwin", accepted: false },
  { source: "app", clientId: "node-host", platform: "darwin", accepted: false },
  { source: "app", clientId: "openclaw-macos", platform: "linux", accepted: false },
])(
  "accepts only native Mac app activity without Accessibility ($source, $clientId, $platform)",
  async ({ source, clientId, platform, accepted }) => {
    const h = new NodeEventHarness();
    const client = h.register("conn-1", "node-1", clientId, platform);
    const respond = await h.send(client, { idleSeconds: 0, source }, "node.presence.activity");
    expect(respond.mock.calls[0]?.[1]).toMatchObject({ handled: accepted });
    expect(h.active()?.nodeId).toBe(accepted ? "node-1" : undefined);
  },
);
