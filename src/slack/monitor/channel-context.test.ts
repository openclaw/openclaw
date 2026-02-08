import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock the actions module before importing channel-context
vi.mock("../actions.js", () => ({
  readSlackMessages: vi.fn(),
}));

import { readSlackMessages } from "../actions.js";
import { fetchChannelContext } from "./channel-context.js";

const mockReadSlackMessages = vi.mocked(readSlackMessages);

function createMockClient(channelName = "general") {
  return {
    conversations: {
      info: vi.fn().mockResolvedValue({ channel: { name: channelName } }),
    },
  } as unknown as import("@slack/web-api").WebClient;
}

describe("fetchChannelContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when readSlackMessages returns no messages", async () => {
    mockReadSlackMessages.mockResolvedValue({ messages: [], hasMore: false });
    const client = createMockClient();

    const result = await fetchChannelContext({
      channelId: "C123",
      clientOpts: { client },
      client,
    });

    expect(result).toBeNull();
  });

  it("formats messages into a context block", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    mockReadSlackMessages.mockResolvedValue({
      messages: [
        { ts: String(nowSec - 60), text: "Hello world", user: "U123" },
        { ts: String(nowSec - 120), text: "How are things?", user: "U456" },
      ],
      hasMore: false,
    });

    const client = createMockClient();
    const result = await fetchChannelContext({
      channelId: "C123",
      clientOpts: { client },
      client,
      messageLimit: 10,
    });

    expect(result).not.toBeNull();
    expect(result!.channelName).toBe("general");
    expect(result!.messageCount).toBe(2);
    expect(result!.contextBlock).toContain("[Channel Context]");
    expect(result!.contextBlock).toContain("#general");
    expect(result!.contextBlock).toContain("<@U456>");
    expect(result!.contextBlock).toContain("<@U123>");
    expect(result!.contextBlock).toContain("Hello world");
    expect(result!.contextBlock).toContain("How are things?");
  });

  it("reverses messages to chronological order", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    // conversations.history returns newest first
    mockReadSlackMessages.mockResolvedValue({
      messages: [
        { ts: String(nowSec - 10), text: "newest", user: "U1" },
        { ts: String(nowSec - 100), text: "oldest", user: "U2" },
      ],
      hasMore: false,
    });

    const client = createMockClient();
    const result = await fetchChannelContext({
      channelId: "C123",
      clientOpts: { client },
      client,
    });

    expect(result).not.toBeNull();
    const lines = result!.contextBlock.split("\n");
    // "oldest" should appear before "newest" in the output
    const oldestIdx = lines.findIndex((l) => l.includes("oldest"));
    const newestIdx = lines.findIndex((l) => l.includes("newest"));
    expect(oldestIdx).toBeLessThan(newestIdx);
  });

  it("returns null on API error without throwing", async () => {
    mockReadSlackMessages.mockRejectedValue(new Error("API error"));
    const client = createMockClient();

    const result = await fetchChannelContext({
      channelId: "C123",
      clientOpts: { client },
      client,
    });

    expect(result).toBeNull();
  });

  it("skips messages with empty text", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    mockReadSlackMessages.mockResolvedValue({
      messages: [
        { ts: String(nowSec - 60), text: "Real message", user: "U123" },
        { ts: String(nowSec - 120), text: "", user: "U456" },
        { ts: String(nowSec - 180), text: "  ", user: "U789" },
      ],
      hasMore: false,
    });

    const client = createMockClient();
    const result = await fetchChannelContext({
      channelId: "C123",
      clientOpts: { client },
      client,
    });

    expect(result).not.toBeNull();
    expect(result!.messageCount).toBe(1);
    expect(result!.contextBlock).toContain("Real message");
    expect(result!.contextBlock).not.toContain("<@U456>");
    expect(result!.contextBlock).not.toContain("<@U789>");
  });

  it("passes message limit to readSlackMessages", async () => {
    mockReadSlackMessages.mockResolvedValue({ messages: [], hasMore: false });
    const client = createMockClient();

    await fetchChannelContext({
      channelId: "C123",
      clientOpts: { client },
      client,
      messageLimit: 5,
    });

    expect(mockReadSlackMessages).toHaveBeenCalledWith(
      "C123",
      expect.objectContaining({ limit: 5 }),
    );
  });

  it("uses channel ID when channel name resolution fails", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    mockReadSlackMessages.mockResolvedValue({
      messages: [{ ts: String(nowSec - 60), text: "hello", user: "U1" }],
      hasMore: false,
    });

    const client = {
      conversations: {
        info: vi.fn().mockRejectedValue(new Error("not_found")),
      },
    } as unknown as import("@slack/web-api").WebClient;

    const result = await fetchChannelContext({
      channelId: "C123",
      clientOpts: { client },
      client,
    });

    expect(result).not.toBeNull();
    expect(result!.channelName).toBeUndefined();
    expect(result!.contextBlock).toContain("C123");
  });
});
