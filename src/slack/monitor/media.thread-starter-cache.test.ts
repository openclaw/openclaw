import { afterEach, describe, expect, it, vi } from "vitest";
import { resetSlackThreadStarterCacheForTest, resolveSlackThreadStarter } from "./media.js";

describe("resolveSlackThreadStarter cache", () => {
  afterEach(() => {
    resetSlackThreadStarterCacheForTest();
    vi.useRealTimers();
  });

  it("returns cached thread starter without refetching within ttl", async () => {
    const replies = vi.fn(async () => ({
      messages: [{ text: "root message", user: "U1", ts: "1000.1" }],
    }));
    const client = {
      conversations: { replies },
    } as unknown as Parameters<typeof resolveSlackThreadStarter>[0]["client"];

    const first = await resolveSlackThreadStarter({
      channelId: "C1",
      threadTs: "1000.1",
      client,
    });
    const second = await resolveSlackThreadStarter({
      channelId: "C1",
      threadTs: "1000.1",
      client,
    });

    expect(first).toEqual(second);
    expect(replies).toHaveBeenCalledTimes(1);
  });

  it("expires stale cache entries and refetches after ttl", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));

    const replies = vi.fn(async () => ({
      messages: [{ text: "root message", user: "U1", ts: "1000.1" }],
    }));
    const client = {
      conversations: { replies },
    } as unknown as Parameters<typeof resolveSlackThreadStarter>[0]["client"];

    await resolveSlackThreadStarter({
      channelId: "C1",
      threadTs: "1000.1",
      client,
    });

    vi.setSystemTime(new Date("2026-01-01T07:00:00.000Z"));
    await resolveSlackThreadStarter({
      channelId: "C1",
      threadTs: "1000.1",
      client,
    });

    expect(replies).toHaveBeenCalledTimes(2);
  });

  it("evicts oldest entries once cache exceeds bounded size", async () => {
    const replies = vi.fn(async () => ({
      messages: [{ text: "root message", user: "U1", ts: "1000.1" }],
    }));
    const client = {
      conversations: { replies },
    } as unknown as Parameters<typeof resolveSlackThreadStarter>[0]["client"];

    // Cache cap is 2000; add enough distinct keys to force eviction of earliest keys.
    for (let i = 0; i <= 2000; i += 1) {
      await resolveSlackThreadStarter({
        channelId: "C1",
        threadTs: `1000.${i}`,
        client,
      });
    }
    const callsAfterFill = replies.mock.calls.length;

    // Oldest key should be evicted and require fetch again.
    await resolveSlackThreadStarter({
      channelId: "C1",
      threadTs: "1000.0",
      client,
    });

    expect(replies.mock.calls.length).toBe(callsAfterFill + 1);
  });
});
