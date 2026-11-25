import { afterEach, expect, it, vi } from "vitest";
import { createSubscribedSessionHarness } from "../agents/embedded-agent-subscribe.e2e-harness.js";
import { makeAgentAssistantMessage } from "../agents/test-helpers/agent-message-fixtures.js";
import {
  bindAgentAssistantSource,
  emitAgentEventForOwner,
  readAgentAssistantSource,
  resetAgentEventsForTest,
} from "../infra/agent-events.js";
import {
  claimAgentRunContext,
  registerAgentRunContext,
  releaseAgentRunContext,
} from "../infra/agent-run-registry.js";
import { createChatAbortMarker } from "./server-chat-state.js";
import { createAgentEventTestHarness } from "./server-chat.agent-events.test-harness.js";
import { subscribeAgentEvents } from "./server-chat.agent-events.test-helpers.js";
import { projectSessionMessagePayload } from "./session-transcript-message.js";

afterEach(() => {
  resetAgentEventsForTest();
  vi.useRealTimers();
});

it.each([
  "direct",
  "registry alias",
  "stale registry alias",
  "aborted registry alias",
  "hidden worker",
])(
  "publishes exclusive-claim receipts without borrowing a successor's authority (%s)",
  async (route) => {
    vi.useFakeTimers();
    const runId = "worker-reasoning";
    const sessionKey = "agent:main:worker-reasoning";
    const sessionId = "worker-reasoning-session";
    const gateway = createAgentEventTestHarness();
    gateway.register(
      runId,
      sessionKey,
      route === "direct" || route === "hidden worker" ? runId : "client-alias",
    );
    if (route === "hidden worker") {
      gateway.sessionMessageSubscribers.subscribe("selected-viewer", sessionKey);
    }
    if (route === "stale registry alias") {
      gateway.chatRunState.getOrCreate("client-alias").bufferIsCurrent = () => false;
    } else if (route === "aborted registry alias") {
      gateway.chatRunState.getOrCreate("client-alias").abortMarker = createChatAbortMarker(
        Date.now(),
      );
    }
    const unlisten = subscribeAgentEvents(gateway.handler);
    const claim = () => {
      const id = claimAgentRunContext(
        runId,
        { sessionKey, sessionId, agentId: "main", isControlUiVisible: route !== "hidden worker" },
        { exclusive: true, trackOwner: true },
      );
      if (!id) {
        throw new Error("The worker must own an exclusive event claim");
      }
      return id;
    };
    const thinking = (claimId: string, itemId: string) =>
      emitAgentEventForOwner(
        { runId, stream: "thinking", data: { itemId, text: "Checking", delta: "Checking" } },
        claimId,
      );
    const commit = (
      itemId: string,
      messageSeq: number,
      target?: { sessionKey?: string; sessionId?: string },
    ) =>
      gateway.handler.retireTranscript({
        sessionKey,
        sessionId,
        ...target,
        messageId: `${itemId}-message`,
        messageSeq,
        assistantItemIds: [itemId],
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "Checking" }],
          __openclaw: { runId },
        },
      });
    const receipts = () =>
      [...gateway.agent(), ...gateway.targetedAgent()].flatMap(([, event]) =>
        event.stream === "thinking" && event.data.phase === "persisted" ? [event.data] : [],
      );
    try {
      const firstClaim = claim();
      thinking(firstClaim, "first");
      await unlisten.drain();
      commit("first", 2);
      await unlisten.drain();
      expect(receipts()).toEqual([
        { phase: "persisted", itemId: "first", messageId: "first-message", messageRunId: runId },
      ]);
      commit("first", 2, { sessionKey: "agent:main:unrelated" });
      commit("first", 2, { sessionId: "replaced-session" });
      await unlisten.drain();
      expect(receipts()).toHaveLength(1);
      thinking(firstClaim, "revoked-old");
      thinking(firstClaim, "replaced-old");
      await unlisten.drain();
      releaseAgentRunContext(runId, firstClaim);
      commit("revoked-old", 3);
      await unlisten.drain();
      expect(receipts()).toHaveLength(1);

      const secondClaim = claim();
      commit("replaced-old", 4);
      await unlisten.drain();
      expect(receipts()).toHaveLength(1);
      thinking(secondClaim, "second");
      await unlisten.drain();
      commit("second", 5);
      await unlisten.drain();
      expect(receipts()).toEqual([
        { phase: "persisted", itemId: "first", messageId: "first-message", messageRunId: runId },
        { phase: "persisted", itemId: "second", messageId: "second-message", messageRunId: runId },
      ]);
      gateway.chatRunState.clearRun(runId);
      commit("second", 5);
      await unlisten.drain();
      expect(receipts()).toHaveLength(2);
      releaseAgentRunContext(runId, secondClaim);
    } finally {
      await unlisten();
      await gateway.handler.dispose();
      gateway.chatRunState.clear();
    }
  },
);

