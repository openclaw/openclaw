import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearInternalHooks,
  createInternalHookEvent,
  getRegisteredEventKeys,
  isAgentBootstrapEvent,
  isGatewayStartupEvent,
  isMessageReceivedEvent,
  isMessageSentEvent,
  registerInternalHook,
  triggerInternalHook,
  unregisterInternalHook,
  type AgentBootstrapHookContext,
  type GatewayStartupHookContext,
  type MessageReceivedHookContext,
  type MessageSentHookContext,
} from "./internal-hooks.js";

describe("hooks", () => {
  beforeEach(() => {
    clearInternalHooks();
  });

  afterEach(() => {
    clearInternalHooks();
  });

  describe("registerInternalHook", () => {
    it("should register a hook handler", () => {
      const handler = vi.fn();
      registerInternalHook("command:new", handler);

      const keys = getRegisteredEventKeys();
      expect(keys).toContain("command:new");
    });

    it("should allow multiple handlers for the same event", () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      registerInternalHook("command:new", handler1);
      registerInternalHook("command:new", handler2);

      const keys = getRegisteredEventKeys();
      expect(keys).toContain("command:new");
    });
  });

  describe("unregisterInternalHook", () => {
    it("should unregister a specific handler", () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      registerInternalHook("command:new", handler1);
      registerInternalHook("command:new", handler2);

      unregisterInternalHook("command:new", handler1);

      const event = createInternalHookEvent("command", "new", "test-session");
      void triggerInternalHook(event);

      expect(handler1).not.toHaveBeenCalled();
      expect(handler2).toHaveBeenCalled();
    });

    it("should clean up empty handler arrays", () => {
      const handler = vi.fn();

      registerInternalHook("command:new", handler);
      unregisterInternalHook("command:new", handler);

      const keys = getRegisteredEventKeys();
      expect(keys).not.toContain("command:new");
    });
  });

  describe("triggerInternalHook", () => {
    it("should trigger handlers for general event type", async () => {
      const handler = vi.fn();
      registerInternalHook("command", handler);

      const event = createInternalHookEvent("command", "new", "test-session");
      await triggerInternalHook(event);

      expect(handler).toHaveBeenCalledWith(event);
    });

    it("should trigger handlers for specific event action", async () => {
      const handler = vi.fn();
      registerInternalHook("command:new", handler);

      const event = createInternalHookEvent("command", "new", "test-session");
      await triggerInternalHook(event);

      expect(handler).toHaveBeenCalledWith(event);
    });

    it("should trigger both general and specific handlers", async () => {
      const generalHandler = vi.fn();
      const specificHandler = vi.fn();

      registerInternalHook("command", generalHandler);
      registerInternalHook("command:new", specificHandler);

      const event = createInternalHookEvent("command", "new", "test-session");
      await triggerInternalHook(event);

      expect(generalHandler).toHaveBeenCalledWith(event);
      expect(specificHandler).toHaveBeenCalledWith(event);
    });

    it("should handle async handlers", async () => {
      const handler = vi.fn(async () => {
        await Promise.resolve();
      });

      registerInternalHook("command:new", handler);

      const event = createInternalHookEvent("command", "new", "test-session");
      await triggerInternalHook(event);

      expect(handler).toHaveBeenCalledWith(event);
    });

    it("should catch and log errors from handlers", async () => {
      const errorHandler = vi.fn(() => {
        throw new Error("Handler failed");
      });
      const successHandler = vi.fn();

      registerInternalHook("command:new", errorHandler);
      registerInternalHook("command:new", successHandler);

      const event = createInternalHookEvent("command", "new", "test-session");
      await triggerInternalHook(event);

      expect(errorHandler).toHaveBeenCalled();
      expect(successHandler).toHaveBeenCalled();
    });

    it("should not throw if no handlers are registered", async () => {
      const event = createInternalHookEvent("command", "new", "test-session");
      await expect(triggerInternalHook(event)).resolves.not.toThrow();
    });
  });

  describe("createInternalHookEvent", () => {
    it("should create a properly formatted event", () => {
      const event = createInternalHookEvent("command", "new", "test-session", {
        foo: "bar",
      });

      expect(event.type).toBe("command");
      expect(event.action).toBe("new");
      expect(event.sessionKey).toBe("test-session");
      expect(event.context).toEqual({ foo: "bar" });
      expect(event.timestamp).toBeInstanceOf(Date);
    });

    it("should use empty context if not provided", () => {
      const event = createInternalHookEvent("command", "new", "test-session");

      expect(event.context).toEqual({});
    });
  });

  describe("isAgentBootstrapEvent", () => {
    it("returns true for agent:bootstrap events with expected context", () => {
      const context: AgentBootstrapHookContext = {
        workspaceDir: "/tmp",
        bootstrapFiles: [],
      };
      const event = createInternalHookEvent("agent", "bootstrap", "test-session", context);
      expect(isAgentBootstrapEvent(event)).toBe(true);
    });

    it("returns false for non-bootstrap events", () => {
      const event = createInternalHookEvent("command", "new", "test-session");
      expect(isAgentBootstrapEvent(event)).toBe(false);
    });
  });

  describe("isGatewayStartupEvent", () => {
    it("returns true for gateway:startup events with expected context", () => {
      const context: GatewayStartupHookContext = {
        cfg: {},
      };
      const event = createInternalHookEvent("gateway", "startup", "gateway:startup", context);
      expect(isGatewayStartupEvent(event)).toBe(true);
    });

    it("returns false for non-startup gateway events", () => {
      const event = createInternalHookEvent("gateway", "shutdown", "gateway:shutdown", {});
      expect(isGatewayStartupEvent(event)).toBe(false);
    });
  });

  describe("isMessageReceivedEvent", () => {
    it("returns true for message:received events with expected context", () => {
      const context: MessageReceivedHookContext = {
        from: "+1234567890",
        content: "Hello world",
        channelId: "whatsapp",
        conversationId: "chat-123",
        timestamp: Date.now(),
      };
      const event = createInternalHookEvent("message", "received", "test-session", context);
      expect(isMessageReceivedEvent(event)).toBe(true);
    });

    it("returns false for message:sent events", () => {
      const context: MessageSentHookContext = {
        to: "+1234567890",
        content: "Hello world",
        success: true,
        channelId: "whatsapp",
      };
      const event = createInternalHookEvent("message", "sent", "test-session", context);
      expect(isMessageReceivedEvent(event)).toBe(false);
    });
  });

  describe("isMessageSentEvent", () => {
    it("returns true for message:sent events with expected context", () => {
      const context: MessageSentHookContext = {
        to: "+1234567890",
        content: "Hello world",
        success: true,
        channelId: "telegram",
        conversationId: "chat-456",
        messageId: "msg-789",
      };
      const event = createInternalHookEvent("message", "sent", "test-session", context);
      expect(isMessageSentEvent(event)).toBe(true);
    });

    it("returns true when success is false (error case)", () => {
      const context: MessageSentHookContext = {
        to: "+1234567890",
        content: "Hello world",
        success: false,
        error: "Network error",
        channelId: "whatsapp",
      };
      const event = createInternalHookEvent("message", "sent", "test-session", context);
      expect(isMessageSentEvent(event)).toBe(true);
    });

    it("returns false for message:received events", () => {
      const context: MessageReceivedHookContext = {
        from: "+1234567890",
        content: "Hello world",
        channelId: "whatsapp",
      };
      const event = createInternalHookEvent("message", "received", "test-session", context);
      expect(isMessageSentEvent(event)).toBe(false);
    });
  });

  describe("message type-guard shared negatives", () => {
    it("returns false for non-message and missing-context shapes", () => {
      const cases: Array<{
        match: (event: ReturnType<typeof createInternalHookEvent>) => boolean;
      }> = [
        {
          match: isMessageReceivedEvent,
        },
        {
          match: isMessageSentEvent,
        },
      ];
      const nonMessageEvent = createInternalHookEvent("command", "new", "test-session");
      const missingReceivedContext = createInternalHookEvent(
        "message",
        "received",
        "test-session",
        {
          from: "+1234567890",
          // missing channelId
        },
      );
      const missingSentContext = createInternalHookEvent("message", "sent", "test-session", {
        to: "+1234567890",
        channelId: "whatsapp",
        // missing success
      });

      for (const testCase of cases) {
        expect(testCase.match(nonMessageEvent)).toBe(false);
      }
      expect(isMessageReceivedEvent(missingReceivedContext)).toBe(false);
      expect(isMessageSentEvent(missingSentContext)).toBe(false);
    });
  });

  describe("message hooks", () => {
    it("should trigger message:received handlers", async () => {
      const handler = vi.fn();
      registerInternalHook("message:received", handler);

      const context: MessageReceivedHookContext = {
        from: "+1234567890",
        content: "Hello world",
        channelId: "whatsapp",
        conversationId: "chat-123",
      };
      const event = createInternalHookEvent("message", "received", "test-session", context);
      await triggerInternalHook(event);

      expect(handler).toHaveBeenCalledWith(event);
    });

    it("should trigger message:sent handlers", async () => {
      const handler = vi.fn();
      registerInternalHook("message:sent", handler);

      const context: MessageSentHookContext = {
        to: "+1234567890",
        content: "Hello world",
        success: true,
        channelId: "telegram",
        messageId: "msg-123",
      };
      const event = createInternalHookEvent("message", "sent", "test-session", context);
      await triggerInternalHook(event);

      expect(handler).toHaveBeenCalledWith(event);
    });

    it("should trigger general message handlers for both received and sent", async () => {
      const handler = vi.fn();
      registerInternalHook("message", handler);

      const receivedContext: MessageReceivedHookContext = {
        from: "+1234567890",
        content: "Hello",
        channelId: "whatsapp",
      };
      const receivedEvent = createInternalHookEvent(
        "message",
        "received",
        "test-session",
        receivedContext,
      );
      await triggerInternalHook(receivedEvent);

      const sentContext: MessageSentHookContext = {
        to: "+1234567890",
        content: "World",
        success: true,
        channelId: "whatsapp",
      };
      const sentEvent = createInternalHookEvent("message", "sent", "test-session", sentContext);
      await triggerInternalHook(sentEvent);

      expect(handler).toHaveBeenCalledTimes(2);
      expect(handler).toHaveBeenNthCalledWith(1, receivedEvent);
      expect(handler).toHaveBeenNthCalledWith(2, sentEvent);
    });

    it("should handle hook errors without breaking message processing", async () => {
      const errorHandler = vi.fn(() => {
        throw new Error("Hook failed");
      });
      const successHandler = vi.fn();

      registerInternalHook("message:received", errorHandler);
      registerInternalHook("message:received", successHandler);

      const context: MessageReceivedHookContext = {
        from: "+1234567890",
        content: "Hello",
        channelId: "whatsapp",
      };
      const event = createInternalHookEvent("message", "received", "test-session", context);
      await triggerInternalHook(event);

      // Both handlers were called
      expect(errorHandler).toHaveBeenCalled();
      expect(successHandler).toHaveBeenCalled();
    });
  });

  describe("getRegisteredEventKeys", () => {
    it("should return all registered event keys", () => {
      registerInternalHook("command:new", vi.fn());
      registerInternalHook("command:stop", vi.fn());
      registerInternalHook("session:start", vi.fn());

      const keys = getRegisteredEventKeys();
      expect(keys).toContain("command:new");
      expect(keys).toContain("command:stop");
      expect(keys).toContain("session:start");
    });

    it("should return empty array when no handlers are registered", () => {
      const keys = getRegisteredEventKeys();
      expect(keys).toEqual([]);
    });
  });

  describe("clearInternalHooks", () => {
    it("should remove all registered handlers", () => {
      registerInternalHook("command:new", vi.fn());
      registerInternalHook("command:stop", vi.fn());

      clearInternalHooks();

      const keys = getRegisteredEventKeys();
      expect(keys).toEqual([]);
    });
  });
});
