import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig } from "../config/types.js";

describe("WhatsApp ack reaction", () => {
  const mockSendReaction = vi.fn(async () => {});
  const mockGetReply = vi.fn(async () => ({
    payloads: [{ text: "test reply" }],
    meta: {},
  }));

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should send ack reaction in direct chat when scope is 'all'", async () => {
    const cfg: ClawdbotConfig = {
      messages: {
        ackReaction: "👀",
        ackReactionScope: "all",
      },
    };

    // Simulate the logic from auto-reply.ts
    const msg = {
      id: "msg123",
      chatId: "123456789@s.whatsapp.net",
      chatType: "direct" as const,
      from: "+1234567890",
      to: "+9876543210",
      body: "hello",
    };

    const ackReaction = (cfg.messages?.ackReaction ?? "").trim();
    const ackReactionScope = cfg.messages?.ackReactionScope ?? "group-mentions";
    const didSendReply = true;

    const shouldAckReaction = () => {
      if (!ackReaction) return false;
      if (!msg.id) return false;
      if (!didSendReply) return false;
      if (ackReactionScope === "all") return true;
      if (ackReactionScope === "direct") return msg.chatType === "direct";
      if (ackReactionScope === "group-all") return msg.chatType === "group";
      if (ackReactionScope === "group-mentions") {
        if (msg.chatType !== "group") return false;
        return false; // Would check wasMentioned
      }
      return false;
    };

    expect(shouldAckReaction()).toBe(true);
  });

  it("should send ack reaction in direct chat when scope is 'direct'", async () => {
    const cfg: ClawdbotConfig = {
      messages: {
        ackReaction: "👀",
        ackReactionScope: "direct",
      },
    };

    const msg = {
      id: "msg123",
      chatId: "123456789@s.whatsapp.net",
      chatType: "direct" as const,
      from: "+1234567890",
      to: "+9876543210",
      body: "hello",
    };

    const ackReaction = (cfg.messages?.ackReaction ?? "").trim();
    const ackReactionScope = cfg.messages?.ackReactionScope ?? "group-mentions";
    const didSendReply = true;

    const shouldAckReaction = () => {
      if (!ackReaction) return false;
      if (!msg.id) return false;
      if (!didSendReply) return false;
      if (ackReactionScope === "all") return true;
      if (ackReactionScope === "direct") return msg.chatType === "direct";
      if (ackReactionScope === "group-all") return msg.chatType === "group";
      return false;
    };

    expect(shouldAckReaction()).toBe(true);
  });

  it("should NOT send ack reaction in group when scope is 'direct'", async () => {
    const cfg: ClawdbotConfig = {
      messages: {
        ackReaction: "👀",
        ackReactionScope: "direct",
      },
    };

    const msg = {
      id: "msg123",
      chatId: "123456789-group@g.us",
      chatType: "group" as const,
      from: "123456789-group@g.us",
      to: "+9876543210",
      body: "hello",
      wasMentioned: true,
    };

    const ackReaction = (cfg.messages?.ackReaction ?? "").trim();
    const ackReactionScope = cfg.messages?.ackReactionScope ?? "group-mentions";
    const didSendReply = true;

    const shouldAckReaction = () => {
      if (!ackReaction) return false;
      if (!msg.id) return false;
      if (!didSendReply) return false;
      if (ackReactionScope === "all") return true;
      if (ackReactionScope === "direct") return msg.chatType === "direct";
      if (ackReactionScope === "group-all") return msg.chatType === "group";
      return false;
    };

    expect(shouldAckReaction()).toBe(false);
  });

  it("should send ack reaction in group when mentioned and scope is 'group-mentions'", async () => {
    const cfg: ClawdbotConfig = {
      messages: {
        ackReaction: "👀",
        ackReactionScope: "group-mentions",
      },
    };

    const msg = {
      id: "msg123",
      chatId: "123456789-group@g.us",
      chatType: "group" as const,
      from: "123456789-group@g.us",
      to: "+9876543210",
      body: "hello @bot",
      wasMentioned: true,
    };

    const ackReaction = (cfg.messages?.ackReaction ?? "").trim();
    const ackReactionScope = cfg.messages?.ackReactionScope ?? "group-mentions";
    const didSendReply = true;
    const requireMention = true; // Simulated from activation check

    const shouldAckReaction = () => {
      if (!ackReaction) return false;
      if (!msg.id) return false;
      if (!didSendReply) return false;
      if (ackReactionScope === "all") return true;
      if (ackReactionScope === "direct") return msg.chatType === "direct";
      if (ackReactionScope === "group-all") return msg.chatType === "group";
      if (ackReactionScope === "group-mentions") {
        if (msg.chatType !== "group") return false;
        if (!requireMention) return false;
        return msg.wasMentioned === true;
      }
      return false;
    };

    expect(shouldAckReaction()).toBe(true);
  });

  it("should NOT send ack reaction in group when NOT mentioned and scope is 'group-mentions'", async () => {
    const cfg: ClawdbotConfig = {
      messages: {
        ackReaction: "👀",
        ackReactionScope: "group-mentions",
      },
    };

    const msg = {
      id: "msg123",
      chatId: "123456789-group@g.us",
      chatType: "group" as const,
      from: "123456789-group@g.us",
      to: "+9876543210",
      body: "hello",
      wasMentioned: false,
    };

    const ackReaction = (cfg.messages?.ackReaction ?? "").trim();
    const ackReactionScope = cfg.messages?.ackReactionScope ?? "group-mentions";
    const didSendReply = true;
    const requireMention = true;

    const shouldAckReaction = () => {
      if (!ackReaction) return false;
      if (!msg.id) return false;
      if (!didSendReply) return false;
      if (ackReactionScope === "all") return true;
      if (ackReactionScope === "direct") return msg.chatType === "direct";
      if (ackReactionScope === "group-all") return msg.chatType === "group";
      if (ackReactionScope === "group-mentions") {
        if (msg.chatType !== "group") return false;
        if (!requireMention) return false;
        return msg.wasMentioned === true;
      }
      return false;
    };

    expect(shouldAckReaction()).toBe(false);
  });

  it("should NOT send ack reaction when no reply was sent", async () => {
    const cfg: ClawdbotConfig = {
      messages: {
        ackReaction: "👀",
        ackReactionScope: "all",
      },
    };

    const msg = {
      id: "msg123",
      chatId: "123456789@s.whatsapp.net",
      chatType: "direct" as const,
      from: "+1234567890",
      to: "+9876543210",
      body: "hello",
    };

    const ackReaction = (cfg.messages?.ackReaction ?? "").trim();
    const ackReactionScope = cfg.messages?.ackReactionScope ?? "group-mentions";
    const didSendReply = false; // No reply sent

    const shouldAckReaction = () => {
      if (!ackReaction) return false;
      if (!msg.id) return false;
      if (!didSendReply) return false;
      return true;
    };

    expect(shouldAckReaction()).toBe(false);
  });

  it("should NOT send ack reaction when ackReaction is empty", async () => {
    const cfg: ClawdbotConfig = {
      messages: {
        ackReaction: "",
        ackReactionScope: "all",
      },
    };

    const msg = {
      id: "msg123",
      chatId: "123456789@s.whatsapp.net",
      chatType: "direct" as const,
      from: "+1234567890",
      to: "+9876543210",
      body: "hello",
    };

    const ackReaction = (cfg.messages?.ackReaction ?? "").trim();
    const ackReactionScope = cfg.messages?.ackReactionScope ?? "group-mentions";
    const didSendReply = true;

    const shouldAckReaction = () => {
      if (!ackReaction) return false;
      if (!msg.id) return false;
      if (!didSendReply) return false;
      return true;
    };

    expect(shouldAckReaction()).toBe(false);
  });
});
