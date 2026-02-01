import { describe, expect, it } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";
import { resolveConversationLabel } from "./conversation-label.js";

describe("resolveConversationLabel", () => {
  it("prefers ConversationLabel when present", () => {
    const ctx: MsgContext = { ConversationLabel: "Pinned Label", ChatType: "group" };
    expect(resolveConversationLabel(ctx)).toBe("Pinned Label");
  });

  it("uses SenderName for direct chats when available", () => {
    const ctx: MsgContext = { ChatType: "direct", SenderName: "Ada", From: "telegram:99" };
    expect(resolveConversationLabel(ctx)).toBe("Ada");
  });

  it("derives Telegram-like group labels with numeric id suffix", () => {
    const ctx: MsgContext = { ChatType: "group", GroupSubject: "Ops", From: "telegram:group:42" };
    expect(resolveConversationLabel(ctx)).toBe("Ops id:42");
  });

  it("does not append ids for #rooms/channels", () => {
    const ctx: MsgContext = {
      ChatType: "channel",
      GroupSubject: "#general",
      From: "slack:channel:C123",
    };
    expect(resolveConversationLabel(ctx)).toBe("#general");
  });

  it("appends ids for WhatsApp-like group ids when a subject exists", () => {
    const ctx: MsgContext = {
      ChatType: "group",
      GroupSubject: "Family",
      From: "whatsapp:group:123@g.us",
    };
    expect(resolveConversationLabel(ctx)).toBe("Family id:123@g.us");
  });
});
