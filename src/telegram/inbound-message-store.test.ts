import type { Chat, Message, User } from "@grammyjs/types";
import { describe, it, expect, beforeEach } from "vitest";
import {
  recordInboundMessage,
  readInboundMessages,
  clearInboundStore,
  setMaxPerChat,
  inboundStoreStats,
} from "./inbound-message-store.js";

function makeMessage(overrides: Partial<Message> & { message_id: number; chat: Chat }): Message {
  return {
    date: Math.floor(Date.now() / 1000),
    from: {
      id: 100,
      is_bot: false,
      first_name: "Test",
    } as User,
    text: "hello",
    ...overrides,
  } as Message;
}

const chat: Chat = { id: -5001, type: "group", title: "Test Group" } as Chat;

describe("inbound-message-store", () => {
  beforeEach(() => {
    clearInboundStore();
    setMaxPerChat(200);
  });

  it("records and reads messages", () => {
    recordInboundMessage(makeMessage({ message_id: 1, chat }));
    recordInboundMessage(makeMessage({ message_id: 2, chat, text: "world" }));

    const msgs = readInboundMessages(-5001);
    expect(msgs).toHaveLength(2);
    // Newest first
    expect(msgs[0].messageId).toBe(2);
    expect(msgs[1].messageId).toBe(1);
  });

  it("deduplicates by message_id", () => {
    recordInboundMessage(makeMessage({ message_id: 1, chat }));
    recordInboundMessage(makeMessage({ message_id: 1, chat }));

    const msgs = readInboundMessages(-5001);
    expect(msgs).toHaveLength(1);
  });

  it("isolates chats", () => {
    const chat2: Chat = { id: -5002, type: "group", title: "Other" } as Chat;
    recordInboundMessage(makeMessage({ message_id: 1, chat }));
    recordInboundMessage(makeMessage({ message_id: 2, chat: chat2 }));

    expect(readInboundMessages(-5001)).toHaveLength(1);
    expect(readInboundMessages(-5002)).toHaveLength(1);
    expect(readInboundMessages(-9999)).toHaveLength(0);
  });

  it("respects limit", () => {
    for (let i = 1; i <= 10; i++) {
      recordInboundMessage(makeMessage({ message_id: i, chat }));
    }
    const msgs = readInboundMessages(-5001, { limit: 3 });
    expect(msgs).toHaveLength(3);
    expect(msgs[0].messageId).toBe(10);
    expect(msgs[2].messageId).toBe(8);
  });

  it("supports before filter", () => {
    for (let i = 1; i <= 5; i++) {
      recordInboundMessage(makeMessage({ message_id: i, chat }));
    }
    const msgs = readInboundMessages(-5001, { before: 4 });
    expect(msgs.map((m) => m.messageId)).toEqual([3, 2, 1]);
  });

  it("supports after filter", () => {
    for (let i = 1; i <= 5; i++) {
      recordInboundMessage(makeMessage({ message_id: i, chat }));
    }
    const msgs = readInboundMessages(-5001, { after: 3 });
    expect(msgs.map((m) => m.messageId)).toEqual([5, 4]);
  });

  it("evicts oldest when over capacity", () => {
    setMaxPerChat(10);
    for (let i = 1; i <= 15; i++) {
      recordInboundMessage(makeMessage({ message_id: i, chat }));
    }
    const msgs = readInboundMessages(-5001, { limit: 100 });
    expect(msgs).toHaveLength(10);
    // Oldest should be 6 (1-5 evicted)
    expect(msgs[msgs.length - 1].messageId).toBe(6);
  });

  it("normalizes message fields", () => {
    recordInboundMessage(
      makeMessage({
        message_id: 42,
        chat,
        text: "test msg",
        from: {
          id: 777,
          is_bot: false,
          first_name: "Alice",
          last_name: "Smith",
          username: "alice",
        } as User,
      }),
    );
    const [msg] = readInboundMessages(-5001);
    expect(msg.messageId).toBe(42);
    expect(msg.chatId).toBe(-5001);
    expect(msg.text).toBe("test msg");
    expect(msg.from?.id).toBe(777);
    expect(msg.from?.username).toBe("alice");
    expect(msg.from?.isBot).toBe(false);
  });

  it("reports stats", () => {
    recordInboundMessage(makeMessage({ message_id: 1, chat }));
    recordInboundMessage(makeMessage({ message_id: 2, chat }));
    const stats = inboundStoreStats();
    expect(stats.chatCount).toBe(1);
    expect(stats.totalMessages).toBe(2);
  });

  it("clamps limit to 1-100", () => {
    for (let i = 1; i <= 5; i++) {
      recordInboundMessage(makeMessage({ message_id: i, chat }));
    }
    // limit: 0 should become 1
    expect(readInboundMessages(-5001, { limit: 0 })).toHaveLength(1);
    // limit: 999 should cap at 100 (but only 5 exist)
    expect(readInboundMessages(-5001, { limit: 999 })).toHaveLength(5);
  });
});
