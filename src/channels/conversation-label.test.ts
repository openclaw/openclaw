import { describe, expect, it } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";
import { resolveConversationLabel } from "./conversation-label.js";

describe("resolveConversationLabel", () => {
  const cases: Array<{ name: string; ctx: MsgContext; expected: string }> = [
    {
      name: "prefers ConversationLabel when present",
      ctx: { ConversationLabel: "Pinned Label", ChatType: "group" },
      expected: "Pinned Label",
    },
    {
      name: "prefers ThreadLabel over derived chat labels",
      ctx: {
        ThreadLabel: "Thread Alpha",
        ChatType: "group",
        GroupSubject: "Ops",
        From: "telegram:group:42",
      },
      expected: "Thread Alpha",
    },
    {
      name: "uses SenderName for direct chats when available",
      ctx: { ChatType: "direct", SenderName: "Ada", From: "telegram:99" },
      expected: "Ada",
    },
    {
      name: "falls back to From for direct chats when SenderName is missing",
      ctx: { ChatType: "direct", From: "telegram:99" },
      expected: "telegram:99",
    },
    {
      name: "derives Telegram-like group labels with numeric id suffix",
      ctx: { ChatType: "group", GroupSubject: "Ops", From: "telegram:group:42" },
      expected: "Ops id:42",
    },
    {
      name: "does not append ids for #rooms/channels",
      ctx: {
        ChatType: "channel",
        GroupSubject: "#general",
        From: "slack:channel:C123",
      },
      expected: "#general",
    },
    {
      name: "does not append ids when the base already contains the id",
      ctx: {
        ChatType: "group",
        GroupSubject: "Family id:123@g.us",
        From: "whatsapp:group:123@g.us",
      },
      expected: "Family id:123@g.us",
    },
    {
      name: "appends ids for WhatsApp-like group ids when a subject exists",
      ctx: {
        ChatType: "group",
        GroupSubject: "Family",
        From: "whatsapp:group:123@g.us",
      },
      expected: "Family id:123@g.us",
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(resolveConversationLabel(testCase.ctx)).toBe(testCase.expected);
    });
  }
});
