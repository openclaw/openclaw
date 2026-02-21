import type { WebClient } from "@slack/web-api";
import { describe, expect, it, vi } from "vitest";
import type { SlackMessageEvent } from "../types.js";
import { createSlackThreadTsResolver } from "./thread-resolution.js";

describe("slack createSlackThreadTsResolver", () => {
  it("uses event_ts when ts is missing for cache key and history lookup", async () => {
    const conversations = {
      history: vi.fn().mockResolvedValue({
        messages: [{ ts: "100.555", thread_ts: "100.500" }],
      }),
    };
    const resolver = createSlackThreadTsResolver({
      client: { conversations } as unknown as WebClient,
    });

    const message = {
      channel: "C123",
      channel_type: "channel",
      user: "U1",
      text: "hi",
      event_ts: "100.555",
      parent_user_id: "U2",
      thread_ts: undefined,
      type: "message",
    } as SlackMessageEvent;

    const resolved = await resolver.resolve({ message, source: "app_mention" });

    expect(resolved.thread_ts).toBe("100.500");
    expect(conversations.history).toHaveBeenCalledWith({
      channel: "C123",
      latest: "100.555",
      oldest: "100.555",
      inclusive: true,
      limit: 1,
    });
  });
});
