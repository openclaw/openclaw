import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearInternalHooks,
  createInternalHookEvent,
  registerInternalHook,
  triggerInternalHook,
  type InternalHookEvent,
} from "./internal-hooks.js";

describe("message hooks", () => {
  beforeEach(() => {
    clearInternalHooks();
  });

  afterEach(() => {
    clearInternalHooks();
  });

  describe("message:received", () => {
    it("should trigger handler registered for message:received", async () => {
      const handler = vi.fn();
      registerInternalHook("message:received", handler);

      const event = createInternalHookEvent("message", "received", "session-1", {
        from: "user:123",
        to: "bot:456",
        content: "Hello world",
        channelId: "telegram",
        senderId: "123",
        senderName: "Eric",
        senderUsername: "eric_lytle",
      });
      await triggerInternalHook(event);

      expect(handler).toHaveBeenCalledOnce();
      expect(handler.mock.calls[0][0].type).toBe("message");
      expect(handler.mock.calls[0][0].action).toBe("received");
      expect(handler.mock.calls[0][0].context.content).toBe("Hello world");
      expect(handler.mock.calls[0][0].context.channelId).toBe("telegram");
      expect(handler.mock.calls[0][0].context.senderName).toBe("Eric");
    });

    it("should include sender and message metadata in context", async () => {
      const handler = vi.fn();
      registerInternalHook("message:received", handler);

      const event = createInternalHookEvent("message", "received", "session-1", {
        from: "signal:+15551234567",
        to: "bot:+15559876543",
        content: "Test message",
        channelId: "signal",
        conversationId: "conv-abc",
        messageId: "msg-xyz",
        senderId: "sender-1",
        senderName: "Test User",
        senderUsername: "testuser",
        senderE164: "+15551234567",
        provider: "signal",
        surface: "signal",
        threadId: "thread-1",
        originatingChannel: "signal",
        originatingTo: "bot:+15559876543",
        timestamp: 1707600000,
      });
      await triggerInternalHook(event);

      const ctx = handler.mock.calls[0][0].context;
      expect(ctx.messageId).toBe("msg-xyz");
      expect(ctx.senderId).toBe("sender-1");
      expect(ctx.senderE164).toBe("+15551234567");
      expect(ctx.threadId).toBe("thread-1");
      expect(ctx.timestamp).toBe(1707600000);
    });
  });

  describe("message:transcribed", () => {
    it("should trigger handler registered for message:transcribed", async () => {
      const handler = vi.fn();
      registerInternalHook("message:transcribed", handler);

      const event = createInternalHookEvent("message", "transcribed", "session-1", {
        from: "user:123",
        to: "bot:456",
        transcript: "This is what the user said",
        body: "🎤 Audio message",
        channelId: "telegram",
        mediaPath: "/tmp/audio.ogg",
        mediaType: "audio/ogg",
      });
      await triggerInternalHook(event);

      expect(handler).toHaveBeenCalledOnce();
      expect(handler.mock.calls[0][0].action).toBe("transcribed");
      expect(handler.mock.calls[0][0].context.transcript).toBe("This is what the user said");
      expect(handler.mock.calls[0][0].context.mediaType).toBe("audio/ogg");
    });

    it("should include both raw body and transcript in context", async () => {
      const handler = vi.fn();
      registerInternalHook("message:transcribed", handler);

      const event = createInternalHookEvent("message", "transcribed", "session-1", {
        body: "🎤 [Audio]",
        bodyForAgent: "[Audio] Transcript: Hello from voice",
        transcript: "Hello from voice",
        channelId: "telegram",
      });
      await triggerInternalHook(event);

      const ctx = handler.mock.calls[0][0].context;
      expect(ctx.body).toBe("🎤 [Audio]");
      expect(ctx.bodyForAgent).toBe("[Audio] Transcript: Hello from voice");
      expect(ctx.transcript).toBe("Hello from voice");
    });
  });

  describe("message:preprocessed", () => {
    it("should trigger handler registered for message:preprocessed", async () => {
      const handler = vi.fn();
      registerInternalHook("message:preprocessed", handler);

      const event = createInternalHookEvent("message", "preprocessed", "session-1", {
        from: "user:123",
        to: "bot:456",
        body: "Check out this link",
        bodyForAgent: "Check out this link\n[Link summary: Article about testing]",
        channelId: "telegram",
        senderId: "123",
        senderName: "Eric",
        isGroup: false,
      });
      await triggerInternalHook(event);

      expect(handler).toHaveBeenCalledOnce();
      expect(handler.mock.calls[0][0].action).toBe("preprocessed");
      expect(handler.mock.calls[0][0].context.bodyForAgent).toContain("Link summary");
    });

    it("should include both transcript and link summary for enriched audio messages", async () => {
      const handler = vi.fn();
      registerInternalHook("message:preprocessed", handler);

      const event = createInternalHookEvent("message", "preprocessed", "session-1", {
        body: "🎤 [Audio]",
        bodyForAgent: "[Audio] Transcript: Check https://example.com\n[Link summary: Example site]",
        transcript: "Check https://example.com",
        channelId: "telegram",
        mediaType: "audio/ogg",
        isGroup: false,
      });
      await triggerInternalHook(event);

      const ctx = handler.mock.calls[0][0].context;
      expect(ctx.transcript).toBe("Check https://example.com");
      expect(ctx.bodyForAgent).toContain("Link summary");
      expect(ctx.bodyForAgent).toContain("Transcript:");
    });

    it("should fire for plain text messages without media", async () => {
      const handler = vi.fn();
      registerInternalHook("message:preprocessed", handler);

      const event = createInternalHookEvent("message", "preprocessed", "session-1", {
        body: "Just a text message",
        bodyForAgent: "Just a text message",
        channelId: "signal",
        isGroup: false,
      });
      await triggerInternalHook(event);

      expect(handler).toHaveBeenCalledOnce();
      const ctx = handler.mock.calls[0][0].context;
      expect(ctx.transcript).toBeUndefined();
      expect(ctx.mediaType).toBeUndefined();
      expect(ctx.body).toBe("Just a text message");
    });
  });

  describe("message:sent", () => {
    it("should trigger handler registered for message:sent", async () => {
      const handler = vi.fn();
      registerInternalHook("message:sent", handler);

      const event = createInternalHookEvent("message", "sent", "session-1", {
        from: "bot:456",
        to: "user:123",
        content: "Here is my reply",
        channelId: "telegram",
        provider: "telegram",
      });
      await triggerInternalHook(event);

      expect(handler).toHaveBeenCalledOnce();
      expect(handler.mock.calls[0][0].action).toBe("sent");
      expect(handler.mock.calls[0][0].context.content).toBe("Here is my reply");
    });

    it("should include channel and routing context", async () => {
      const handler = vi.fn();
      registerInternalHook("message:sent", handler);

      const event = createInternalHookEvent("message", "sent", "session-1", {
        from: "bot:456",
        to: "user:123",
        content: "Reply text",
        channelId: "discord",
        conversationId: "channel:C123",
        provider: "discord",
        surface: "discord",
        threadId: "thread-abc",
        originatingChannel: "discord",
        originatingTo: "channel:C123",
      });
      await triggerInternalHook(event);

      const ctx = handler.mock.calls[0][0].context;
      expect(ctx.channelId).toBe("discord");
      expect(ctx.conversationId).toBe("channel:C123");
      expect(ctx.threadId).toBe("thread-abc");
    });
  });

  describe("general message handler", () => {
    it("should receive all message event types (received, transcribed, preprocessed, sent)", async () => {
      const events: InternalHookEvent[] = [];
      registerInternalHook("message", (event) => {
        events.push(event);
      });

      await triggerInternalHook(
        createInternalHookEvent("message", "received", "s1", { content: "hi" }),
      );
      await triggerInternalHook(
        createInternalHookEvent("message", "transcribed", "s1", { transcript: "hello" }),
      );
      await triggerInternalHook(
        createInternalHookEvent("message", "preprocessed", "s1", {
          body: "hello",
          bodyForAgent: "hello",
        }),
      );
      await triggerInternalHook(
        createInternalHookEvent("message", "sent", "s1", { content: "reply" }),
      );

      expect(events).toHaveLength(4);
      expect(events[0].action).toBe("received");
      expect(events[1].action).toBe("transcribed");
      expect(events[2].action).toBe("preprocessed");
      expect(events[3].action).toBe("sent");
    });

    it("should trigger both general and specific handlers for same event", async () => {
      const generalHandler = vi.fn();
      const specificHandler = vi.fn();

      registerInternalHook("message", generalHandler);
      registerInternalHook("message:received", specificHandler);

      const event = createInternalHookEvent("message", "received", "s1", { content: "test" });
      await triggerInternalHook(event);

      expect(generalHandler).toHaveBeenCalledOnce();
      expect(specificHandler).toHaveBeenCalledOnce();
    });

    it("should not trigger message:sent handler for message:received events", async () => {
      const sentHandler = vi.fn();
      registerInternalHook("message:sent", sentHandler);

      await triggerInternalHook(
        createInternalHookEvent("message", "received", "s1", { content: "hi" }),
      );

      expect(sentHandler).not.toHaveBeenCalled();
    });
  });

  describe("error isolation", () => {
    it("should not propagate handler errors to caller", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      const badHandler = vi.fn(() => {
        throw new Error("Hook exploded");
      });
      registerInternalHook("message:received", badHandler);

      const event = createInternalHookEvent("message", "received", "s1", { content: "test" });
      await expect(triggerInternalHook(event)).resolves.not.toThrow();

      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining("Hook error"),
        expect.stringContaining("Hook exploded"),
      );
      consoleError.mockRestore();
    });

    it("should continue running subsequent handlers after one fails", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      const failHandler = vi.fn(() => {
        throw new Error("First handler fails");
      });
      const successHandler = vi.fn();

      registerInternalHook("message:received", failHandler);
      registerInternalHook("message:received", successHandler);

      await triggerInternalHook(
        createInternalHookEvent("message", "received", "s1", { content: "test" }),
      );

      expect(failHandler).toHaveBeenCalled();
      expect(successHandler).toHaveBeenCalled();
      consoleError.mockRestore();
    });

    it("should isolate async handler errors", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      const asyncFailHandler = vi.fn(async () => {
        throw new Error("Async hook failed");
      });
      registerInternalHook("message:sent", asyncFailHandler);

      await expect(
        triggerInternalHook(createInternalHookEvent("message", "sent", "s1", { content: "reply" })),
      ).resolves.not.toThrow();

      consoleError.mockRestore();
    });
  });

  describe("event structure", () => {
    it("should include timestamp on all message events", async () => {
      const handler = vi.fn();
      registerInternalHook("message", handler);

      const before = new Date();
      await triggerInternalHook(
        createInternalHookEvent("message", "received", "s1", { content: "hi" }),
      );
      const after = new Date();

      const event = handler.mock.calls[0][0] as InternalHookEvent;
      expect(event.timestamp).toBeInstanceOf(Date);
      expect(event.timestamp.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(event.timestamp.getTime()).toBeLessThanOrEqual(after.getTime());
    });

    it("should include messages array for hook responses", async () => {
      const handler = vi.fn((event: InternalHookEvent) => {
        event.messages.push("Echo: received your message");
      });
      registerInternalHook("message:received", handler);

      const event = createInternalHookEvent("message", "received", "s1", { content: "hello" });
      await triggerInternalHook(event);

      expect(event.messages).toContain("Echo: received your message");
    });

    it("should preserve sessionKey across event lifecycle", async () => {
      const events: InternalHookEvent[] = [];
      registerInternalHook("message", (e) => events.push(e));

      await triggerInternalHook(
        createInternalHookEvent("message", "received", "agent:main:telegram:abc", {
          content: "hi",
        }),
      );
      await triggerInternalHook(
        createInternalHookEvent("message", "sent", "agent:main:telegram:abc", {
          content: "reply",
        }),
      );

      expect(events[0].sessionKey).toBe("agent:main:telegram:abc");
      expect(events[1].sessionKey).toBe("agent:main:telegram:abc");
    });
  });
});
