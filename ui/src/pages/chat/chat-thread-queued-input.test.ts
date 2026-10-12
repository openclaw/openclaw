// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { createRequireRecord } from "../../../../test/helpers/record.js";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { createProps } from "./chat-thread.test-support.ts";
import { buildCachedChatItems, resetChatThreadState } from "./chat-thread.ts";

const requireRecord = createRequireRecord("record", "expected-non-array-record");
afterEach(() => resetChatThreadState("queued-inputs"));

function messageGroups(queue: ChatQueueItem[], messages: unknown[] = []) {
  return buildCachedChatItems(createProps({ paneId: "queued-inputs", queue, messages })).filter(
    (item) => item.kind === "group",
  );
}

describe("queued transcript inputs", () => {
  it("renders the submitted sender, reply and attachment before chat.send ACK", () => {
    const sender = { id: "alice@example.com", name: "Alice Example" };
    const groups = messageGroups(
      [
        {
          id: "pending-send",
          text: "see attached",
          createdAt: 2,
          sendState: "sending",
          sendSubmittedAtMs: 10,
          sender,
          replyToId: "transcript-123",
          attachments: [
            {
              id: "attachment-1",
              mimeType: "image/png",
              fileName: "screenshot.png",
              previewUrl: "/media/screenshot.png",
            },
          ],
        },
      ],
      [{ role: "assistant", content: "Ready.", timestamp: 1 }],
    );
    expect(groups.map((group) => group.role)).toEqual(["assistant", "user"]);
    expect(groups[1]?.sender).toEqual(sender);
    const message = requireRecord(groups[1]?.messages[0]?.message);
    expect(message).toMatchObject({ __openclaw: { replyToId: "transcript-123" } });
    expect(message.content).toStrictEqual([
      { type: "text", text: "see attached" },
      {
        type: "image",
        url: "/media/screenshot.png",
        fileName: "screenshot.png",
        source: { type: "url", url: "/media/screenshot.png" },
      },
    ]);
  });

  it.each(["waiting-reconnect", "waiting-idle"] as const)(
    "shows a %s send only after delivery starts, including restored attempts",
    (sendState) => {
      const queued = { id: "send", text: "stay visible", createdAt: 2 };
      expect(
        messageGroups([{ ...queued, sendState, sendAttempts: 0, sendSubmittedAtMs: 10 }]),
      ).toStrictEqual([]);
      const attempts: ChatQueueItem[] =
        sendState === "waiting-reconnect"
          ? [
              { ...queued, sendState, sendAttempts: 1 },
              { ...queued, sendState: "sending", sendAttempts: 1 },
            ]
          : [{ ...queued, sendState: "sending", sendSubmittedAtMs: 10 }];
      for (const attempt of attempts) {
        const groups = messageGroups([attempt]);
        expect(groups).toHaveLength(1);
        expect(requireRecord(groups[0]?.messages[0]?.message).content).toStrictEqual([
          { type: "text", text: "stay visible" },
        ]);
      }
    },
  );
});
