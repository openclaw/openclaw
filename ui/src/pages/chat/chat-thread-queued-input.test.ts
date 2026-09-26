// @vitest-environment node
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import { createRequireRecord } from "../../../../test/helpers/record.js";
import type { ChatQueueItem, MessageGroup } from "../../lib/chat/chat-types.ts";
import { buildCachedChatItems, resetChatThreadState } from "./chat-thread.ts";

type ChatItemsProps = Parameters<typeof buildCachedChatItems>[0];
const requireRecord = createRequireRecord("record", "expected-non-array-record");

afterEach(() => resetChatThreadState("queued-inputs"));

function messageGroups(overrides: Partial<ChatItemsProps>): MessageGroup[] {
  return buildCachedChatItems({
    paneId: "queued-inputs",
    sessionKey: "main",
    runId: null,
    messages: [],
    toolMessages: [],
    streamSegments: [],
    stream: null,
    streamStartedAt: null,
    showToolCalls: true,
    ...overrides,
  }).filter((item) => item.kind === "group");
}

function queuedSend(
  id: string,
  text: string,
  createdAt: number,
  sendState: ChatQueueItem["sendState"],
  overrides: Partial<ChatQueueItem> = {},
): ChatQueueItem {
  return { id, text, createdAt, sendState, ...overrides };
}

function groupAt(groups: readonly MessageGroup[], index: number): MessageGroup {
  return expectDefined(groups[index], `message group ${index}`);
}

function messageRecord(group: MessageGroup): Record<string, unknown> {
  return requireRecord(group.messages[0]?.message);
}

describe("queued transcript inputs", () => {
  it("renders submitted queued sends as user turns before chat.send ACK", () => {
    const groups = messageGroups({
      messages: [{ role: "assistant", content: "Ready.", timestamp: 1 }],
      queue: [
        queuedSend("pending-send-1", "first visible send", 2, "sending", {
          sendSubmittedAtMs: 10,
          sender: { id: "alice@example.com", name: "Alice Example" },
        }),
      ],
    });

    expect(groups.map((group) => group.role)).toEqual(["assistant", "user"]);
    expect(groupAt(groups, 1).sender).toEqual({
      id: "alice@example.com",
      name: "Alice Example",
    });
    expect(messageRecord(groupAt(groups, 1)).content).toStrictEqual([
      { type: "text", text: "first visible send" },
    ]);
  });

  it("renders reply metadata on queued user turns before chat.send ACK", () => {
    const groups = messageGroups({
      messages: [{ role: "assistant", content: "Ready.", timestamp: 1 }],
      queue: [
        queuedSend("pending-send-1", "follow up", 2, "sending", {
          replyToId: "transcript-123",
          sendSubmittedAtMs: 10,
        }),
      ],
    });

    expect(groupAt(groups, 1).messages[0]?.message).toMatchObject({
      __openclaw: { replyToId: "transcript-123" },
    });
  });

  it("keeps restored in-flight sends visible without process-local timing", () => {
    const restored = {
      id: "restored-send-1",
      text: "stay visible across reconnect",
      createdAt: 2,
      sendAttempts: 1,
    };

    expect(
      messageGroups({
        queue: [
          { ...restored, sendAttempts: 0, sendSubmittedAtMs: 10, sendState: "waiting-reconnect" },
        ],
      }),
    ).toStrictEqual([]);
    for (const sendState of ["waiting-reconnect", "sending"] as const) {
      const groups = messageGroups({ queue: [{ ...restored, sendState }] });
      expect(groups).toHaveLength(1);
      expect(messageRecord(groupAt(groups, 0)).content).toStrictEqual([
        { type: "text", text: "stay visible across reconnect" },
      ]);
    }
  });

  it("keeps steerable queued sends out of the thread until sending starts", () => {
    const queued = {
      id: "pending-send-1",
      text: "wait above the composer",
      createdAt: 2,
      sendSubmittedAtMs: 10,
    };

    expect(messageGroups({ queue: [{ ...queued, sendState: "waiting-idle" }] })).toStrictEqual([]);

    const groups = messageGroups({ queue: [{ ...queued, sendState: "sending" }] });
    expect(groups).toHaveLength(1);
    expect(messageRecord(groupAt(groups, 0)).content).toStrictEqual([
      { type: "text", text: "wait above the composer" },
    ]);
  });

  it("renders submitted queued attachment sends with attachment blocks before chat.send ACK", () => {
    const groups = messageGroups({
      queue: [
        queuedSend("pending-attachment-send-1", "see attached", 2, "sending", {
          sendSubmittedAtMs: 10,
          attachments: [
            {
              id: "attachment-1",
              mimeType: "image/png",
              fileName: "screenshot.png",
              previewUrl: "/media/screenshot.png",
            },
          ],
        }),
      ],
    });

    expect(groups).toHaveLength(1);
    expect(messageRecord(groupAt(groups, 0)).content).toStrictEqual([
      { type: "text", text: "see attached" },
      {
        type: "image",
        url: "/media/screenshot.png",
        fileName: "screenshot.png",
        source: { type: "url", url: "/media/screenshot.png" },
      },
    ]);
  });
});
