import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { FinalizedMsgContext } from "../auto-reply/templating.js";
import {
  registerInternalHook,
  clearInternalHooks,
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
        MessageSid: "msg123",
        ChatType: "direct",
        From: "signal:+1234567890",
        Timestamp: 1234567890,
        CommandAuthorized: true,
        SessionKey: "agent:main:main",
      } as FinalizedMsgContext;

      await triggerMessageReceived("agent:main:main", ctx);

      expect(handler).toHaveBeenCalledTimes(1);
      const event = handler.mock.calls[0][0] as InternalHookEvent;
      expect(event.type).toBe("message");
      expect(event.action).toBe("received");
      expect(event.sessionKey).toBe("agent:main:main");

      const context = event.context as MessageReceivedContext;
      expect(context.message).toBe("Hello world");
      expect(context.senderId).toBe("+1234567890");
      expect(context.channel).toBe("signal");
    });

    it("triggers both general and specific handlers", async () => {
      const generalHandler = vi.fn();
      const specificHandler = vi.fn();
      registerInternalHook("message", generalHandler);
      registerInternalHook("message:received", specificHandler);

      const ctx = {
        Body: "Test",
        SessionKey: "test-session",
      } as FinalizedMsgContext;

      await triggerMessageReceived("test-session", ctx);

      expect(generalHandler).toHaveBeenCalledTimes(1);
      expect(specificHandler).toHaveBeenCalledTimes(1);
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
