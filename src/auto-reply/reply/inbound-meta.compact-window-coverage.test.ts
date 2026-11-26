// Tests that the compact inbound context follows the default builder's chat-window coverage rules.
import { describe, expect, it } from "vitest";
import type { TemplateContext } from "../templating.js";
import { buildCompactInboundUserContextPrefix } from "./inbound-meta.compact.js";
import { buildInboundUserContextPrefix } from "./inbound-meta.js";

const base = {
  ChatType: "group",
  MessageSid: "current",
  SenderName: "Onur",
  SenderId: "user-1",
  Timestamp: 3_000,
} as const;

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

describe("compact inbound context and chat-window coverage", () => {
  it("does not repeat InboundHistory rows that a history chat window already carries", () => {
    // Telegram copies its window rows into InboundHistory; rows without a string id stay unkeyed.
    const ctx = {
      ...base,
      ChannelStructuredContext: [
        {
          label: "Conversation context",
          type: "chat_window",
          source: "telegram",
          payload: {
            order: "chronological",
            relation: "before_current_message",
            messages: [
              { sender: "Alice", body: "deploy window opens at nine", timestamp_ms: 1_000 },
            ],
          },
        },
      ],
      InboundHistory: [{ sender: "Alice", body: "deploy window opens at nine", timestamp: 1_000 }],
    } as TemplateContext;

    const compact = buildCompactInboundUserContextPrefix(ctx).text;

    expect(count(compact, "deploy window opens at nine")).toBe(1);
    expect(count(compact, "deploy window opens at nine")).toBeLessThanOrEqual(
      count(buildInboundUserContextPrefix(ctx), "deploy window opens at nine"),
    );
  });

  it("skips the reply target when the chat window already holds the quoted message", () => {
    const ctx = {
      ...base,
      Provider: "discord",
      ReplyToId: "41",
      ReplyToSender: "Alice",
      ReplyToBody: "ship it on Friday",
      ChannelStructuredContext: [
        {
          label: "Conversation context",
          type: "chat_window",
          source: "discord",
          payload: {
            order: "chronological",
            relation: "before_current_message",
            messages: [
              { message_id: "41", sender: "Alice", body: "ship it on Friday", timestamp_ms: 1_000 },
            ],
          },
        },
      ],
    } as TemplateContext;

    const compact = buildCompactInboundUserContextPrefix(ctx).text;

    expect(compact).not.toContain("Reply target:");
    expect(count(compact, "ship it on Friday")).toBe(1);
  });
});
