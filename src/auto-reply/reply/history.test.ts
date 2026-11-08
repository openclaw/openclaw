import { describe, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { normalizeHistoryMediaEntries, recordPendingHistoryEntryWithMedia } from "./history.js";
import type { HistoryEntry } from "./history.types.js";

const entry = { sender: "Alice", body: "<media:image>", messageId: "msg-1" };
function record(media: Parameters<typeof recordPendingHistoryEntryWithMedia>[0]["media"]) {
  const historyMap = new Map<string, HistoryEntry[]>();
  const pending = recordPendingHistoryEntryWithMedia({
    historyMap,
    historyKey: "channel-1",
    limit: 5,
    entry: { ...entry },
    media,
  });
  return { historyMap, pending };
}

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
    const sticker = { path: "/tmp/telegram-sticker", kind: "sticker" as const };
    const expectedSticker = { ...sticker, contentType: undefined, messageId: "msg-1" };
    const { historyMap, pending } = record(async () => [sticker]);
    await pending;
    expect(historyMap.get("channel-1")).toEqual([
      {
        ...entry,
        media: [expectedSticker],
      },
    ]);
  });

  it("preserves explicitly identified SVG history media", () => {
    const media = { path: "/tmp/diagram.svg", contentType: "image/svg+xml" };
    expect(normalizeHistoryMediaEntries({ media: [media] })).toEqual([
      { ...media, kind: "image", messageId: undefined },
    ]);
  });

  it("records text history before async media resolution finishes", async () => {
    const media = createDeferred<HistoryEntry["media"]>();
    const { historyMap, pending } = record(async () => await media.promise);
    expect(historyMap.get("channel-1")).toEqual([entry]);

    media.resolve([{ path: "/tmp/a.png", contentType: "image/png" }]);
    await pending;

    expect(historyMap.get("channel-1")).toEqual([
      {
        ...entry,
        media: [
          { path: "/tmp/a.png", contentType: "image/png", kind: "image", messageId: "msg-1" },
        ],
      },
    ]);
  });
});
