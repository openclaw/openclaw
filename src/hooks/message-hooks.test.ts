import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FinalizedMsgContext } from "../auto-reply/templating.js";
import {
  clearInternalHooks,
  registerInternalHook,
  type InternalHookEvent,
} from "./internal-hooks.js";
import {
  triggerMessageReceived,
  triggerMessageSent,
  type MessageReceivedContext,
  type MessageSentContext,
} from "./message-hooks.js";

describe("message-hooks", () => {
  beforeEach(() => {
    clearInternalHooks();
  });

  afterEach(() => {
    clearInternalHooks();
  });

  describe("triggerMessageReceived", () => {
    it("triggers message:received hook with correct context", async () => {
      const handler = vi.fn();
      registerInternalHook("message:received", handler);

      const ctx = {
        Body: "Hello world",
        RawBody: "Hello world",
        SenderId: "+1234567890",
        SenderName: "Test User",
        Provider: "signal",
        MessageSid: "msg-123",
        ChatType: "dm" as const,
        From: "+1234567890",
        SessionKey: "agent:main:signal",
        Timestamp: 1700000000,
        CommandAuthorized: true,
      };

      await triggerMessageReceived("agent:main:signal", ctx as unknown as FinalizedMsgContext);

      expect(handler).toHaveBeenCalledTimes(1);
      const event = handler.mock.calls[0][0] as InternalHookEvent;
      expect(event.type).toBe("message");
      expect(event.action).toBe("received");
      expect(event.sessionKey).toBe("agent:main:signal");

      const eventContext = event.context as MessageReceivedContext;
      expect(eventContext.message).toBe("Hello world");
      expect(eventContext.rawBody).toBe("Hello world");
      expect(eventContext.senderId).toBe("+1234567890");
      expect(eventContext.senderName).toBe("Test User");
      expect(eventContext.channel).toBe("signal");
      expect(eventContext.messageId).toBe("msg-123");
      expect(eventContext.isGroup).toBe(false);
      expect(eventContext.commandAuthorized).toBe(true);
    });

    it("sets isGroup=true and groupId for group messages", async () => {
      const handler = vi.fn();
      registerInternalHook("message:received", handler);

      const ctx = {
        Body: "Group message",
        ChatType: "group" as const,
        From: "group-abc-123",
        SessionKey: "agent:main:signal:group",
      };

      await triggerMessageReceived(
        "agent:main:signal:group",
        ctx as unknown as FinalizedMsgContext,
      );

      const event = handler.mock.calls[0][0] as InternalHookEvent;
      const eventContext = event.context as MessageReceivedContext;
      expect(eventContext.isGroup).toBe(true);
      expect(eventContext.groupId).toBe("group-abc-123");
    });

    it("does not fire if no handlers registered", async () => {
      // Should not throw when no handlers are registered
      const ctx = { Body: "test", SessionKey: "test" };
      await expect(
        triggerMessageReceived("test", ctx as unknown as FinalizedMsgContext),
      ).resolves.toBeUndefined();
    });
  });

  describe("triggerMessageSent", () => {
    it("triggers message:sent hook with correct context", async () => {
      const handler = vi.fn();
      registerInternalHook("message:sent", handler);

      const payload = { text: "Hello back!" };
      const context = {
        target: "signal:+1234567890",
        channel: "signal",
        kind: "final",
      };

      await triggerMessageSent("agent:main:main", payload, context);

      expect(handler).toHaveBeenCalledTimes(1);
      const event = handler.mock.calls[0][0] as InternalHookEvent;
      expect(event.type).toBe("message");
      expect(event.action).toBe("sent");
      expect(event.sessionKey).toBe("agent:main:main");

      const eventContext = event.context as MessageSentContext;
      expect(eventContext.text).toBe("Hello back!");
      expect(eventContext.target).toBe("signal:+1234567890");
      expect(eventContext.channel).toBe("signal");
      expect(eventContext.kind).toBe("final");
    });

    it("handles payload with media", async () => {
      const handler = vi.fn();
      registerInternalHook("message:sent", handler);

      const payload = {
        text: "Check this out",
        mediaUrl: "/tmp/image.png",
      };

      await triggerMessageSent("test-session", payload, { channel: "telegram" });

      const event = handler.mock.calls[0][0] as InternalHookEvent;
      const context = event.context as MessageSentContext;
      expect(context.mediaUrl).toBe("/tmp/image.png");
    });
  });
});
