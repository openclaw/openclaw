import type { WebClient } from "@slack/web-api";
import { describe, expect, it, vi } from "vitest";

vi.mock("../config/config.js", () => ({
  loadConfig: () => ({}),
}));

vi.mock("./accounts.js", () => ({
  resolveSlackAccount: () => ({
    accountId: "default",
    botToken: "xoxb-test",
    botTokenSource: "config",
    config: {},
  }),
}));

const { sendMessageSlack } = await import("./send.js");

function createClient() {
  return {
    conversations: {
      open: vi.fn(async () => ({ channel: { id: "D123" } })),
    },
    chat: {
      postMessage: vi.fn(async () => ({ ts: "171234.567" })),
    },
  } as unknown as WebClient & {
    conversations: { open: ReturnType<typeof vi.fn> };
    chat: { postMessage: ReturnType<typeof vi.fn> };
  };
}

describe("sendMessageSlack blocks", () => {
  it("posts blocks with fallback text when message is empty", async () => {
    const client = createClient();
    const result = await sendMessageSlack("channel:C123", "", {
      token: "xoxb-test",
      client,
      blocks: [{ type: "divider" }],
    });

    expect(client.conversations.open).not.toHaveBeenCalled();
    expect(client.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C123",
        text: " ",
        blocks: [{ type: "divider" }],
      }),
    );
    expect(result).toEqual({ messageId: "171234.567", channelId: "C123" });
  });

  it("rejects blocks combined with mediaUrl", async () => {
    const client = createClient();
    await expect(
      sendMessageSlack("channel:C123", "hi", {
        token: "xoxb-test",
        client,
        mediaUrl: "https://example.com/image.png",
        blocks: [{ type: "divider" }],
      }),
    ).rejects.toThrow(/does not support blocks with mediaUrl/i);
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });

  it("rejects empty blocks arrays from runtime callers", async () => {
    const client = createClient();
    await expect(
      sendMessageSlack("channel:C123", "hi", {
        token: "xoxb-test",
        client,
        blocks: [],
      }),
    ).rejects.toThrow(/must contain at least one block/i);
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });

  it("rejects blocks arrays above Slack max count", async () => {
    const client = createClient();
    const blocks = Array.from({ length: 51 }, () => ({ type: "divider" }));
    await expect(
      sendMessageSlack("channel:C123", "hi", {
        token: "xoxb-test",
        client,
        blocks,
      }),
    ).rejects.toThrow(/cannot exceed 50 items/i);
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });

  it("rejects blocks missing type from runtime callers", async () => {
    const client = createClient();
    await expect(
      sendMessageSlack("channel:C123", "hi", {
        token: "xoxb-test",
        client,
        blocks: [{} as { type: string }],
      }),
    ).rejects.toThrow(/non-empty string type/i);
    expect(client.chat.postMessage).not.toHaveBeenCalled();
  });
});
