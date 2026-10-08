import { Value } from "typebox/value";
import { expect, it, vi } from "vitest";
import { ChatEventSchema } from "../../packages/gateway-protocol/src/schema/logs-chat.js";
import { extractText } from "../../ui/src/lib/chat/message-extract.ts";
import { handleChatGatewayEvent } from "../../ui/src/pages/chat/chat-gateway.ts";
import {
  activeHistory,
  createState,
  type TestState,
} from "../../ui/src/pages/chat/chat-history.inflight.test-support.ts";
import { loadChatHistory } from "../../ui/src/pages/chat/chat-history.ts";
import { buildChatItems } from "../../ui/src/pages/chat/chat-thread-build.ts";
import { applySessionMessagePayload } from "../../ui/src/pages/chat/session-message-apply.ts";
import { handleAgentEvent } from "../../ui/src/pages/chat/tool-stream.ts";
import { createSubscribedSessionHarness } from "../agents/embedded-agent-subscribe.e2e-harness.js";
import {
  emitAgentEvent,
  emitAgentEventForOwner,
  type AgentEventPayload,
} from "../infra/agent-events.js";
import {
  claimAgentRunContext,
  getAgentRunContext,
  releaseAgentRunContext,
  registerAgentRunContext,
} from "../infra/agent-run-registry.js";
import { projectInFlightRunSnapshot } from "./chat-inflight-snapshot.js";
import {
  createAgentEventTestHarness,
  widgetResult,
} from "./server-chat.agent-events.test-harness.js";
import { subscribeAgentEvents } from "./server-chat.agent-events.test-helpers.js";

function renderedItems(state: TestState) {
  return buildChatItems({
    paneId: "commentary-history",
    sessionKey: state.sessionKey,
    runId: state.chatRunId,
    messages: state.chatMessages,
    toolMessages: state.chatToolMessages,
    streamSegments: state.chatStreamSegments,
    stream: state.chatStream,
    streamStartedAt: state.chatStreamStartedAt,
    showToolCalls: true,
  });
}

function renderedText(state: TestState) {
  return renderedItems(state)
    .flatMap((item) =>
      item.kind === "group" && item.role !== "tool"
        ? item.messages.flatMap(({ message }) => extractText(message) || [])
        : item.kind === "stream"
          ? [item.text]
          : [],
    )
    .join("\n");
}

function renderedOrder(state: TestState) {
  return [...renderedText(state).matchAll(/Step (\d+):/gu)].map((match) => Number(match[1]));
}

