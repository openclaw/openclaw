import { expect, it, onTestFinished, vi } from "vitest";
import { GATEWAY_CLIENT_CAPS } from "../../packages/gateway-protocol/src/client-info.js";
import { clearAgentRunContext, registerAgentRunContext } from "../infra/agent-run-registry.js";
import { broadcastFor, createBroadcastPeer } from "./server-broadcast.test-support.js";
import { createSessionMessageSubscriberRegistry } from "./server-chat-state.js";
import { createAgentEventTestHarness } from "./server-chat.agent-events.test-harness.js";
// mock-isolation: Keep operator runtime config out of synthetic session routing and recovery.
vi.mock("../config/io.js", () => ({ getRuntimeConfig: vi.fn(() => ({})) }));

it.each(["fanout", "targeted", "hidden"] as const)(
  "delivers only opted-in stdout through %s without changing legacy tool events",
  (route) => {
    const key = "agent:work:global";
    const peers = ["inline", "grouped", "legacy", "other-agent", "revoked"].map((id) =>
      createBroadcastPeer(id, true),
    );
    for (const peer of peers.filter((candidate) => candidate.client.connId !== "legacy")) {
      peer.client.connect.caps = [GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS];
    }
    const subscribers = createSessionMessageSubscriberRegistry();
    for (const id of ["inline", "grouped", "revoked"]) {
      subscribers.subscribe(id, key, { includeLiveToolOutput: id !== "grouped" });
    }
    subscribers.subscribe("other-agent", "agent:main:global", { includeLiveToolOutput: true });
    const api = broadcastFor(peers, {
      sessionMessageSubscribers: subscribers,
      canReceiveSessionEvent: (client) => client.connId !== "revoked",
    });
    const send = (data: Record<string, unknown>, event = "agent") => {
      const payload = { sessionKey: "global", agentId: "work", stream: "tool", data };
      const options = { sessionKeys: [key], sessionSubscriptionVerified: route === "hidden" };
      if (route === "fanout") {
        api.broadcast(event, payload, options);
      } else {
        api.broadcastToConnIds(event, payload, new Set(peers.map((p) => p.client.connId)), options);
      }
    };
    const output = { phase: "update", outputOnly: true, partialResult: { text: "first\n" } };
    send(output);
    send({ ...output, partialResult: { text: "first\nlast\n" } }, "session.tool");
    expect(peers.map((peer) => peer.frames.length)).toEqual([2, 0, 0, 0, 0]);
    expect(peers[0]!.frames.map((frame) => frame.payload)).toMatchObject([
      { data: { partialResult: { text: "first\n" } } },
      { data: { partialResult: { text: "first\nlast\n" } } },
    ]);
    for (const phase of ["start", "input_delta", "review", "result", "update"]) {
      send({ phase, hideFromChannelProgress: true, partialResult: { text: "legacy" } });
    }
    expect(peers[1]!.frames).toHaveLength(5);
    expect(peers[0]!.frames.map((frame) => frame.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  },
);

it("unions live-output leases, rolls back failed admission and retires connection demand", () => {
  const key = "agent:main:work";
  const peer = createBroadcastPeer("shared", true);
  const subscribers = createSessionMessageSubscriberRegistry();
  subscribers.subscribe("shared", key, { subscriptionId: "grouped" });
  const { broadcast } = broadcastFor([peer], { sessionMessageSubscribers: subscribers });
  const send = () =>
    broadcast("agent", {
      sessionKey: key,
      stream: "tool",
      data: { phase: "update", outputOnly: true, partialResult: { text: "current" } },
    });
  send();
  expect(peer.frames).toHaveLength(0);
  const failed = subscribers.subscribe("shared", key, {
    subscriptionId: "inline",
    includeLiveToolOutput: true,
    provisional: true,
  })!;
  send();
  expect(peer.frames).toHaveLength(1);
  failed();
  send();
  expect(peer.frames).toHaveLength(1);
  subscribers.subscribe("shared", key, { subscriptionId: "inline", includeLiveToolOutput: true });
  subscribers.subscribe("shared", key, {
    subscriptionId: "second-inline",
    includeLiveToolOutput: true,
  });
  subscribers.unsubscribe("shared", key, "inline");
  send();
  expect(peer.frames).toHaveLength(2);
  const retiring = subscribers.subscribe("shared", key, {
    subscriptionId: "second-inline",
    includeLiveToolOutput: true,
    provisional: true,
  })!;
  subscribers.unsubscribeAll("shared");
  subscribers.subscribe("shared", key, { subscriptionId: "grouped" });
  retiring.commit();
  send();
  expect(peer.frames).toHaveLength(2);
});

it.each(
  [
    { sessionKey: "agent:main:live-output", agentId: "main", key: "agent:main:live-output" },
    { sessionKey: "global", agentId: "work", key: "agent:work:global" },
  ].flatMap(({ sessionKey, agentId, key }) =>
    ["session", "run", "hidden"].map((route) => ({ sessionKey, agentId, key, route })),
  ),
)(
  "captures unrequested stdout and admits late $route demand for $sessionKey ($agentId)",
  async ({ sessionKey, agentId, key, route }) => {
    const runId = "run-live-output";
    const snapshot = vi.fn(() => ({
      row: { key: sessionKey, kind: "direct" as const, updatedAt: 1, label: "Roster metadata" },
    }));
    const h = createAgentEventTestHarness({
      loadGatewaySessionLifecycleSnapshotForEvent: snapshot,
    });
    onTestFinished(async () => {
      await h.handler.dispose();
      h.chatRunState.clear();
      clearAgentRunContext(runId);
    });
    const peers = ["late-inline", "grouped", "other-agent"].map((id) =>
      createBroadcastPeer(id, true, { caps: [GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS] }),
    );
    const api = broadcastFor(peers, { sessionMessageSubscribers: h.sessionMessageSubscribers });
    h.broadcastToConnIds.mockImplementation(api.broadcastToConnIds);
    h.register(runId, sessionKey, "client-live-output", { agentId });
    registerAgentRunContext(runId, {
      sessionKey,
      agentId,
      verboseLevel: "off",
      isControlUiVisible: route !== "hidden",
    });
    h.nodeHasSessionSubscribers.mockReturnValue(false);
    h.toolEventRecipients.add(runId, "grouped");
    h.sessionEventSubscribers.subscribe("grouped");
    h.sessionMessageSubscribers.subscribe("grouped", key);
    h.sessionMessageSubscribers.subscribe("other-agent", "agent:other:global", {
      includeLiveToolOutput: true,
    });
    const stdout = (text: string, outputOnly = true) => ({
      phase: "update",
      ...(outputOnly ? { outputOnly: true } : {}),
      toolCallId: "command",
      name: "exec",
      partialResult: { text },
    });

    await h.emit(runId, "tool", stdout("first\n"), { seq: 1 });
    expect(h.agentRunSeq.get(runId)).toBe(1);
    if (route !== "hidden") {
      expect(h.inFlight("client-live-output").events).toMatchObject([
        { seq: 1, data: { outputOnly: true, partialResult: { text: "first\n" } } },
      ]);
    }
    expect(h.broadcastToConnIds).not.toHaveBeenCalled();
    expect(snapshot).not.toHaveBeenCalled();

    // The exact-session subscription alone admits a mid-run viewer; broad
    // session-roster interest is neither required nor sufficient for stdout.
    h.sessionMessageSubscribers.subscribe("late-inline", key, {
      includeLiveToolOutput: true,
    });
    if (route === "run") {
      h.toolEventRecipients.add(runId, "late-inline");
    }
    const event = route === "session" ? "session.tool" : "agent";
    await h.emit(runId, "tool", stdout("first\nlast\n"), { seq: 2 });
    expect(
      h.broadcastToConnIds.mock.calls.map(([emittedEvent, payload, recipients]) => [
        emittedEvent,
        payload,
        recipients,
      ]),
    ).toMatchObject([
      [
        event,
        { seq: 2, data: { partialResult: { text: "first\nlast\n" } } },
        new Set(route === "hidden" ? ["grouped", "late-inline"] : ["late-inline"]),
      ],
    ]);
    expect(h.broadcast).not.toHaveBeenCalled();
    expect(h.nodeSendToSession).not.toHaveBeenCalled();
    expect(h.agentRunSeq.get(runId)).toBe(2);
    expect(peers.map((peer) => peer.frames.length)).toEqual([1, 0, 0]);
    expect(peers[0]!.frames[0]).toMatchObject({
      event,
      payload: {
        runId: "client-live-output",
        seq: 2,
        sessionKey,
        agentId,
        data: { partialResult: { text: "first\nlast\n" } },
      },
    });
    expect(snapshot).not.toHaveBeenCalled();
    expect(peers[0]!.frames[0]?.payload).not.toHaveProperty("session");
    expect(peers[0]!.frames[0]?.payload).not.toHaveProperty("label");

    await h.emit(runId, "tool", stdout("legacy\n", false), { seq: 3 });
    expect(peers.map((peer) => peer.frames.length)).toEqual([route === "session" ? 1 : 2, 1, 0]);
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(peers[route === "session" ? 1 : 0]!.frames.at(-1)?.payload).toMatchObject({
      label: "Roster metadata",
      session: { key: sessionKey, label: "Roster metadata" },
      data: { partialResult: { text: "legacy\n" } },
    });
  },
);
