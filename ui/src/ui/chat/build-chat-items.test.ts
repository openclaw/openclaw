import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageGroup } from "../types/chat-types.ts";
import {
  buildChatItems,
  resetChatItemFallbackTimestampsForTests,
  type BuildChatItemsProps,
} from "./build-chat-items.ts";

function createProps(overrides: Partial<BuildChatItemsProps> = {}): BuildChatItemsProps {
  return {
    sessionKey: "main",
    messages: [],
    toolMessages: [],
    streamSegments: [],
    stream: null,
    streamStartedAt: null,
    showToolCalls: true,
    ...overrides,
  };
}

function messageGroups(props: Partial<BuildChatItemsProps>): MessageGroup[] {
  return buildChatItems(createProps(props)).filter((item) => item.kind === "group");
}

function firstMessageContent(group: MessageGroup): unknown[] {
  const message = group.messages[0]?.message as { content?: unknown };
  return Array.isArray(message.content) ? message.content : [];
}

describe("buildChatItems", () => {
  beforeEach(() => {
    resetChatItemFallbackTimestampsForTests();
  });

  it("uses stable fallback timestamps for history messages that do not carry one", () => {
    vi.useFakeTimers();
    try {
      const fallbackTimestamp = Date.UTC(2026, 3, 29, 12, 0);
      vi.setSystemTime(fallbackTimestamp);
      const first = messageGroups({
        messages: [
          {
            role: "assistant",
            content: "No persisted timestamp.",
          },
        ],
      });

      vi.setSystemTime(new Date("2026-04-29T12:05:00Z"));
      const second = messageGroups({
        messages: [
          {
            role: "assistant",
            content: "No persisted timestamp.",
          },
        ],
      });

      expect(first[0]?.timestamp).toBe(fallbackTimestamp);
      expect(second[0]?.timestamp).toBe(fallbackTimestamp);
      expect(first[0]?.key).toBe(second[0]?.key);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps compaction divider keys stable when the divider has no timestamp", () => {
    vi.useFakeTimers();
    try {
      const messages = [
        {
          role: "system",
          content: "Compacted",
          __openclaw: { kind: "compaction" },
        },
      ];
      const fallbackTimestamp = Date.UTC(2026, 3, 29, 12, 0);
      vi.setSystemTime(fallbackTimestamp);
      const first = buildChatItems(createProps({ messages }));

      vi.setSystemTime(new Date("2026-04-29T12:05:00Z"));
      const second = buildChatItems(createProps({ messages }));

      expect(first[0]).toMatchObject({ kind: "divider", key: "divider:compaction:unknown:0" });
      expect(second[0]).toMatchObject({ kind: "divider", key: "divider:compaction:unknown:0" });
      expect(first[0]).toMatchObject({ kind: "divider", timestamp: fallbackTimestamp });
      expect(second[0]).toMatchObject({ kind: "divider", timestamp: fallbackTimestamp });
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses transcript metadata before fallback timestamps for stable keys", () => {
    const first = buildChatItems(
      createProps({
        messages: [
          {
            role: "assistant",
            content: "Loaded without a persisted timestamp.",
            timestamp: 1_000,
            __openclaw: { seq: 7 },
          },
          {
            role: "system",
            content: "Compacted",
            timestamp: 1_000,
            __openclaw: { kind: "compaction", seq: 8 },
          },
        ],
      }),
    );
    const second = buildChatItems(
      createProps({
        messages: [
          {
            role: "assistant",
            content: "Loaded without a persisted timestamp.",
            timestamp: 2_000,
            __openclaw: { seq: 7 },
          },
          {
            role: "system",
            content: "Compacted",
            timestamp: 2_000,
            __openclaw: { kind: "compaction", seq: 8 },
          },
        ],
      }),
    );

    expect(first[0]).toMatchObject({ kind: "group", key: "group:assistant:msg:transcript:seq:7" });
    expect(second[0]).toMatchObject({
      kind: "group",
      key: "group:assistant:msg:transcript:seq:7",
    });
    expect(first[1]).toMatchObject({ kind: "divider", key: "divider:compaction:seq:8" });
    expect(second[1]).toMatchObject({ kind: "divider", key: "divider:compaction:seq:8" });
  });

  it("renders only the live stream suffix after committed stream segments", () => {
    const items = buildChatItems(
      createProps({
        streamSegments: [{ text: "Before tool. ", ts: 100 }],
        stream: "Before tool. After tool.",
        streamStartedAt: 200,
      }),
    );

    const streams = items.filter((item) => item.kind === "stream");
    expect(streams).toEqual([
      {
        kind: "stream",
        key: "stream-seg:main:0",
        text: "Before tool. ",
        startedAt: 100,
      },
      {
        kind: "stream",
        key: "stream:main:200",
        text: "After tool.",
        startedAt: 200,
      },
    ]);
  });

  it("keeps consecutive user messages from different senders in separate groups", () => {
    const groups = messageGroups({
      messages: [
        {
          role: "user",
          content: "first",
          senderLabel: "Iris",
          timestamp: 1000,
        },
        {
          role: "user",
          content: "second",
          senderLabel: "Joaquin De Rojas",
          timestamp: 1001,
        },
      ],
    });

    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.senderLabel)).toEqual(["Iris", "Joaquin De Rojas"]);
  });

  it("keeps consecutive user messages from distinct sends in separate groups", () => {
    const firstTimestamp = Date.UTC(2026, 3, 29, 23, 42);
    const secondTimestamp = Date.UTC(2026, 3, 29, 23, 44);
    const groups = messageGroups({
      messages: [
        {
          role: "user",
          content: "okay, check if ai-pulse health is fine",
          timestamp: firstTimestamp,
          __openclaw: { id: "user-1142", seq: 413 },
        },
        {
          role: "user",
          content: "okay, check if ai-pulse health is fine",
          timestamp: secondTimestamp,
          __openclaw: { id: "user-1144", seq: 415 },
        },
      ],
    });

    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.messages)).toEqual([
      [{ message: expect.any(Object), key: "msg:transcript:id:user-1142" }],
      [{ message: expect.any(Object), key: "msg:transcript:id:user-1144" }],
    ]);
    expect(groups.map((group) => group.timestamp)).toEqual([firstTimestamp, secondTimestamp]);
  });

  it("groups multi-part user messages when they share a same-turn marker", () => {
    const groups = messageGroups({
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "text part" }],
          timestamp: 1000,
          __openclaw_local: {
            localId: "local:run-user:user-text",
            runId: "run-user",
            kind: "user",
          },
        },
        {
          role: "user",
          content: [{ type: "image", source: { type: "url", url: "/image.png" } }],
          timestamp: 1000,
          __openclaw_local: {
            localId: "local:run-user:user-image",
            runId: "run-user",
            kind: "user",
          },
        },
      ],
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.messages).toHaveLength(2);
  });

  it("attaches lifted canvas previews to the nearest assistant turn", () => {
    const groups = messageGroups({
      messages: [
        {
          id: "assistant-with-canvas",
          role: "assistant",
          content: [{ type: "text", text: "First reply." }],
          timestamp: 1_000,
        },
        {
          id: "assistant-without-canvas",
          role: "assistant",
          content: [{ type: "text", text: "Later unrelated reply." }],
          timestamp: 2_000,
        },
      ],
      toolMessages: [
        {
          id: "tool-canvas-for-first-reply",
          role: "tool",
          toolCallId: "call-canvas-old",
          toolName: "canvas_render",
          content: JSON.stringify({
            kind: "canvas",
            view: {
              backend: "canvas",
              id: "cv_nearest_turn",
              url: "/__openclaw__/canvas/documents/cv_nearest_turn/index.html",
              title: "Nearest turn demo",
              preferred_height: 320,
            },
            presentation: {
              target: "assistant_message",
            },
          }),
          timestamp: 1_001,
        },
      ],
    });

    expect(firstMessageContent(groups[0]).some((block) => isCanvasBlock(block))).toBe(true);
    expect(firstMessageContent(groups[1]).some((block) => isCanvasBlock(block))).toBe(false);
  });

  it("does not lift generic view handles from non-canvas payloads", () => {
    const groups = messageGroups({
      messages: [
        {
          id: "assistant-generic-inline",
          role: "assistant",
          content: [{ type: "text", text: "Rendered the item inline." }],
          timestamp: 1000,
        },
      ],
      toolMessages: [
        {
          id: "tool-generic-inline",
          role: "tool",
          toolCallId: "call-generic-inline",
          toolName: "plugin_card_details",
          content: JSON.stringify({
            selected_item: {
              summary: {
                label: "Alpha",
                meaning: "Generic example",
              },
              view: {
                backend: "canvas",
                id: "cv_generic_inline",
                url: "/__openclaw__/canvas/documents/cv_generic_inline/index.html",
                title: "Inline generic preview",
                preferred_height: 420,
              },
            },
          }),
          timestamp: 1001,
        },
      ],
    });

    expect(firstMessageContent(groups[0]).some((block) => isCanvasBlock(block))).toBe(false);
  });

  it("lifts streamed canvas toolresult blocks into the assistant bubble", () => {
    const groups = messageGroups({
      messages: [
        {
          id: "assistant-streamed-artifact",
          role: "assistant",
          content: [{ type: "text", text: "Done." }],
          timestamp: 1000,
        },
      ],
      toolMessages: [
        {
          id: "tool-streamed-artifact",
          role: "assistant",
          toolCallId: "call_streamed_artifact",
          timestamp: 999,
          content: [
            {
              type: "toolcall",
              name: "canvas_render",
              arguments: { source: { type: "handle", id: "cv_streamed_artifact" } },
            },
            {
              type: "toolresult",
              name: "canvas_render",
              text: JSON.stringify({
                kind: "canvas",
                view: {
                  backend: "canvas",
                  id: "cv_streamed_artifact",
                  url: "/__openclaw__/canvas/documents/cv_streamed_artifact/index.html",
                  title: "Streamed demo",
                  preferred_height: 320,
                },
                presentation: {
                  target: "assistant_message",
                },
              }),
            },
          ],
        },
      ],
    });

    const canvasBlocks = firstMessageContent(groups[0]).filter((block) => isCanvasBlock(block));
    expect(canvasBlocks).toHaveLength(1);
    expect(canvasBlocks[0]).toMatchObject({
      preview: {
        viewId: "cv_streamed_artifact",
        title: "Streamed demo",
      },
    });
  });
});

function isCanvasBlock(block: unknown): boolean {
  return (
    Boolean(block) &&
    typeof block === "object" &&
    (block as { type?: unknown; preview?: { kind?: unknown } }).type === "canvas" &&
    (block as { preview?: { kind?: unknown } }).preview?.kind === "canvas"
  );
}
