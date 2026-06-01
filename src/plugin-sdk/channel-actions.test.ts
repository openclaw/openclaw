import { describe, expect, it } from "vitest";
import { createChannelPagedActionResult } from "./channel-actions.js";

describe("channel action result helpers", () => {
  it("adds a stable pagination contract without dropping channel-specific fields", () => {
    const result = createChannelPagedActionResult({
      itemsKey: "threads",
      items: [{ id: "thread-1" }],
      source: "test.threadList.archived",
      hasMore: true,
      nextCursor: " 2026-05-25T17:00:00.000Z ",
      nextCursorKey: "nextBefore",
      query: {
        channelId: "C1",
        includeArchived: true,
        limit: 1,
      },
      extra: {
        members: [],
      },
    });

    expect(result).toEqual({
      ok: true,
      threads: [{ id: "thread-1" }],
      members: [],
      complete: false,
      hasMore: true,
      returnedCount: 1,
      source: "test.threadList.archived",
      query: {
        channelId: "C1",
        includeArchived: true,
        limit: 1,
      },
      nextCursor: "2026-05-25T17:00:00.000Z",
      nextBefore: "2026-05-25T17:00:00.000Z",
    });
  });

  it("marks final pages complete and omits cursors", () => {
    const result = createChannelPagedActionResult({
      itemsKey: "messages",
      items: [],
      source: "test.read",
    });

    expect(result).toEqual({
      ok: true,
      messages: [],
      complete: true,
      hasMore: false,
      returnedCount: 0,
      source: "test.read",
    });
  });
});