it("restores only the unowned tail with bounded commentary replay and continues live deltas", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(new Date("2026-05-09T00:00:00.000Z"));
  vi.stubGlobal("window", globalThis);
  const startedAtMs = Date.now();
  const runId = "run-commentary-history";
  const gateway = createAgentEventTestHarness();
  gateway.register(runId, "main", runId);
  const history = activeHistory(runId);
  const live = createState(history);
  live.chatRunId = runId;
  const clients = [live];
  gateway.broadcast.mockImplementation((event: string, payload: unknown) => {
    if (event === "chat" && Value.Check(ChatEventSchema, payload)) {
      for (const client of clients) {
        handleChatGatewayEvent(client, payload);
      }
    }
  });
  const unsubscribe = subscribeAgentEvents(async (event) => {
    if (event.runId !== runId) {
      return;
    }
    await gateway.handler(event);
    for (const client of clients) {
      handleAgentEvent(client, { ...event, sessionKey: "main" });
    }
  });
  const deliver = (stream: AgentEventPayload["stream"], data: AgentEventPayload["data"]) =>
    emitAgentEvent({ runId, sessionKey: "main", stream, data });
  const { emit, subscription } = createSubscribedSessionHarness({ runId });
  const tool = (toolCallId: string, completed: boolean) => {
    deliver("tool", { phase: "start", toolCallId, name: "exec", args: {} });
    if (completed) {
      deliver("tool", { phase: "result", toolCallId, name: "exec", result: "done" });
    }
    deliver("item", {
      kind: "tool",
      itemId: `tool:${toolCallId}`,
      toolCallId,
      name: "exec",
      title: "Execute",
      phase: completed ? "end" : "start",
      status: completed ? "completed" : "running",
    });
  };
  // Keep the reported 22-paragraph, 3658-character source shape synthetic.
  const paragraphs = Array.from(
    { length: 22 },
    (_, index) =>
      `Step ${index + 1}: I will inspect the workspace.${index % 2 ? " " : "\n"}The configuration and tool results need another check before continuing. I will compare each tool output to the saved result.${index === 0 ? " Then I can move." : ""}`,
  );
  const textMessage = (text: string) => ({
    role: "assistant",
    api: "openai-completions",
    content: [{ type: "text", text }],
  });
  const updateText = (text: string, delta: string) => {
    emit({
      type: "message_update",
      message: textMessage(text),
      assistantMessageEvent: { type: "text_delta", delta },
    });
  };
  try {
    for (const [index, text] of paragraphs.entries()) {
      vi.advanceTimersByTime(250);
      emit({ type: "message_start", message: textMessage("") });
      updateText(text, text);
      await subscription.waitForPendingEvents();
      await unsubscribe.drain();
      const itemId = `commentary-0-step-${index}`;
      const commentary = {
        ...textMessage(text),
        stopReason: "toolUse",
        content: [
          {
            type: "text",
            text,
            textSignature: JSON.stringify({ v: 1, id: itemId, phase: "commentary" }),
          },
          { type: "toolCall", id: "exec_0", name: "exec", arguments: {} },
        ],
      };
      emit({
        type: "message_update",
        message: commentary,
        assistantMessageEvent: { type: "toolcall_start", contentIndex: 1, partial: commentary },
      });
      emit({ type: "message_end", message: commentary });
      await subscription.waitForPendingEvents();
      await unsubscribe.drain();
      expect
        .soft(renderedOrder(live))
        .toEqual(Array.from({ length: index + 1 }, (_, step) => step + 1));
      tool("exec_0", true);
      if (index === 20) {
        tool("tool_call:exec_0:exec:old", true);
      }
      if (index >= 18) {
        history.messages!.push(
          {
            role: "assistant",
            content: [{ type: "text", text }],
            timestamp: Date.now(),
            __openclaw: { id: `step-${index}`, seq: index * 10 + 2, runId },
            openclawStreamFallback: { source: "segment", itemId, replacementText: text },
          },
          {
            role: "assistant",
            content: [commentary.content[1]],
            timestamp: Date.now(),
            __openclaw: { id: `step-${index}`, seq: index * 10 + 2, runId },
          },
          ...Array.from({ length: 8 }, (_, nested) => ({
            role: "toolResult",
            toolCallId: nested ? `tool_call:exec_0:exec:${index * 8 + nested}` : "exec_0",
            content: [{ type: "text", text: `result-${index}-${nested}` }],
            timestamp: Date.now(),
            __openclaw: { id: `result-${index}-${nested}`, seq: index * 10 + 3 + nested, runId },
          })),
        );
      }
    }
    for (let index = 0; index < 15; index++) {
      tool(`tool_call:exec_0:exec:${index}`, true);
    }
    tool("exec_0", false);
    deliver("usage", { outputTokens: 1000 });
    await unsubscribe.drain();
    history.hasMore = true;
    history.nextOffset = 40;
    history.totalMessages = 220;
    history.inFlightRun = projectInFlightRunSnapshot({
      chatRunState: gateway.chatRunState,
      runId,
      startedAtMs,
    });
    expect(history.messages).toHaveLength(40);
    expect(history.inFlightRun.events).toHaveLength(49);
    expect(
      history.inFlightRun.events?.filter((event) => event.data.kind === "preamble"),
    ).toMatchObject([{ data: { itemId: "commentary-0-step-21", phase: "end" } }]);
    await loadChatHistory(live);
    expect(live.chatRunId).toBe(runId);
    expect(renderedOrder(live)).toEqual(Array.from({ length: 22 }, (_, index) => index + 1));
    const normalized = renderedText(live).replace(/\s+/gu, " ");
    expect(
      paragraphs.map((text) => normalized.split(text.replace(/\s+/gu, " ")).length - 1),
    ).toEqual(paragraphs.map(() => 1));

    const pending = "Step 23: Still investigating.";
    vi.advanceTimersByTime(250);
    emit({ type: "message_start", message: textMessage("") });
    updateText(pending, pending);
    await subscription.waitForPendingEvents();
    await unsubscribe.drain();
    history.inFlightRun = projectInFlightRunSnapshot({
      chatRunState: gateway.chatRunState,
      runId,
      startedAtMs,
    });
    const restored = createState(history);
    clients.push(restored);
    await loadChatHistory(restored);
    expect(renderedOrder(restored)).toEqual([19, 20, 21, 22, 23]);
    expect(restored.chatStream).toBe(pending);

    vi.advanceTimersByTime(250);
    updateText(`${pending} Continuing after switch-back.`, " Continuing after switch-back.");
    await subscription.waitForPendingEvents();
    await unsubscribe.drain();
    vi.advanceTimersByTime(250);
    expect(renderedOrder(live)).toEqual(Array.from({ length: 23 }, (_, index) => index + 1));
    expect(renderedOrder(restored)).toEqual([19, 20, 21, 22, 23]);
    expect(restored.chatStream).toBe(`${pending} Continuing after switch-back.`);
    expect(restored.chatRunId).toBe(runId);
  } finally {
    subscription.unsubscribe();
    await unsubscribe();
    await gateway.handler.dispose();
    gateway.chatRunState.clear();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});

