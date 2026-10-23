import "./server-node-events.test-support.js";
import { beforeEach, describe, expect, it } from "vitest";
import type { CliDeps } from "../cli/deps.js";
import type { HealthSummary } from "./health/types.js";
import { NodeRegistry } from "./node-registry.js";
import type { NodeEvent, NodeEventContext } from "./server-node-events-types.js";
import { handleNodeEvent } from "./server-node-events.js";

const { makeNodeClient, runtimeMocks } = await import("./server-node-events.test-support.js");
const enqueueSystemEventMock = runtimeMocks.enqueueSystemEvent;
const requestHeartbeatMock = runtimeMocks.requestHeartbeat;

function nodeEvent(event: string, payload: unknown): NodeEvent {
  return { event, payloadJSON: JSON.stringify(payload) };
}

function buildCtx(registry: NodeRegistry): NodeEventContext {
  return {
    deps: {} as CliDeps,
    broadcast: () => {},
    nodeSendToSession: () => {},
    nodeSubscribe: () => {},
    nodeUnsubscribe: () => {},
    broadcastVoiceWakeChanged: () => {},
    addChatRun: () => {},
    removeChatRun: () => undefined,
    chatAbortControllers: new Map(),
    dedupe: new Map(),
    agentRunSeq: new Map(),
    getHealthCache: () => null,
    refreshHealthSnapshot: async () => ({}) as HealthSummary,
    loadGatewayModelCatalog: async () => [],
    authorizeNodeSystemRunEvent: (params) =>
      registry.authorizeSystemRunEventWithState({
        ...params,
        terminal: params.event !== "exec.started",
      }) ?? false,
    logGateway: { warn: () => {} },
  };
}

const heartbeatOptions = (sessionKey: string) => ({
  source: "exec-event",
  intent: "event",
  reason: "exec-event",
  coalesceMs: 0,
  sessionKey,
});

describe("node exec recovery", () => {
  beforeEach(() => {
    enqueueSystemEventMock.mockReset().mockReturnValue(true);
    requestHeartbeatMock.mockClear();
  });

  it.each([
    { suppressNotifyOnExit: true, settle: "disconnect" },
    { suppressNotifyOnExit: false, settle: "result" },
    { suppressNotifyOnExit: false, settle: "disconnect" },
  ] as const)(
    "notifies only undelivered output (suppress=$suppressNotifyOnExit, settle=$settle)",
    async ({ suppressNotifyOnExit, settle }) => {
      const registry = new NodeRegistry();
      const connection = { connId: "conn-1" };
      const runId = `run-seq-${suppressNotifyOnExit}-${settle}`;
      const sessionKey = "agent:main:main";
      const eventRouting = { sessionKey, contextKey: `exec:${runId}` };
      const startedPayload = { runId, sessionKey, command: "printf ok" };
      const finishedPayload = {
        ...startedPayload,
        exitCode: 0,
        timedOut: false,
        output: "done",
        suppressNotifyOnExit,
      };
      const client = makeNodeClient(connection.connId, "node-1");
      const sent: string[] = [];
      Object.assign(client.socket, { send: (frame: string) => sent.push(frame) });
      registry.register(client, { pairingIdentity: "identity-a" });
      const invoke = registry.invoke({
        nodeId: "node-1",
        command: "system.run",
        params: { runId, sessionKey },
        timeoutMs: 0,
      });
      const ctx = buildCtx(registry);

      await expect(
        handleNodeEvent(ctx, "node-1", nodeEvent("exec.finished", finishedPayload), {
          connId: "wrong-conn",
        }),
      ).resolves.toEqual({
        ok: true,
        event: "exec.finished",
        handled: false,
        reason: "unmatched_exec_event",
      });
      await expect(
        handleNodeEvent(ctx, "node-1", nodeEvent("exec.started", startedPayload), connection),
      ).resolves.toBeUndefined();

      const started = [`Exec started (node=node-1 id=${runId}): printf ok`, eventRouting];
      const wake = [heartbeatOptions(sessionKey)];
      expect(enqueueSystemEventMock.mock.calls).toEqual([started]);
      expect(requestHeartbeatMock.mock.calls).toEqual([wake]);
      await expect(
        handleNodeEvent(ctx, "node-1", nodeEvent("exec.finished", finishedPayload), connection),
      ).resolves.toBeUndefined();
      await expect(
        handleNodeEvent(
          ctx,
          "node-1",
          nodeEvent("exec.finished", { ...finishedPayload, suppressNotifyOnExit: false }),
          connection,
        ),
      ).resolves.toMatchObject({ reason: "unmatched_exec_event" });
      expect(enqueueSystemEventMock.mock.calls).toEqual([started]);

      if (settle === "result") {
        const request = sent
          .map((frame) => JSON.parse(frame) as { event?: string; payload?: { id?: string } })
          .find((frame) => frame.event === "node.invoke.request");
        registry.handleInvokeResult({
          id: request?.payload?.id ?? "",
          nodeId: "node-1",
          connId: connection.connId,
          ok: true,
          payloadJSON: "{}",
        });
        await expect(invoke).resolves.toMatchObject({ ok: true });
      } else {
        registry.unregister(connection.connId);
        await expect(invoke).resolves.toMatchObject({ ok: false });
      }
      const finished = [`Exec finished (node=node-1 id=${runId}, code 0)\ndone`, eventRouting];
      const recovered = !suppressNotifyOnExit && settle === "disconnect";
      expect(enqueueSystemEventMock.mock.calls).toEqual(
        recovered ? [started, finished] : [started],
      );
      expect(requestHeartbeatMock.mock.calls).toEqual(recovered ? [wake, wake] : [wake]);
      registry.unregister(connection.connId);
    },
  );
});
