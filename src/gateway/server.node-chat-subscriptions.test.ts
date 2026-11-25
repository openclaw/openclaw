import { expect, test, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import type { dispatchInboundMessage } from "../auto-reply/dispatch.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { registerAgentRunContext } from "../infra/agent-run-registry.js";
import * as devicePairingNode from "../infra/device-pairing-node.js";
import { approveNodePairing, requestNodePairing } from "../infra/device-pairing-node.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { observeGatewayRunExecution } from "./agent-command.test-helpers.js";
import { pairDeviceIdentity } from "./device-authz.test-helpers.js";
import { describeWithGatewayServer } from "./server.node-pairing.test-support.js";
import { connectGatewayClient } from "./test-helpers.e2e.js";
import { dispatchInboundMessageMock, installGatewayTestHooks } from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

type ReceivedNodeEvent = { event?: string; payload?: unknown };
type GatewayClient = Awaited<ReturnType<typeof connectGatewayClient>>;

async function pairNode(name: string) {
  const paired = await pairDeviceIdentity({
    name,
    role: "node",
    scopes: [],
    clientId: GATEWAY_CLIENT_NAMES.NODE_HOST,
    clientMode: GATEWAY_CLIENT_MODES.NODE,
  });
  const pairing = await requestNodePairing({
    nodeId: paired.identity.deviceId,
    platform: "macos",
    deviceFamily: "Mac",
    commands: [],
  });
  const approved = await approveNodePairing(pairing.request.requestId, {
    callerScopes: ["operator.pairing", "operator.write", "operator.admin"],
  });
  expect(approved).toMatchObject({ node: { nodeId: paired.identity.deviceId } });
  return paired.identity;
}

function connectNode(
  port: number,
  deviceIdentity: Awaited<ReturnType<typeof pairNode>>,
  onEvent: (event: ReceivedNodeEvent) => void,
) {
  return connectGatewayClient({
    url: `ws://127.0.0.1:${port}`,
    token: "secret",
    role: "node",
    clientName: GATEWAY_CLIENT_NAMES.NODE_HOST,
    clientDisplayName: "canonical chat subscription node",
    clientVersion: "1.0.0",
    platform: "macos",
    deviceFamily: "Mac",
    mode: GATEWAY_CLIENT_MODES.NODE,
    scopes: [],
    commands: [],
    deviceIdentity,
    onEvent,
  });
}

function subscribe(node: GatewayClient, sessionKey: string, event = "chat.subscribe") {
  return node.request("node.event", { event, payload: { sessionKey } });
}

function emitCompletedSessionRun(runId: string, sessionKey: string): void {
  registerAgentRunContext(runId, { sessionKey, agentId: "main" });
  emitAgentEvent({
    runId,
    stream: "lifecycle",
    data: { phase: "end", startedAt: 1, endedAt: 2 },
  });
}

async function expectNodeChatEvent(
  events: ReceivedNodeEvent[],
  runId: string,
  sessionKey = "agent:main:main",
) {
  await vi.waitFor(
    () => {
      expect(chatEvents(events, runId).map((event) => event.payload)).toContainEqual(
        expect.objectContaining({ runId, sessionKey, state: "final" }),
      );
    },
    { interval: 10, timeout: 5_000 },
  );
}

function chatEvents(events: ReceivedNodeEvent[], runId: string) {
  return events.filter(
    (event) =>
      event.event === "chat" && (event.payload as { runId?: string } | undefined)?.runId === runId,
  );
}

describeWithGatewayServer("gateway node chat subscriptions over WebSocket", (getStarted) => {
  test("delivers canonical chat events across reconnect and stops after an alias unsubscribe", async () => {
    const identity = await pairNode("canonical-chat-subscription-reconnect");
    const firstEvents: ReceivedNodeEvent[] = [];
    const reconnectEvents: ReceivedNodeEvent[] = [];
    let first: GatewayClient | undefined;
    let reconnected: GatewayClient | undefined = undefined;
    const disconnectHistoryPending = createDeferred();
    const recordDisconnection = devicePairingNode.recordPairedNodeDisconnection;
    const disconnectHistory = vi.spyOn(devicePairingNode, "recordPairedNodeDisconnection");
    await using cleanup = new AsyncDisposableStack();
    cleanup.defer(() => reconnected?.stopAndWait());
    cleanup.defer(() => first?.stopAndWait());
    cleanup.defer(() => disconnectHistory.mockRestore());
    cleanup.defer(async () => {
      disconnectHistoryPending.resolve();
      await disconnectHistory.mock.results[0]?.value;
    });
    first = await connectNode(getStarted().port, identity, (event) => firstEvents.push(event));
    await subscribe(first, "  Main  ");
    emitCompletedSessionRun("canonical-node-first", "agent:main:main");
    await expectNodeChatEvent(firstEvents, "canonical-node-first");

    disconnectHistory.mockImplementationOnce(async (params) => {
      await disconnectHistoryPending.promise;
      return recordDisconnection(params);
    });
    await first.stopAndWait();
    first = undefined;
    await vi.waitFor(() => expect(disconnectHistory).toHaveBeenCalledOnce());

    reconnected = await connectNode(getStarted().port, identity, (event) =>
      reconnectEvents.push(event),
    );
    await subscribe(reconnected, "  MAIN  ");
    emitCompletedSessionRun("canonical-node-reconnect", "agent:main:main");
    await expectNodeChatEvent(reconnectEvents, "canonical-node-reconnect");

    // Completing the old connection's history must not retire its replacement's observer.
    disconnectHistoryPending.resolve();
    await disconnectHistory.mock.results[0]?.value;
    emitCompletedSessionRun("canonical-node-after-disconnect-history", "agent:main:main");
    await expectNodeChatEvent(reconnectEvents, "canonical-node-after-disconnect-history");

    await subscribe(reconnected, "other");
    await subscribe(reconnected, "  Main  ", "chat.unsubscribe");

    // The other subscribed session is an ordered live-transport barrier:
    // receiving its event proves the unsubscribed main event was not queued.
    emitCompletedSessionRun("canonical-node-unsubscribed", "agent:main:main");
    emitCompletedSessionRun("canonical-node-other", "agent:main:other");
    await expectNodeChatEvent(reconnectEvents, "canonical-node-other", "agent:main:other");
    expect(chatEvents(reconnectEvents, "canonical-node-unsubscribed")).toHaveLength(0);
    expect(chatEvents(firstEvents, "canonical-node-reconnect")).toHaveLength(0);
  });

  test("delivers final and error terminals through one canonical node subscription", async () => {
    const identity = await pairNode("canonical-chat-terminal-fanout");
    const events: ReceivedNodeEvent[] = [];
    let node: GatewayClient | undefined = undefined;
    let operator: GatewayClient | undefined;
    const requestExecution = await observeGatewayRunExecution();
    const finalRunId = "canonical-node-terminal-final";
    let runId = finalRunId;
    let terminal = createDeferred<Record<string, unknown>>();
    await using cleanup = new AsyncDisposableStack();
    cleanup.defer(() => node?.stopAndWait());
    cleanup.defer(() => operator?.stopAndWait());
    cleanup.defer(() => {
      dispatchInboundMessageMock.mockReset();
    });
    cleanup.defer(() => requestExecution.restore());
    node = await connectNode(getStarted().port, identity, (event) => {
      events.push(event);
      if (event.event !== "chat") {
        return;
      }
      const payload = event.payload as Record<string, unknown>;
      if (payload.runId === runId) {
        terminal.resolve(payload);
      }
    });
    const sender = (operator = await connectGatewayClient({
      url: `ws://127.0.0.1:${getStarted().port}`,
      token: "secret",
      role: "operator",
      scopes: ["operator.write"],
    }));
    await subscribe(node, " Main ");
    for (const state of ["final", "error"] as const) {
      runId = `canonical-node-terminal-${state}`;
      terminal = createDeferred<Record<string, unknown>>();
      if (state === "final") {
        dispatchInboundMessageMock.mockImplementationOnce(async (...args: unknown[]) => {
          const [{ dispatcher }] = args as Parameters<typeof dispatchInboundMessage>;
          dispatcher.sendFinalReply({ text: "node subscription final" });
          dispatcher.markComplete();
          await dispatcher.waitForIdle();
          return { queuedFinal: true, counts: dispatcher.getQueuedCounts() };
        });
      } else {
        dispatchInboundMessageMock.mockRejectedValueOnce(new Error("node dispatch rejected"));
      }
      expect(
        await sender.request("chat.send", {
          sessionKey: "main",
          message: `deliver ${state} terminal`,
          idempotencyKey: runId,
        }),
      ).toMatchObject({ runId, status: "started" });
      // Admission precedes detached dispatch and terminal effects.
      await requestExecution.waitForCompletion(runId);
      const payload = await withTestTimeout(
        terminal.promise,
        5_000,
        `node terminal ${runId} was not delivered`,
      );
      if (state === "error") {
        await subscribe(node, "main");
        expect(chatEvents(events, finalRunId)).toHaveLength(1);
        expect(payload).not.toHaveProperty("message");
      }
      expect(chatEvents(events, runId)).toHaveLength(1);
      expect(payload).toMatchObject({
        runId,
        sessionKey: "agent:main:main",
        state,
        ...(state === "final"
          ? {
              message: {
                role: "assistant",
                content: [{ type: "text", text: "node subscription final" }],
              },
            }
          : { errorMessage: expect.stringContaining("node dispatch rejected") }),
      });
    }
  });
});