it.each([
  {
    name: "without steer",
    reload: false,
    tail: "Live B.",
    persistTail: false,
    canvas: false,
    includeSteer: false,
  },
  {
    name: "saved after steer",
    reload: false,
    tail: "Live B.",
    persistTail: false,
    canvas: false,
    steerFirst: true,
  },
  { name: "live", reload: false, tail: "Live B.", persistTail: false, canvas: false },
  { name: "restored", reload: true, tail: "Live B.", persistTail: false, canvas: false },
  {
    name: "identical later occurrence",
    reload: false,
    tail: "Saved A.",
    persistTail: false,
    canvas: false,
  },
  { name: "literal terminal tail", reload: false, tail: "[", persistTail: false, canvas: false },
  { name: "fully committed", reload: false, tail: "Live B.", persistTail: true, canvas: false },
  {
    name: "canvas-only display tail",
    reload: false,
    tail: "Live B.",
    persistTail: true,
    canvas: true,
  },
])(
  "displays each occurrence once when a run finishes ($name)",
  async ({ reload, tail, persistTail, canvas, includeSteer = true, steerFirst = false }) => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(new Date("2026-05-09T00:00:00.000Z"));
    vi.stubGlobal("window", globalThis);
    const runId = "steered-final";
    const gateway = createAgentEventTestHarness();
    gateway.register(runId, "main", runId);
    const history = activeHistory(runId);
    const original = {
      role: "user",
      content: "Original prompt",
      timestamp: Date.now(),
      __openclaw: { id: "prompt", seq: 1, idempotencyKey: `${runId}:user` },
    };
    const saved = {
      role: "assistant",
      content: [{ type: "text", text: "Saved A." }],
      timestamp: Date.now() + (steerFirst ? 2 : 1),
      __openclaw: { id: "saved-a", seq: steerFirst ? 3 : 2, runId, idempotencyKey: "item-a" },
    };
    const steer = {
      role: "user",
      content: "Steer prompt",
      timestamp: Date.now() + (steerFirst ? 1 : 2),
      __openclaw: {
        id: "steer",
        seq: steerFirst ? 2 : 3,
        idempotencyKey: "steer:user",
        steerTargetRunId: runId,
      },
    };
    history.messages = [original];
    const state = createState(history);
    gateway.broadcast.mockImplementation((event: string, payload: unknown) => {
      if (event === "chat" && Value.Check(ChatEventSchema, payload)) {
        handleChatGatewayEvent(state, payload);
      }
    });
    const applySteer = () =>
      applySessionMessagePayload(state, { message: steer, clientRunId: runId }, true, {
        kind: "live",
        activeRunId: runId,
      });
    try {
      await loadChatHistory(state);
      if (includeSteer && steerFirst) {
        applySteer();
      }
      await gateway.emit(runId, "assistant", { itemId: "item-a", text: "Saved A." });
      gateway.chatRunState.flushPendingText(runId);
      const savedPublication = gateway.handler.retireTranscript({
        sessionKey: "main",
        message: { ...saved, idempotencyKey: "item-a" },
      });
      expect(gateway.chatRunState.resolveBuffer(runId).text).toBe("");
      applySessionMessagePayload(state, { message: saved, runId }, true, {
        kind: "live",
        activeRunId: runId,
      });
      savedPublication?.published();
      if (includeSteer && !steerFirst) {
        applySteer();
      }
      await gateway.emit(runId, "assistant", { itemId: "item-b", text: tail }, { seq: 2 });
      gateway.chatRunState.flushPendingText(runId);
      if (reload) {
        history.messages = [
          original,
          ...(includeSteer && steerFirst ? [steer] : []),
          saved,
          ...(includeSteer && !steerFirst ? [steer] : []),
        ];
        history.inFlightRun = projectInFlightRunSnapshot({
          chatRunState: gateway.chatRunState,
          runId,
        });
        await loadChatHistory(state);
      }
      expect(renderedText(state)).toBe(
        [
          "Original prompt",
          "Saved A.",
          ...(tail === "[" ? [] : [tail]),
          ...(includeSteer ? ["Steer prompt"] : []),
        ].join("\n"),
      );
      if (persistTail) {
        const savedTail = {
          role: "assistant",
          content: [{ type: "text", text: tail }],
          timestamp: Date.now() + 3,
          __openclaw: { id: "saved-b", seq: 4, runId, idempotencyKey: "item-b" },
        };
        const tailPublication = gateway.handler.retireTranscript({
          sessionKey: "main",
          message: { ...savedTail, idempotencyKey: "item-b" },
        });
        applySessionMessagePayload(state, { message: savedTail, runId }, true, {
          kind: "live",
          activeRunId: runId,
        });
        tailPublication?.published();
      }
      if (canvas) {
        gateway.toolEventRecipients.add(runId, "control-ui");
        await gateway.emit(
          runId,
          "tool",
          {
            phase: "result",
            toolCallId: "widget",
            name: "show_widget",
            result: widgetResult("final-widget"),
          },
          { seq: 3 },
        );
        handleAgentEvent(state, gateway.targetedAgent().at(-1)?.[1]);
      }
      await gateway.end(runId, 4);
      // Delivery consumers still receive the complete terminal result.
      expect(gateway.chat().at(-1)?.[1]).toMatchObject({
        state: "final",
        message: {
          content: expect.arrayContaining([{ type: "text", text: `Saved A.\n\n${tail}` }]),
        },
      });
      expect(renderedText(state)).toBe(
        ["Original prompt", "Saved A.", tail, ...(includeSteer ? ["Steer prompt"] : [])].join("\n"),
      );
      if (canvas) {
        const widget = expect.objectContaining({
          type: "canvas",
          preview: expect.objectContaining({ title: "final-widget" }),
        });
        expect(gateway.chat().at(-1)?.[1]).toMatchObject({
          message: {
            content: expect.arrayContaining([widget]),
            openclawDisplayContent: expect.arrayContaining([widget]),
          },
        });
        expect(
          renderedItems(state).flatMap((item) =>
            item.kind === "group" ? item.messages.map(({ message }) => message) : [],
          ),
        ).toContainEqual(
          expect.objectContaining({
            content: expect.arrayContaining([
              expect.objectContaining({
                type: "canvas",
                preview: expect.objectContaining({ title: "final-widget" }),
              }),
            ]),
          }),
        );
      }
      expect(state.chatRunId).toBeNull();
    } finally {
      await gateway.handler.dispose();
      gateway.chatRunState.clear();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  },
);

