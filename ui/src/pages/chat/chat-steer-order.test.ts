// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { extractText } from "../../lib/chat/message-extract.ts";
import { chatItemGroups } from "./chat-agent-run-grouping.ts";
import { handleChatGatewayEvent } from "./chat-gateway.ts";
import { activeHistory, createState } from "./chat-history.inflight.test-support.ts";
import { loadChatHistory } from "./chat-history.ts";
import { buildChatItems } from "./chat-thread-build.ts";
import { projectTranscriptChain } from "./components/chat-transcript-message-index.ts";
import { applySessionMessagePayload } from "./session-message-apply.ts";
import { handleAgentEvent } from "./tool-stream.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each(["tool", "item"] as const)(
  "keeps tool activity ordered across steers and history (%s)",
  async (source) => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    vi.stubGlobal("window", globalThis);
    const history = activeHistory("active-run");
    const original = {
      role: "user",
      content: "Original prompt",
      timestamp: 1,
      __openclaw: { id: "original", idempotencyKey: "active-run:user", seq: 1 },
    };
    history.messages = [original];
    const state = createState(history);
    await loadChatHistory(state);
    const emitTool = (toolCallId: string, seq: number, ts: number, completed = false) =>
      handleAgentEvent(state, {
        sessionKey: state.sessionKey,
        runId: "active-run",
        seq,
        ts,
        stream: source,
        data:
          source === "tool"
            ? {
                phase: completed ? "result" : "start",
                toolCallId,
                name: "read",
                args: { path: "README.md" },
              }
            : {
                kind: "tool",
                itemId: toolCallId,
                toolCallId,
                name: "read",
                title: "Read",
                phase: completed ? "end" : "start",
              },
      });
    emitTool("read-before-steer", 1, 5_000);
    await vi.runOnlyPendingTimersAsync();
    vi.setSystemTime(1_000);
    handleChatGatewayEvent(state, {
      sessionKey: state.sessionKey,
      runId: "active-run",
      state: "delta",
      message: { role: "assistant", content: "Already visible answer." },
    });
    const rows = () =>
      projectTranscriptChain(
        buildChatItems({
          paneId: "steer-order",
          sessionKey: state.sessionKey,
          runId: state.chatRunId,
          messages: state.chatMessages,
          toolMessages: state.chatToolMessages,
          streamSegments: state.chatStreamSegments,
          stream: state.chatStream,
          streamStartedAt: state.chatStreamStartedAt,
          showToolCalls: true,
        }),
        { sessionKey: state.sessionKey, runWorking: state.chatRunId !== null, searchActive: false },
      ).transcriptItems.flatMap((item) =>
        item.kind === "stream-run"
          ? item.parts.flatMap((part) => (part.kind === "stream" ? [part.text] : []))
          : item.kind === "agent-run-frame"
            ? item.parts.flatMap((part) =>
                part.kind === "stream-run"
                  ? part.parts.flatMap((stream) => (stream.kind === "stream" ? [stream.text] : []))
                  : chatItemGroups(part).flatMap((group) =>
                      group.messages.map(({ message }) =>
                        group.role === "tool" ? "tool" : (extractText(message) ?? group.role),
                      ),
                    ),
              )
            : chatItemGroups(item).flatMap((group) =>
                group.messages.map(({ message }) =>
                  group.role === "tool" ? "tool" : (extractText(message) ?? group.role),
                ),
              ),
      );
    const before = rows();
    expect(before).toEqual(["Original prompt", "tool", "Already visible answer."]);
    // Durable sequence, not skewed event time, anchors output on either side of acceptance.
    const persistTool = (toolCallId: string, seq: number, timestamp: number) => {
      const message = {
        role: "assistant",
        timestamp,
        content: [
          { type: "toolcall", id: toolCallId, name: "read", arguments: { path: "README.md" } },
        ],
        __openclaw: { id: toolCallId, seq, runId: "active-run" },
      };
      applySessionMessagePayload(state, { runId: "active-run", message }, true, {
        kind: "history-delta",
      });
      return message;
    };
    const beforeTool = persistTool("read-before-steer", 2, 5_000);
    const savedAnswer = {
      role: "assistant",
      content: "Already visible answer.",
      timestamp: 1_000,
      __openclaw: { id: "saved-answer", seq: 3, runId: "active-run" },
    };
    handleChatGatewayEvent(state, {
      sessionKey: state.sessionKey,
      runId: "active-run",
      state: "delta",
      replace: true,
      message: { role: "assistant", content: "" },
    });
    applySessionMessagePayload(state, { runId: "active-run", message: savedAnswer }, true, {
      kind: "live",
      activeRunId: "active-run",
    });
    expect(rows()).toEqual(before);
    const steer = {
      role: "user",
      content: "Take over the other work too",
      timestamp: 2_000,
      __openclaw: {
        id: "steer",
        idempotencyKey: "steer-run:user",
        seq: 4,
        steerTargetRunId: "active-run",
      },
    };
    applySessionMessagePayload(state, { message: steer }, true, {
      kind: "live",
      activeRunId: "active-run",
    });
    expect(rows()).toEqual([...before, steer.content]);
    history.messages = [original, beforeTool, savedAnswer, steer];
    history.inFlightRun!.text = "";
    await loadChatHistory(state);
    expect(rows()).toEqual([...before, steer.content]);
    // First-observed live activity stays after acceptance despite its earlier timestamp.
    emitTool("read-after-steer", 2, 500);
    await vi.runOnlyPendingTimersAsync();
    expect(rows()).toEqual([...before, steer.content, "tool"]);
    const afterTool = persistTool("read-after-steer", 5, 500);
    handleChatGatewayEvent(state, {
      sessionKey: state.sessionKey,
      runId: "active-run",
      state: "delta",
      message: { role: "assistant", content: "Continued." },
    });
    const continued = [
      "Original prompt",
      "tool",
      "Already visible answer.",
      steer.content,
      "tool",
      "Continued.",
    ];
    expect(rows()).toEqual(continued);
    // Completion updates the original card in place.
    emitTool("read-before-steer", 3, 30_000, true);
    await vi.runOnlyPendingTimersAsync();
    expect(rows()).toEqual(continued);
    const secondSteer = {
      ...steer,
      content: "Also inspect the second file",
      timestamp: 300,
      __openclaw: {
        ...steer["__openclaw"],
        id: "steer-2",
        seq: 6,
        idempotencyKey: "steer-run-2:user",
      },
    };
    applySessionMessagePayload(state, { message: secondSteer }, true, {
      kind: "live",
      activeRunId: "active-run",
    });
    const accepted = [...continued.slice(0, -1), secondSteer.content, "Continued."];
    expect(rows()).toEqual(accepted);
    history.messages = [original, beforeTool, savedAnswer, steer, afterTool, secondSteer];
    history.inFlightRun!.text = "Continued.";
    await loadChatHistory(state);
    expect(rows()).toEqual(accepted);
    handleChatGatewayEvent(state, {
      sessionKey: state.sessionKey,
      runId: "active-run",
      state: "delta",
      message: {
        role: "assistant",
        content: "Continued. Finishing.",
      },
    });
    expect(rows()).toEqual([
      "Original prompt",
      "tool",
      "Already visible answer.",
      steer.content,
      "tool",
      secondSteer.content,
      "Continued. Finishing.",
    ]);
    // The terminal owns the complete unsaved tail, without splitting it at a steer.
    handleChatGatewayEvent(state, {
      sessionKey: state.sessionKey,
      runId: "active-run",
      state: "final",
      message: {
        role: "assistant",
        content: "Continued. Finishing. Done.",
      },
    });
    expect(rows()).toEqual([
      "Original prompt",
      "tool",
      "Already visible answer.",
      steer.content,
      "tool",
      secondSteer.content,
      "Continued. Finishing. Done.",
    ]);
  },
);
