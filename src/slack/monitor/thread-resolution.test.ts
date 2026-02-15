import { describe, expect, it, vi } from "vitest";
import type { SlackMessageEvent } from "../types.js";
import { createSlackThreadTsResolver } from "./thread-resolution.js";

describe("createSlackThreadTsResolver", () => {
  it("caches resolved thread_ts lookups", async () => {
    const historyMock = vi.fn().mockResolvedValue({
      messages: [{ ts: "1", thread_ts: "9" }],
    });
    const resolver = createSlackThreadTsResolver({
      // oxlint-disable-next-line typescript/no-explicit-any
      client: { conversations: { history: historyMock } } as any,
      cacheTtlMs: 60_000,
      maxSize: 5,
    });

    const message = {
      channel: "C1",
      parent_user_id: "U2",
      ts: "1",
    } as SlackMessageEvent;

    const first = await resolver.resolve({ message, source: "message" });
    const second = await resolver.resolve({ message, source: "message" });

    expect(first.thread_ts).toBe("9");
    expect(second.thread_ts).toBe("9");
    expect(historyMock).toHaveBeenCalledTimes(1);
  });

  it("does not cache API failures so subsequent calls can retry", async () => {
    const historyMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("slack_api_error"))
      .mockResolvedValueOnce({ messages: [{ ts: "1", thread_ts: "9" }] });

    const resolver = createSlackThreadTsResolver({
      // oxlint-disable-next-line typescript/no-explicit-any
      client: { conversations: { history: historyMock } } as any,
      cacheTtlMs: 60_000,
      maxSize: 5,
    });

    const message = {
      channel: "C1",
      parent_user_id: "U2",
      ts: "1",
    } as SlackMessageEvent;

    // First call fails -- thread_ts should be missing (not cached as "no thread").
    const first = await resolver.resolve({ message, source: "message" });
    expect(first.thread_ts).toBeUndefined();

    // Second call retries and succeeds because the failure was NOT cached.
    const second = await resolver.resolve({ message, source: "message" });
    expect(second.thread_ts).toBe("9");
    expect(historyMock).toHaveBeenCalledTimes(2);
  });
});
