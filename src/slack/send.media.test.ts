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

vi.mock("../web/media.js", () => ({
  loadWebMedia: vi.fn(async () => ({
    buffer: Buffer.from("hello"),
    contentType: "text/plain",
    kind: "unknown",
    fileName: "oc_test_file.txt",
  })),
}));

const { sendMessageSlack } = await import("./send.js");

function createClient() {
  return {
    conversations: {
      open: vi.fn(async () => ({ channel: { id: "D12345678" } })),
    },
    files: {
      uploadV2: vi.fn(async () => ({ files: [{ id: "F123" }] })),
    },
    chat: {
      postMessage: vi.fn(async () => ({ ts: "171234.567" })),
    },
  } as unknown as WebClient & {
    conversations: { open: ReturnType<typeof vi.fn> };
    files: { uploadV2: ReturnType<typeof vi.fn> };
    chat: { postMessage: ReturnType<typeof vi.fn> };
  };
}

describe("sendMessageSlack media target inference", () => {
  it("opens a DM when target is a bare U-id and uploads with DM channel_id", async () => {
    const client = createClient();
    const result = await sendMessageSlack("U12345678", "test txt upload", {
      token: "xoxb-test",
      client,
      mediaUrl: "/tmp/oc_test_file.txt",
    });

    expect(client.conversations.open).toHaveBeenCalledWith({ users: "U12345678" });
    expect(client.files.uploadV2).toHaveBeenCalledWith(
      expect.objectContaining({
        channel_id: "D12345678",
        initial_comment: "test txt upload",
        filename: "oc_test_file.txt",
      }),
    );
    expect(result).toEqual({
      messageId: "F123",
      channelId: "D12345678",
    });
  });
});
