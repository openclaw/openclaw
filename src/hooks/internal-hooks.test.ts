import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearInternalHooks,
  createInternalHookEvent,
  getRegisteredEventKeys,
  isAgentBootstrapEvent,
  isAgentPreRunEvent,
  isMessageReceivedEvent,
  isMessageSentEvent,
  isSessionPreSpawnEvent,
  registerInternalHook,
  triggerInternalHook,
  unregisterInternalHook,
  type AgentBootstrapHookContext,
  type AgentPreRunHookContext,
  type MessageReceivedHookContext,
  type MessageSentHookContext,
  type SessionPreSpawnHookContext,
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
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
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
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining("Hook error"),
        expect.stringContaining("Handler failed"),
      );

      consoleError.mockRestore();
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

    it("returns false for non-message events", () => {
      const event = createInternalHookEvent("command", "new", "test-session");
      expect(isMessageReceivedEvent(event)).toBe(false);
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

    it("returns false when context is missing required fields", () => {
      const event = createInternalHookEvent("message", "received", "test-session", {
        from: "+1234567890",
        // missing channelId
      });
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

    it("returns false for non-message events", () => {
      const event = createInternalHookEvent("command", "new", "test-session");
      expect(isMessageSentEvent(event)).toBe(false);
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

    it("returns false when context is missing required fields", () => {
      const event = createInternalHookEvent("message", "sent", "test-session", {
        to: "+1234567890",
        channelId: "whatsapp",
        // missing success
      });
      expect(isMessageSentEvent(event)).toBe(false);
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
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
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
      // Error was logged but didn't prevent second handler
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining("Hook error"),
        expect.stringContaining("Hook failed"),
      );

      consoleError.mockRestore();
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

  describe("isSessionPreSpawnEvent", () => {
    it("returns true for session:pre-spawn events", () => {
      const context: SessionPreSpawnHookContext = {
        agentId: "coder",
        model: "claude-sonnet-4-20250514",
        thinking: "high",
        task: "Fix bug",
        requesterSessionKey: "agent:main:main",
      };
      const event = createInternalHookEvent("session", "pre-spawn", "test-session", context);
      expect(isSessionPreSpawnEvent(event)).toBe(true);
    });

    it("returns true even with minimal context (all fields optional)", () => {
      const context: SessionPreSpawnHookContext = {};
      const event = createInternalHookEvent("session", "pre-spawn", "test-session", context);
      expect(isSessionPreSpawnEvent(event)).toBe(true);
    });

    it("returns false for non-session events", () => {
      const event = createInternalHookEvent("command", "new", "test-session");
      expect(isSessionPreSpawnEvent(event)).toBe(false);
    });

    it("returns false for session events with different action", () => {
      const event = createInternalHookEvent("session", "start", "test-session");
      expect(isSessionPreSpawnEvent(event)).toBe(false);
    });
  });

  describe("isAgentPreRunEvent", () => {
    it("returns true for agent:pre-run events with expected context", () => {
      const context: AgentPreRunHookContext = {
        agentId: "researcher",
        sessionKey: "agent:researcher:main",
        model: "gpt-4o",
        thinking: "low",
      };
      const event = createInternalHookEvent("agent", "pre-run", "test-session", context);
      expect(isAgentPreRunEvent(event)).toBe(true);
    });

    it("returns true even with minimal context (all fields optional)", () => {
      const context: AgentPreRunHookContext = {};
      const event = createInternalHookEvent("agent", "pre-run", "test-session", context);
      expect(isAgentPreRunEvent(event)).toBe(true);
    });

    it("returns false for non-agent events", () => {
      const event = createInternalHookEvent("command", "new", "test-session");
      expect(isAgentPreRunEvent(event)).toBe(false);
    });

    it("returns false for agent:bootstrap events", () => {
      const context: AgentBootstrapHookContext = {
        workspaceDir: "/tmp",
        bootstrapFiles: [],
      };
      const event = createInternalHookEvent("agent", "bootstrap", "test-session", context);
      expect(isAgentPreRunEvent(event)).toBe(false);
    });
  });

  describe("session:pre-spawn hooks", () => {
    it("should trigger session:pre-spawn handlers", async () => {
      const handler = vi.fn();
      registerInternalHook("session:pre-spawn", handler);

      const context: SessionPreSpawnHookContext = {
        agentId: "coder",
        model: "claude-sonnet-4-20250514",
        thinking: "high",
        task: "Implement feature",
        requesterSessionKey: "agent:main:main",
      };
      const event = createInternalHookEvent("session", "pre-spawn", "test-session", context);
      await triggerInternalHook(event);

      expect(handler).toHaveBeenCalledWith(event);
    });

    it("should allow hooks to mutate context fields", async () => {
      const handler = vi.fn((event) => {
        const ctx = event.context as SessionPreSpawnHookContext;
        ctx.model = "gpt-4o";
        ctx.thinking = "low";
        ctx.fallbackModel = "claude-haiku";
      });
      registerInternalHook("session:pre-spawn", handler);

      const context: SessionPreSpawnHookContext = {
        agentId: "researcher",
        model: "claude-sonnet-4-20250514",
        thinking: "high",
      };
      const event = createInternalHookEvent("session", "pre-spawn", "test-session", context);
      await triggerInternalHook(event);

      expect(handler).toHaveBeenCalled();
      const mutatedContext = event.context as SessionPreSpawnHookContext;
      expect(mutatedContext.model).toBe("gpt-4o");
      expect(mutatedContext.thinking).toBe("low");
      expect(mutatedContext.fallbackModel).toBe("claude-haiku");
    });
  });

  describe("agent:pre-run hooks", () => {
    it("should trigger agent:pre-run handlers", async () => {
      const handler = vi.fn();
      registerInternalHook("agent:pre-run", handler);

      const context: AgentPreRunHookContext = {
        agentId: "writer",
        sessionKey: "agent:writer:main",
        model: "claude-opus-4-20250514",
        thinking: "high",
      };
      const event = createInternalHookEvent("agent", "pre-run", "test-session", context);
      await triggerInternalHook(event);

      expect(handler).toHaveBeenCalledWith(event);
    });

    it("should allow hooks to mutate model and thinking", async () => {
      const handler = vi.fn((event) => {
        const ctx = event.context as AgentPreRunHookContext;
        ctx.model = "gpt-4o";
        ctx.thinking = "off";
      });
      registerInternalHook("agent:pre-run", handler);

      const context: AgentPreRunHookContext = {
        agentId: "helper",
        model: "claude-sonnet-4-20250514",
        thinking: "high",
      };
      const event = createInternalHookEvent("agent", "pre-run", "test-session", context);
      await triggerInternalHook(event);

      expect(handler).toHaveBeenCalled();
      const mutatedContext = event.context as AgentPreRunHookContext;
      expect(mutatedContext.model).toBe("gpt-4o");
      expect(mutatedContext.thinking).toBe("off");
    });

    it("should trigger general agent handlers for pre-run", async () => {
      const generalHandler = vi.fn();
      const specificHandler = vi.fn();

      registerInternalHook("agent", generalHandler);
      registerInternalHook("agent:pre-run", specificHandler);

      const context: AgentPreRunHookContext = {
        agentId: "coder",
        model: "claude-sonnet-4-20250514",
      };
      const event = createInternalHookEvent("agent", "pre-run", "test-session", context);
      await triggerInternalHook(event);

      expect(generalHandler).toHaveBeenCalledWith(event);
      expect(specificHandler).toHaveBeenCalledWith(event);
    });
  });