it("hands paced native reasoning to stable durable identity despite rewritten positions", async () => {
  vi.useFakeTimers();
  const runId = "native-reasoning";
  const clientRunId = "client-reasoning";
  const sessionKey = "agent:main:reasoning";
  const sessionId = "reasoning-session";
  const messageId = "reasoning-row";
  registerAgentRunContext(runId, { sessionKey, sessionId, agentId: "main" });
  const gateway = createAgentEventTestHarness();
  gateway.register(runId, sessionKey, clientRunId);
  const unlisten = subscribeAgentEvents(gateway.handler);
  const { emit, subscription } = createSubscribedSessionHarness({ runId, sessionKey });
  const thoughts = () =>
    gateway
      .agent()
      .map(([, event]) => event)
      .filter((event) => event.stream === "thinking");
  const update = (text: string, delta: string, start = false) => {
    const message = makeAgentAssistantMessage({ content: [{ type: "thinking", thinking: text }] });
    if (start) {
      emit({ type: "message_start", message });
    }
    emit({
      type: "message_update",
      message,
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta, partial: message },
    });
    return message;
  };
  try {
    update("Checking", "Checking", true);
    const first = update("Checking facts", " facts");
    await unlisten.drain();
    expect(thoughts()).toHaveLength(1);
    const source = readAgentAssistantSource(first);
    expect(source?.itemId).toEqual(expect.any(String));
    if (!source) {
      throw new Error("Native thinking must retain its assistant occurrence");
    }
    first.content.push({ type: "text", text: "The first answer is ready." });
    emit({ type: "message_end", message: first });
    await subscription.waitForPendingEvents();
    const committed = { ...first, __openclaw: { runId } };
    source.committedMessageSeq = 18;
    bindAgentAssistantSource(committed, source);
    gateway.handler.retireTranscript({
      sessionKey,
      sessionId,
      message: committed,
      messageId,
      messageSeq: 18,
    });
    await unlisten.drain();
    expect(thoughts().map((event) => ({ runId: event.runId, data: event.data }))).toEqual([
      { runId: clientRunId, data: { text: "Checking", delta: "Checking", itemId: source.itemId } },
      {
        runId: clientRunId,
        data: { text: "Checking facts", delta: " facts", itemId: source.itemId },
      },
      {
        runId: clientRunId,
        data: {
          phase: "persisted",
          itemId: source.itemId,
          messageId,
          messageRunId: runId,
        },
      },
    ]);
    // Live ownership is remapped; durable identity survives rewritten display positions.
    const durable = projectSessionMessagePayload({
      sessionKey,
      message: committed,
      messageSeq: 7,
      messageId,
      runId,
      projectCurrentUserProfile: (message) => message,
    }).payload;
    expect(durable).toMatchObject({
      runId,
      message: { __openclaw: { id: messageId, runId, seq: 7 } },
    });
    vi.advanceTimersByTime(100);
    expect(thoughts()).toHaveLength(3);

    const second = update("Checking facts", "Checking facts", true);
    await unlisten.drain();
    const nextSource = readAgentAssistantSource(second);
    expect(nextSource?.itemId).toEqual(expect.any(String));
    expect(nextSource?.itemId).not.toBe(source.itemId);
    gateway.chatRunState.flushPendingText(clientRunId);
    expect(thoughts().at(-1)?.data).toEqual({
      text: "Checking facts",
      delta: "Checking facts",
      itemId: nextSource?.itemId,
    });
  } finally {
    subscription.unsubscribe();
    await subscription.waitForPendingEvents();
    await unlisten();
    await gateway.handler.dispose();
    gateway.chatRunState.clear();
  }
});
