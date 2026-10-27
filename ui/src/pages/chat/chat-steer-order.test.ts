// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { extractText } from "../../lib/chat/message-extract.ts";
import { chatItemGroups } from "./chat-agent-run-grouping.ts";
import { handleChatGatewayEvent } from "./chat-gateway.ts";
import {
  activeHistory,
  buildStateItems,
  createState,
  steerPrompts,
} from "./chat-history.inflight.test-support.ts";
import { loadChatHistory } from "./chat-history.ts";
import { nativeMessage } from "./chat-thread-fixtures.test-support.ts";
import { projectTranscriptChain } from "./components/chat-transcript-message-index.ts";
import { applySessionMessagePayload } from "./session-message-apply.ts";
import { handleAgentEvent } from "./tool-stream.ts";

afterEach(() => vi.useRealTimers());

it.each(["tool", "item"] as const)(
  "keeps tool activity ordered across steers and history (%s)",
  async (source) => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const history = activeHistory("active-run");
    const { original, steer } = steerPrompts(4, 2_000);
    history.messages = [original];
    const state = createState(history);
    await loadChatHistory(state);
    const emitReply = (content: string, terminal = false, replace = false) =>
      handleChatGatewayEvent(state, {
        sessionKey: state.sessionKey,
        runId: "active-run",
        state: terminal ? "final" : "delta",
        ...(replace ? { replace } : {}),
        message: { role: "assistant", content },
      });
    const accept = (payload: unknown) =>
      applySessionMessagePayload(state, payload, true, {
        kind: "live",
        activeRunId: "active-run",
      });
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
    emitReply("Already visible answer.");
    const rows = () =>
      projectTranscriptChain(buildStateItems(state, "steer-order"), {
        sessionKey: state.sessionKey,
        runWorking: state.chatRunId !== null,
        searchActive: false,
      })
        .transcriptItems.flatMap((item) => (item.kind === "agent-run-frame" ? item.parts : [item]))
        .flatMap((item) =>
          item.kind === "stream-run"
            ? item.parts.flatMap((part) => (part.kind === "stream" ? [part.text] : []))
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
      const message = nativeMessage(
        "assistant",
        [{ type: "toolcall", id: toolCallId, name: "read", arguments: { path: "README.md" } }],
        timestamp,
        { id: toolCallId, seq, runId: "active-run" },
      );
      applySessionMessagePayload(state, { runId: "active-run", message }, true, {
        kind: "history-delta",
      });
      return message;
    };
    const beforeTool = persistTool("read-before-steer", 2, 5_000);
    const savedAnswer = nativeMessage("assistant", "Already visible answer.", 1_000, {
      id: "saved-answer",
      seq: 3,
      runId: "active-run",
    });
    emitReply("", false, true);
    accept({ runId: "active-run", message: savedAnswer });
    expect(rows()).toEqual(before);
    accept({ message: steer });
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
    emitReply("Continued.");
    const continued = [...before, steer.content, "tool", "Continued."];
    expect(rows()).toEqual(continued);
    // Completion updates the original card in place.
    emitTool("read-before-steer", 3, 30_000, true);
    await vi.runOnlyPendingTimersAsync();
    expect(rows()).toEqual(continued);
    const secondSteer = nativeMessage("user", "Also inspect the second file", 300, {
      ...steer["__openclaw"],
      id: "steer-2",
      seq: 6,
      idempotencyKey: "steer-run-2:user",
    });
    accept({ message: secondSteer });
    const accepted = [...continued.slice(0, -1), secondSteer.content, "Continued."];
    expect(rows()).toEqual(accepted);
    history.messages = [original, beforeTool, savedAnswer, steer, afterTool, secondSteer];
    history.inFlightRun!.text = "Continued.";
    await loadChatHistory(state);
    expect(rows()).toEqual(accepted);
    emitReply("Continued. Finishing.");
    expect(rows()).toEqual([...accepted.slice(0, -1), "Continued. Finishing."]);
    // The terminal owns the complete unsaved tail, without splitting it at a steer.
    emitReply("Continued. Finishing. Done.", true);
    expect(rows()).toEqual([...accepted.slice(0, -1), "Continued. Finishing. Done."]);
  },
);
