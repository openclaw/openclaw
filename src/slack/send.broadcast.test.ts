import { describe, it, expect, vi, beforeEach } from "vitest";
import { sendMessageSlack } from "./send.js";
import { resolveSlackBotToken } from "./token.js";

// Mock dependencies
vi.mock("./token.js");
vi.mock("./accounts.js", () => ({
  resolveSlackAccount: vi.fn().mockReturnValue({ accountId: "default", botToken: "mock-token" }),
}));
vi.mock("./targets.js", () => ({
  parseSlackTarget: vi.fn().mockReturnValue({ kind: "channel", id: "C123" }),
}));
vi.mock("../config/config.js", () => ({
  loadConfig: vi.fn().mockReturnValue({}),
}));
vi.mock("../auto-reply/chunk.js", () => ({
  resolveChunkMode: vi.fn().mockReturnValue("length"),
  resolveTextChunkLimit: vi.fn().mockReturnValue(4000),
  chunkMarkdownTextWithMode: vi.fn().mockReturnValue(["test"]),
}));
vi.mock("./format.js", () => ({
  markdownToSlackMrkdwnChunks: vi.fn().mockReturnValue(["test"]),
}));

describe("sendMessageSlack broadcast", () => {
  const mockPostMessage = vi.fn().mockResolvedValue({ ts: "123.456", ok: true });
  const mockClient = {
    chat: { postMessage: mockPostMessage },
  } as any;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveSlackBotToken).mockReturnValue("mock-token");
  });

  it("passes reply_broadcast=true when replyBroadcast option is set", async () => {
    await sendMessageSlack("C123", "test", {
      client: mockClient,
      threadTs: "thread.123",
      replyBroadcast: true,
    });

    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C123",
        text: "test",
        thread_ts: "thread.123",
        reply_broadcast: true,
      }),
    );
  });

  it("passes reply_broadcast=undefined when option is missing", async () => {
    await sendMessageSlack("C123", "test", {
      client: mockClient,
      threadTs: "thread.123",
    });

    expect(mockPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C123",
        text: "test",
        thread_ts: "thread.123",
        reply_broadcast: undefined,
      }),
    );
  });
});
