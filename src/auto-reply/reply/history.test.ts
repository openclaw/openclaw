// Tests reply history loading, trimming, and rendering for prompt context.
import { describe, expect, it } from "vitest";
import { normalizeHistoryMediaEntries, recordPendingHistoryEntryWithMedia } from "./history.js";
import type { HistoryEntry } from "./history.types.js";

describe("history media recording", () => {
  it("keeps only bounded local image media", () => {
    expect(
      normalizeHistoryMediaEntries({
        limit: 2,
        messageId: "msg-1",
        media: [
          { path: "/tmp/a.png", contentType: "image/png" },
          { path: "https://example.com/b.png", contentType: "image/png" },
          { path: "/tmp/c.pdf", contentType: "application/pdf", kind: "document" },
          { path: "C:\\tmp\\d.jpg", kind: "image" },
          { path: "/tmp/e.jpg", kind: "image" },
        ],
      }),
    ).toEqual([
      { path: "/tmp/a.png", contentType: "image/png", kind: "image", messageId: "msg-1" },
      { path: "C:\\tmp\\d.jpg", kind: "image", messageId: "msg-1" },
    ]);
  });

  it("records an extensionless sticker without transport MIME at the channel history boundary", async () => {
    const historyMap = new Map<string, HistoryEntry[]>();

    await recordPendingHistoryEntryWithMedia({
      historyMap,
      historyKey: "telegram-chat",
      limit: 5,
      entry: {
        sender: "Alice",
        body: "<media:image>",
        messageId: "telegram-message",
      },
      media: async () => [
        {
          path: "/tmp/telegram-sticker",
          kind: "sticker",
        },
      ],
    });

    expect(historyMap.get("telegram-chat")).toEqual([
      {
        sender: "Alice",
        body: "<media:image>",
        messageId: "telegram-message",
        media: [
          {
            path: "/tmp/telegram-sticker",
            contentType: undefined,
            kind: "sticker",
            messageId: "telegram-message",
          },
        ],
      },
    ]);
  });

  it("preserves explicitly identified SVG history media", () => {
    const media = { path: "/tmp/diagram.svg", contentType: "image/svg+xml" };
    expect(normalizeHistoryMediaEntries({ media: [media] })).toEqual([
      {
        ...media,
        kind: "image",
        messageId: undefined,
      },
    ]);
  });

  it("records text history before async media resolution finishes", async () => {
    const historyMap = new Map<string, HistoryEntry[]>();
    let resolveMedia!: (media: HistoryEntry["media"]) => void;
    const mediaPromise = new Promise<HistoryEntry["media"]>((resolve) => {
      resolveMedia = resolve;
    });

    const pending = recordPendingHistoryEntryWithMedia({
      historyMap,
      historyKey: "channel-1",
      limit: 5,
      entry: { sender: "Alice", body: "<media:image>", messageId: "msg-1" },
      media: async () => await mediaPromise,
    });

    expect(historyMap.get("channel-1")).toEqual([
      { sender: "Alice", body: "<media:image>", messageId: "msg-1" },
    ]);

    resolveMedia([{ path: "/tmp/a.png", contentType: "image/png" }]);
    await pending;

    expect(historyMap.get("channel-1")).toEqual([
      {
        sender: "Alice",
        body: "<media:image>",
        messageId: "msg-1",
        media: [
          { path: "/tmp/a.png", contentType: "image/png", kind: "image", messageId: "msg-1" },
        ],
      },
    ]);
  });
});
