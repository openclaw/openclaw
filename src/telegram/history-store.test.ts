import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readTelegramHistoryMessages, recordTelegramHistoryMessage } from "./history-store.js";

describe("telegram history store", () => {
  it("records and reads back messages", async () => {
    const env = {
      ...process.env,
      OPENCLAW_STATE_DIR: path.join(os.tmpdir(), `openclaw-test-${Date.now()}`),
    };

    await recordTelegramHistoryMessage({
      env,
      accountId: "default",
      chatId: -100,
      threadId: "123",
      messageId: 10,
      direction: "inbound",
      dateMs: 1000,
      senderId: "1",
      senderUsername: "alice",
      senderName: "Alice",
      text: "hello",
      wasMention: true,
      isGroup: true,
      sessionKey: "agent:main:telegram:group:-100",
      maxMessagesPerChat: 100,
    });

    await recordTelegramHistoryMessage({
      env,
      accountId: "default",
      chatId: -100,
      threadId: "123",
      messageId: 11,
      direction: "inbound",
      dateMs: 2000,
      senderId: "2",
      senderUsername: "bob",
      senderName: "Bob",
      text: "world",
      wasMention: false,
      isGroup: true,
      sessionKey: "agent:main:telegram:group:-100",
      maxMessagesPerChat: 100,
    });

    const msgs = await readTelegramHistoryMessages({
      env,
      accountId: "default",
      chatId: -100,
      threadId: "123",
      limit: 10,
    });

    expect(msgs.length).toBe(2);
    expect(msgs[0]?.messageId).toBe(10);
    expect(msgs[1]?.messageId).toBe(11);
    expect(msgs[1]?.text).toBe("world");
  });
});
