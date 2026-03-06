import { describe, it, expect } from "vitest";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import { resolveLastChannelRaw, resolveLastToRaw } from "./session-delivery.js";

describe("session-delivery heartbeat fix (#35300)", () => {
  describe("resolveLastChannelRaw", () => {
    it("should return webchat for internal heartbeat messages even with stale persistedLastChannel", () => {
      // Simulate heartbeat message originating from webchat
      // but session has stale feishu persistedLastChannel
      const result = resolveLastChannelRaw({
        originatingChannelRaw: INTERNAL_MESSAGE_CHANNEL,
        persistedLastChannel: "feishu",
        sessionKey: "agent:main:webchat:direct:heartbeat",
      });

      // Should NOT inherit stale feishu channel
      expect(result).toBe(INTERNAL_MESSAGE_CHANNEL);
    });

    it("should return webchat for internal cron messages", () => {
      const result = resolveLastChannelRaw({
        originatingChannelRaw: INTERNAL_MESSAGE_CHANNEL,
        persistedLastChannel: "telegram",
        sessionKey: "agent:main:cron:daily-check",
      });

      expect(result).toBe(INTERNAL_MESSAGE_CHANNEL);
    });

    it("should return webchat for internal exec-event messages", () => {
      const result = resolveLastChannelRaw({
        originatingChannelRaw: INTERNAL_MESSAGE_CHANNEL,
        persistedLastChannel: "whatsapp",
        sessionKey: "agent:main:webchat:direct:exec-123",
      });

      expect(result).toBe(INTERNAL_MESSAGE_CHANNEL);
    });

    it("should still use persistedLastChannel for external channels when originating is undefined", () => {
      // Normal external message flow should still work
      const result = resolveLastChannelRaw({
        originatingChannelRaw: undefined,
        persistedLastChannel: "feishu",
        sessionKey: "agent:main:feishu:direct:user123",
      });

      expect(result).toBe("feishu");
    });

    it("should prefer originating channel over persisted for external messages", () => {
      const result = resolveLastChannelRaw({
        originatingChannelRaw: "telegram",
        persistedLastChannel: "feishu",
        sessionKey: "agent:main:telegram:group:group123",
      });

      expect(result).toBe("telegram");
    });
  });

  describe("resolveLastToRaw", () => {
    it("should use originatingTo for internal heartbeat messages", () => {
      const result = resolveLastToRaw({
        originatingChannelRaw: INTERNAL_MESSAGE_CHANNEL,
        originatingToRaw: "heartbeat",
        persistedLastTo: "feishu-user-openid",
        persistedLastChannel: "feishu",
        sessionKey: "agent:main:webchat:direct:heartbeat",
      });

      // Should use heartbeat destination, not stale feishu user
      expect(result).toBe("heartbeat");
    });

    it("should use to parameter when originatingTo is undefined for internal messages", () => {
      const result = resolveLastToRaw({
        originatingChannelRaw: INTERNAL_MESSAGE_CHANNEL,
        originatingToRaw: undefined,
        toRaw: "webchat-user",
        persistedLastTo: "feishu-user-openid",
        persistedLastChannel: "feishu",
        sessionKey: "agent:main:webchat:direct:user456",
      });

      expect(result).toBe("webchat-user");
    });

    it("should still use persistedLastTo for external messages when originating is undefined", () => {
      const result = resolveLastToRaw({
        originatingChannelRaw: undefined,
        originatingToRaw: undefined,
        toRaw: undefined,
        persistedLastTo: "feishu-user-openid",
        persistedLastChannel: "feishu",
        sessionKey: "agent:main:feishu:direct:user789",
      });

      expect(result).toBe("feishu-user-openid");
    });

    it("should prefer originatingTo over persisted for external messages", () => {
      const result = resolveLastToRaw({
        originatingChannelRaw: "telegram",
        originatingToRaw: "telegram-chat-id",
        persistedLastTo: "feishu-user-openid",
        persistedLastChannel: "feishu",
        sessionKey: "agent:main:telegram:group:group456",
      });

      expect(result).toBe("telegram-chat-id");
    });
  });
});