it.each([
  "published",
  "published-context-late-receipt",
  "failed",
  "reset",
  "successor",
  "successor-start",
  "successor-start-remapped",
  "successor-context",
  "successor-context-start",
  "successor-context-retained",
  "successor-context-terminal",
  "successor-context-hidden-terminal",
  "successor-context-hidden",
  "successor-early-receipt",
] as const)("keeps terminal delivery behind transcript publication (%s)", async (outcome) => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.stubGlobal("window", globalThis);
  const runId = "publication-handoff";
  const sourceRunId = outcome === "successor-start-remapped" ? "source-publication" : runId;
  const gateway = createAgentEventTestHarness();
  const contextOwned = outcome.includes("context");
  const retainedContext = outcome === "successor-context-retained";
  const keeperClaim = retainedContext
    ? claimAgentRunContext(sourceRunId, { sessionKey: "main" }, { trackOwner: true })
    : undefined;
  const claim = () => {
    const owner = claimAgentRunContext(
      sourceRunId,
      { sessionKey: "main" },
      { exclusive: !retainedContext, trackOwner: true },
    );
    expect(owner).toBeDefined();
    return owner;
  };
  let contextClaim = contextOwned ? claim() : undefined;
  const originalContext = getAgentRunContext(sourceRunId);
  const stop = subscribeAgentEvents(gateway.handler);
  const emit = async (
    stream: AgentEventPayload["stream"],
    data: AgentEventPayload["data"],
    seq: number,
  ) => {
    if (contextClaim) {
      if (retainedContext) {
        emitAgentEvent({ runId: sourceRunId, stream, data });
      } else {
        emitAgentEventForOwner({ runId: sourceRunId, stream, data }, contextClaim);
      }
      await stop.drain();
    } else {
      await gateway.emit(sourceRunId, stream, data, { seq });
    }
  };
  if (!contextOwned) {
    gateway.register(sourceRunId, "main", runId);
  }
  const history = activeHistory(runId);
  history.messages = [{ role: "user", content: "Original prompt", timestamp: Date.now() }];
  const state = createState(history);
  gateway.broadcast.mockImplementation((event: string, payload: unknown) => {
    if (event === "chat" && Value.Check(ChatEventSchema, payload)) {
      handleChatGatewayEvent(state, payload);
    }
  });
  const saved = {
    role: "assistant",
    content: [{ type: "text", text: "Saved A." }],
    timestamp: Date.now() + 1,
    __openclaw: { id: "saved-a", seq: 2, runId: sourceRunId, idempotencyKey: "item-a" },
  };
  const count = (text: string) => renderedText(state).split(text).length - 1;
  try {
    await loadChatHistory(state);
    await emit("assistant", { itemId: "item-a", text: "Saved A." }, 1);
    gateway.chatRunState.flushPendingText(runId);
    const published = gateway.handler.retireTranscript({
      sessionKey: "main",
      message: { ...saved, idempotencyKey: "item-a" },
    });
    expect(gateway.chatRunState.resolveBuffer(runId).text).toBe("");
    expect(count("Saved A.")).toBe(1);
    await emit("assistant", { itemId: "item-b", text: "Live B." }, 2);
    if (outcome === "successor-context-hidden-terminal") {
      gateway.chatRunState.flushPendingText(runId);
      registerAgentRunContext(sourceRunId, { isControlUiVisible: false }, contextClaim);
    }
    await emit("lifecycle", { phase: "end" }, 3);
    const lateSaved = {
      ...saved,
      idempotencyKey: "item-b",
      content: [{ type: "text", text: "Live B." }],
      __openclaw: { runId: sourceRunId, id: "saved-b", seq: 3, idempotencyKey: "item-b" },
    };
    const latePublication =
      outcome === "published-context-late-receipt"
        ? gateway.handler.retireTranscript({ sessionKey: "main", message: lateSaved })
        : undefined;
    if (outcome === "published-context-late-receipt") {
      expect(latePublication).toBeDefined();
    }
    expect(count("Saved A.")).toBe(1);
    expect(count("Live B.")).toBe(1);
    const successorSaved = {
      ...saved,
      idempotencyKey: "new",
      content: [{ type: "text", text: "New run." }],
      __openclaw: { runId: sourceRunId, id: "saved-new", seq: 4, idempotencyKey: "new" },
    };
    let successorPublication: ReturnType<typeof gateway.handler.retireTranscript>;
    if (outcome === "reset") {
      gateway.chatRunState.clearRun(runId);
    } else if (outcome.startsWith("successor")) {
      if (contextOwned) {
        releaseAgentRunContext(sourceRunId, contextClaim);
        contextClaim = claim();
        if (outcome === "successor-context-hidden") {
          registerAgentRunContext(sourceRunId, { isControlUiVisible: false }, contextClaim);
        }
        if (retainedContext) {
          expect(getAgentRunContext(sourceRunId)).toBe(originalContext);
        }
      } else {
        gateway.register(sourceRunId, "main", runId);
      }
      if (outcome !== "successor-context") {
        await emit("lifecycle", { phase: "start" }, 4);
      }
      if (outcome === "successor-context-hidden") {
        await emit("lifecycle", { phase: "end" }, 6);
        releaseAgentRunContext(sourceRunId, contextClaim);
        contextClaim = undefined;
      }
      if (outcome === "successor-early-receipt") {
        successorPublication = gateway.handler.retireTranscript({
          sessionKey: "main",
          message: successorSaved,
        });
        expect(successorPublication).toBeDefined();
        applySessionMessagePayload(state, { message: successorSaved, runId }, true, {
          kind: "live",
          activeRunId: runId,
        });
        successorPublication?.published();
        await emit("assistant", { itemId: "new", text: "New run." }, 5);
        gateway.chatRunState.flushPendingText(runId);
        expect(gateway.deltas().join("")).not.toContain("New run.");
      }
      if (outcome === "successor" || outcome.endsWith("terminal")) {
        await emit("assistant", { itemId: "new", text: "New run." }, 5);
        gateway.chatRunState.flushPendingText(runId);
        if (outcome === "successor-context-hidden-terminal") {
          successorPublication = gateway.handler.retireTranscript({
            sessionKey: "main",
            message: successorSaved,
          });
          expect(successorPublication).toBeDefined();
        }
        if (outcome.endsWith("terminal")) {
          await emit("lifecycle", { phase: "end" }, 6);
        }
        if (outcome === "successor-context-hidden-terminal") {
          expect(gateway.chat().filter(([, payload]) => payload.state === "final")).toHaveLength(0);
        }
      }
    }
    if (outcome.startsWith("published") || outcome.startsWith("successor")) {
      applySessionMessagePayload(state, { message: saved, runId }, true, {
        kind: "live",
        activeRunId: runId,
      });
      published?.published();
    }
    published?.settled();
    if (latePublication) {
      applySessionMessagePayload(state, { message: lateSaved, runId }, true, {
        kind: "live",
        activeRunId: runId,
      });
      latePublication.published();
    }
    if (outcome === "successor-context-hidden-terminal") {
      expect(gateway.chat().filter(([, payload]) => payload.state === "final")).toHaveLength(0);
      applySessionMessagePayload(state, { message: successorSaved, runId }, true, {
        kind: "live",
        activeRunId: runId,
      });
      successorPublication?.published();
    }
    if (outcome === "reset" || outcome.startsWith("successor")) {
      const finals = gateway.chat().filter(([, payload]) => payload.state === "final");
      expect(finals).toHaveLength(outcome.endsWith("terminal") ? 1 : 0);
      if (outcome.endsWith("terminal")) {
        expect(finals[0]?.[1].message).toMatchObject({
          content: [{ type: "text", text: "New run." }],
        });
      }
      if (outcome === "successor") {
        expect(count("New run.")).toBe(1);
      }
    } else {
      expect(gateway.chat().filter(([, payload]) => payload.state === "final")).toHaveLength(1);
      expect(count("Saved A.")).toBe(1);
      expect(count("Live B.")).toBe(1);
    }
  } finally {
    await stop();
    releaseAgentRunContext(sourceRunId, contextClaim);
    releaseAgentRunContext(sourceRunId, keeperClaim);
    await gateway.handler.dispose();
    gateway.chatRunState.clear();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
