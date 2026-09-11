// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  appendChatCanvasBlocksToMessage,
  augmentChatHistoryWithCanvasBlocks,
  extractChatToolResultCanvasPreview,
} from "../../../../src/gateway/chat-display-projection.canvas.js";
import type { ChatStreamSegment } from "../../lib/chat/chat-types.ts";
import { normalizeMessage } from "../../lib/chat/message-normalizer.ts";
import { buildCachedChatItems } from "./chat-thread.ts";
import { materializeVisibleStreamState } from "./stream-reconciliation.ts";

const runId = "run-interleaved-widgets";
const expectedOrder = ["Step one", "Widget one", "Step two", "Widget two"];

function widgetResult(index: number) {
  return {
    role: "toolResult",
    runId,
    toolCallId: `call-widget-${index}`,
    toolName: "show_widget",
    timestamp: index * 2_000,
    content: [
      {
        type: "text",
        text: JSON.stringify({
          kind: "canvas",
          view: {
            backend: "canvas",
            id: `cv_interleaved_${index}`,
            url: `/__openclaw__/canvas/documents/cv_interleaved_${index}/index.html`,
            title: index === 1 ? "Widget one" : "Widget two",
            preferred_height: 160,
          },
          presentation: { target: "assistant_message" },
        }),
      },
    ],
  };
}

function visibleOrder(props: Partial<Parameters<typeof buildCachedChatItems>[0]>) {
  return buildCachedChatItems({
    paneId: "interleaved-widgets",
    sessionKey: "main",
    runId,
    messages: [],
    toolMessages: [],
    streamSegments: [],
    stream: null,
    streamStartedAt: null,
    showToolCalls: false,
    ...props,
  }).flatMap((item) => {
    if (item.kind === "stream") {
      return [item.text];
    }
    if (item.kind !== "group" || item.role !== "assistant") {
      return [];
    }
    return item.messages.flatMap(({ message }) =>
      normalizeMessage(message).content.flatMap((block) =>
        block.type === "canvas" ? [block.preview.title] : block.type === "text" ? [block.text] : [],
      ),
    );
  });
}

describe("interleaved widget transcript order", () => {
  it.each(["streaming", "history", "overlap"] as const)(
    "renders a repeated widget once within its turn at %s",
    (stage) => {
      const user = { role: "user", content: "Show a visual step", timestamp: 500 };
      const progress = { role: "assistant", content: "Step one", timestamp: 1_000 };
      const result = widgetResult(1);
      const replay = { ...result, toolCallId: "call-widget-replay", timestamp: 3_000 };
      expect(
        visibleOrder({
          messages:
            stage === "overlap"
              ? [user, progress, result]
              : stage === "history"
                ? augmentChatHistoryWithCanvasBlocks([user, progress, result, replay])
                : [user, progress],
          toolMessages:
            stage === "history" ? [] : stage === "overlap" ? [replay] : [result, replay],
        }),
      ).toEqual(["Step one", "Widget one"]);
    },
  );

  it("does not deduplicate the same widget across user turns", () => {
    const result = widgetResult(1);
    expect(
      visibleOrder({
        messages: [
          { role: "user", content: "Show the widget", timestamp: 500 },
          result,
          { role: "user", content: "Show it again", timestamp: 3_000 },
          { ...result, toolCallId: "call-later-turn", timestamp: 4_000 },
        ],
      }),
    ).toEqual(["Widget one", "Widget one"]);
  });

  it.each([
    { provenance: { kind: "inter_session", sourceTool: "sessions_send" } },
    { __openclaw: { id: "projected-turn", turnBoundary: true } },
  ])("keeps a repeated widget after assistant-side turn boundary %j", (metadata) => {
    const result = widgetResult(1);
    expect(
      visibleOrder({
        messages: [
          { role: "user", content: "Show the widget", timestamp: 500 },
          result,
          { role: "assistant", content: "Another turn", timestamp: 3_000, ...metadata },
          { ...result, toolCallId: "call-forwarded-turn", timestamp: 4_000 },
        ],
      }),
    ).toEqual(["Widget one", "Another turn", "Widget one"]);
  });

  it("allows adjacent widgets to share a message group", () => {
    const items = buildCachedChatItems({
      paneId: "adjacent-widgets",
      sessionKey: "main",
      messages: [],
      toolMessages: [widgetResult(1), widgetResult(2)],
      streamSegments: [],
      stream: null,
      streamStartedAt: null,
      showToolCalls: false,
    });
    const assistants = items.filter((item) => item.kind === "group" && item.role === "assistant");
    expect(assistants).toHaveLength(1);
    expect(visibleOrder({ toolMessages: [widgetResult(1), widgetResult(2)] })).toEqual([
      "Widget one",
      "Widget two",
    ]);
  });

  it.each(["streaming", "terminal", "terminal-with-widgets", "history"] as const)(
    "keeps each widget between its surrounding progress messages at %s",
    (stage) => {
      const user = { role: "user", content: "Show two visual steps", timestamp: 500 };
      const results = [widgetResult(1), widgetResult(2)];
      const streamSegments: ChatStreamSegment[] = [
        { text: "Step one", ts: 1_000, itemId: "progress-one", runId },
        { text: "Step two", ts: 3_000, itemId: "progress-two", runId },
      ];
      const terminalMessages = materializeVisibleStreamState(
        [user],
        {
          chatMessages: [user],
          chatRunId: runId,
          chatStream: null,
          chatStreamStartedAt: null,
          chatStreamSegments: streamSegments,
        },
        {
          persistCommentary: true,
          isHiddenAssistantMessage: () => false,
          isHiddenStreamText: () => false,
        },
      );
      const savedProgress = streamSegments.map((segment) => ({
        role: "assistant",
        content: [{ type: "text", text: segment.text }],
        timestamp: segment.ts,
        phase: "commentary",
      }));
      const history = augmentChatHistoryWithCanvasBlocks([
        user,
        savedProgress[0],
        results[0],
        savedProgress[1],
        results[1],
      ]);
      if (stage === "terminal-with-widgets") {
        terminalMessages.push(
          appendChatCanvasBlocksToMessage(
            { role: "assistant", content: [], timestamp: 5_000 },
            results.flatMap((result) => extractChatToolResultCanvasPreview(result) ?? []),
          ),
        );
      }

      expect(
        visibleOrder({
          messages:
            stage === "streaming"
              ? [user]
              : stage.startsWith("terminal")
                ? terminalMessages
                : history,
          toolMessages: stage === "history" ? [] : results,
          streamSegments: stage === "streaming" ? streamSegments : [],
          runWorking: stage === "streaming",
        }),
      ).toEqual(expectedOrder);
    },
  );
});
