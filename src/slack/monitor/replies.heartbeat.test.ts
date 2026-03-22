import { describe, expect, it, vi } from "vitest";

vi.mock("../../auto-reply/chunk.js", () => ({
  chunkMarkdownTextWithMode: vi.fn((text: string) => [text]),
}));

vi.mock("../format.js", () => ({
  markdownToSlackMrkdwnChunks: vi.fn((text: string) => [text]),
}));

vi.mock("../send.js", () => ({
  sendMessageSlack: vi.fn().mockResolvedValue({ messageId: "1234.5678", channelId: "C123" }),
}));

import { sendMessageSlack } from "../send.js";
import { deliverReplies } from "./replies.js";

const baseParams = {
  target: "C123",
  token: "xoxb-test",
  runtime: { log: vi.fn() } as never,
  textLimit: 4000,
  replyToMode: "off" as const,
};

describe("deliverReplies HEARTBEAT_OK safety-net", () => {
  it("strips messages that are exactly 'HEARTBEAT_OK'", async () => {
    await deliverReplies({
      ...baseParams,
      replies: [{ text: "HEARTBEAT_OK" }],
    });
    expect(sendMessageSlack).not.toHaveBeenCalled();
  });

  it("strips messages that are 'HEARTBEAT_OK' with surrounding whitespace", async () => {
    await deliverReplies({
      ...baseParams,
      replies: [{ text: "  HEARTBEAT_OK  " }],
    });
    expect(sendMessageSlack).not.toHaveBeenCalled();
  });

  it("strips HEARTBEAT_OK from messages with surrounding content", async () => {
    await deliverReplies({
      ...baseParams,
      replies: [{ text: "HEARTBEAT_OK Here is some other text" }],
    });
    expect(sendMessageSlack).toHaveBeenCalledWith(
      "C123",
      expect.not.stringContaining("HEARTBEAT_OK"),
      expect.any(Object),
    );
  });

  it("does NOT strip normal messages containing the word 'heartbeat'", async () => {
    await deliverReplies({
      ...baseParams,
      replies: [{ text: "The heartbeat check passed successfully" }],
    });
    expect(sendMessageSlack).toHaveBeenCalledWith(
      "C123",
      "The heartbeat check passed successfully",
      expect.any(Object),
    );
  });

  it("does NOT strip normal messages", async () => {
    await deliverReplies({
      ...baseParams,
      replies: [{ text: "Hello, how can I help?" }],
    });
    expect(sendMessageSlack).toHaveBeenCalledWith(
      "C123",
      "Hello, how can I help?",
      expect.any(Object),
    );
  });

  it("still delivers media when HEARTBEAT_OK text is stripped", async () => {
    await deliverReplies({
      ...baseParams,
      replies: [{ text: "HEARTBEAT_OK", mediaUrl: "https://example.com/image.png" }],
    });
    expect(sendMessageSlack).toHaveBeenCalled();
  });
});
