import { describe, expect, it } from "vitest";
import type { ClawdbotConfig } from "../config/types.js";

describe("WhatsApp ack reaction logic", () => {
  // Helper to simulate the logic from auto-reply.ts
  function shouldSendReaction(
    cfg: ClawdbotConfig,
    msg: {
      id?: string;
      chatType: "direct" | "group";
      wasMentioned?: boolean;
    },
    groupActivation?: "always" | "mention",
  ): boolean {
    const ackConfig = cfg.channels?.whatsapp?.ackReaction;
    const emoji = (ackConfig?.emoji ?? "").trim();
    const directEnabled = ackConfig?.direct ?? true;
    const groupMode = ackConfig?.group ?? "mentions";

    if (!emoji) return false;
    if (!msg.id) return false;

    // Direct chat logic
    if (msg.chatType === "direct") {
      return directEnabled;
    }

    // Group chat logic
    if (msg.chatType === "group") {
      if (groupMode === "never") return false;
      if (groupMode === "always") return true;
      if (groupMode === "mentions") {
        // If group activation is "always", always react
        if (groupActivation === "always") return true;
        // Otherwise, only react if bot was mentioned
        return msg.wasMentioned === true;
      }
    }

    return false;
  }

  describe("direct chat", () => {
    it("should react when direct=true", () => {
      const cfg: ClawdbotConfig = {
        channels: { whatsapp: { ackReaction: { emoji: "👀", direct: true } } },
      };
      expect(
        shouldSendReaction(cfg, {
          id: "msg1",
          chatType: "direct",
        }),
      ).toBe(true);
    });

    it("should not react when direct=false", () => {
      const cfg: ClawdbotConfig = {
        channels: { whatsapp: { ackReaction: { emoji: "👀", direct: false } } },
      };
      expect(
        shouldSendReaction(cfg, {
          id: "msg1",
          chatType: "direct",
        }),
      ).toBe(false);
    });

    it("should not react when emoji is empty", () => {
      const cfg: ClawdbotConfig = {
        channels: { whatsapp: { ackReaction: { emoji: "", direct: true } } },
      };
      expect(
        shouldSendReaction(cfg, {
          id: "msg1",
          chatType: "direct",
        }),
      ).toBe(false);
    });

    it("should not react when message id is missing", () => {
      const cfg: ClawdbotConfig = {
        channels: { whatsapp: { ackReaction: { emoji: "👀", direct: true } } },
      };
      expect(
        shouldSendReaction(cfg, {
          chatType: "direct",
        }),
      ).toBe(false);
    });
  });

  describe("group chat - always mode", () => {
    it("should react to all messages when group=always", () => {
      const cfg: ClawdbotConfig = {
        channels: {
          whatsapp: { ackReaction: { emoji: "👀", group: "always" } },
        },
      };
      expect(
        shouldSendReaction(cfg, {
          id: "msg1",
          chatType: "group",
          wasMentioned: false,
        }),
      ).toBe(true);
    });

    it("should react even with mention when group=always", () => {
      const cfg: ClawdbotConfig = {
        channels: {
          whatsapp: { ackReaction: { emoji: "👀", group: "always" } },
        },
      };
      expect(
        shouldSendReaction(cfg, {
          id: "msg1",
          chatType: "group",
          wasMentioned: true,
        }),
      ).toBe(true);
    });
  });

  describe("group chat - mentions mode", () => {
    it("should react when mentioned", () => {
      const cfg: ClawdbotConfig = {
        channels: {
          whatsapp: { ackReaction: { emoji: "👀", group: "mentions" } },
        },
      };
      expect(
        shouldSendReaction(cfg, {
          id: "msg1",
          chatType: "group",
          wasMentioned: true,
        }),
      ).toBe(true);
    });

    it("should not react when not mentioned", () => {
      const cfg: ClawdbotConfig = {
        channels: {
          whatsapp: { ackReaction: { emoji: "👀", group: "mentions" } },
        },
      };
      expect(
        shouldSendReaction(
          cfg,
          {
            id: "msg1",
            chatType: "group",
            wasMentioned: false,
          },
          "mention", // group activation
        ),
      ).toBe(false);
    });

    it("should react to all messages when group activation is always", () => {
      const cfg: ClawdbotConfig = {
        channels: {
          whatsapp: { ackReaction: { emoji: "👀", group: "mentions" } },
        },
      };
      expect(
        shouldSendReaction(
          cfg,
          {
            id: "msg1",
            chatType: "group",
            wasMentioned: false,
          },
          "always", // group has requireMention=false
        ),
      ).toBe(true);
    });
  });

  describe("group chat - never mode", () => {
    it("should not react even with mention", () => {
      const cfg: ClawdbotConfig = {
        channels: {
          whatsapp: { ackReaction: { emoji: "👀", group: "never" } },
        },
      };
      expect(
        shouldSendReaction(cfg, {
          id: "msg1",
          chatType: "group",
          wasMentioned: true,
        }),
      ).toBe(false);
    });

    it("should not react without mention", () => {
      const cfg: ClawdbotConfig = {
        channels: {
          whatsapp: { ackReaction: { emoji: "👀", group: "never" } },
        },
      };
      expect(
        shouldSendReaction(cfg, {
          id: "msg1",
          chatType: "group",
          wasMentioned: false,
        }),
      ).toBe(false);
    });
  });

  describe("combinations", () => {
    it("direct=false, group=always: only groups", () => {
      const cfg: ClawdbotConfig = {
        channels: {
          whatsapp: {
            ackReaction: { emoji: "✅", direct: false, group: "always" },
          },
        },
      };

      expect(shouldSendReaction(cfg, { id: "m1", chatType: "direct" })).toBe(
        false,
      );

      expect(
        shouldSendReaction(cfg, {
          id: "m2",
          chatType: "group",
          wasMentioned: false,
        }),
      ).toBe(true);
    });

    it("direct=true, group=never: only direct", () => {
      const cfg: ClawdbotConfig = {
        channels: {
          whatsapp: {
            ackReaction: { emoji: "🤖", direct: true, group: "never" },
          },
        },
      };

      expect(shouldSendReaction(cfg, { id: "m1", chatType: "direct" })).toBe(
        true,
      );

      expect(
        shouldSendReaction(cfg, {
          id: "m2",
          chatType: "group",
          wasMentioned: true,
        }),
      ).toBe(false);
    });
  });

  describe("defaults", () => {
    it("should default direct=true", () => {
      const cfg: ClawdbotConfig = {
        channels: { whatsapp: { ackReaction: { emoji: "👀" } } },
      };
      expect(shouldSendReaction(cfg, { id: "m1", chatType: "direct" })).toBe(
        true,
      );
    });

    it("should default group=mentions", () => {
      const cfg: ClawdbotConfig = {
        channels: { whatsapp: { ackReaction: { emoji: "👀" } } },
      };

      expect(
        shouldSendReaction(cfg, {
          id: "m1",
          chatType: "group",
          wasMentioned: false,
        }),
      ).toBe(false);

      expect(
        shouldSendReaction(cfg, {
          id: "m2",
          chatType: "group",
          wasMentioned: true,
        }),
      ).toBe(true);
    });
  });

  describe("legacy config is ignored", () => {
    it("does not use messages.ackReaction for WhatsApp", () => {
      const cfg: ClawdbotConfig = {
        messages: { ackReaction: "👀", ackReactionScope: "all" },
      };
      expect(
        shouldSendReaction(cfg, {
          id: "m1",
          chatType: "direct",
        }),
      ).toBe(false);
    });
  });
});
