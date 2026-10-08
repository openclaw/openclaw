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
    // Input preparation predates tool output that is already visible at delivery.
    const steer = {
      role: "user",
      content: "Take over the other work too",
      timestamp: 2_000,
      __openclaw: {
        id: "steer",
        idempotencyKey: "steer-run:user",
        seq: 2,
        steerTargetRunId: "active-run",
      },
    };
    applySessionMessagePayload(state, { message: steer }, true, {
      kind: "live",
      activeRunId: "active-run",
    });
    expect(rows()).toEqual([...before, steer.content]);
    history.messages = [original, steer];
    history.inFlightRun!.text = "Already visible answer.";
    await loadChatHistory(state);
    expect(rows()).toEqual([...before, steer.content]);
    // The steer remains below all output from its target run despite clock skew.
    emitTool("read-after-steer", 2, 500);
    await vi.runOnlyPendingTimersAsync();
    handleChatGatewayEvent(state, {
      sessionKey: state.sessionKey,
      runId: "active-run",
      state: "delta",
      message: { role: "assistant", content: "Already visible answer. Continued." },
    });
    const continued = [
      "Original prompt",
      "tool",
      "tool",
      "Already visible answer. Continued.",
      steer.content,
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
        seq: 3,
        idempotencyKey: "steer-run-2:user",
      },
    };
    applySessionMessagePayload(state, { message: secondSteer }, true, {
      kind: "live",
      activeRunId: "active-run",
    });
    expect(rows()).toEqual([...continued, secondSteer.content]);
    history.messages = [original, steer, secondSteer];
    history.inFlightRun!.text = "Already visible answer. Continued.";
    await loadChatHistory(state);
    expect(rows()).toEqual([...continued, secondSteer.content]);
    handleChatGatewayEvent(state, {
      sessionKey: state.sessionKey,
      runId: "active-run",
      state: "delta",
      message: {
        role: "assistant",
        content: "Already visible answer. Continued. Finishing.",
      },
    });
    expect(rows()).toEqual([
      "Original prompt",
      "tool",
      "tool",
      "Already visible answer. Continued. Finishing.",
      steer.content,
      secondSteer.content,
    ]);
    // No assistant row has committed, so the terminal owns the complete reply.
    handleChatGatewayEvent(state, {
      sessionKey: state.sessionKey,
      runId: "active-run",
      state: "final",
      message: {
        role: "assistant",
        content: "Already visible answer. Continued. Finishing. Done.",
      },
    });
    expect(rows()).toEqual([
      "Original prompt",
      "tool",
      "tool",
      "Already visible answer. Continued. Finishing. Done.",
      steer.content,
      secondSteer.content,
    ]);
  },
);
