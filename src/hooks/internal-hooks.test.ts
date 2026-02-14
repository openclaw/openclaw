import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearInternalHooks,
  createInternalHookEvent,
  getRegisteredEventKeys,
  isAgentBootstrapEvent,
  registerInternalHook,
  triggerInternalHook,
  unregisterInternalHook,
  type AgentBootstrapHookContext,
  type InternalHookEvent,
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
        await new Promise((resolve) => setTimeout(resolve, 10));
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

  describe("integration", () => {
    it("should handle a complete hook lifecycle", async () => {
      const results: InternalHookEvent[] = [];
      const handler = vi.fn((event: InternalHookEvent) => {
        results.push(event);
      });

      // Register
      registerInternalHook("command:new", handler);

      // Trigger
      const event1 = createInternalHookEvent("command", "new", "session-1");
      await triggerInternalHook(event1);

      const event2 = createInternalHookEvent("command", "new", "session-2");
      await triggerInternalHook(event2);

      // Verify
      expect(results).toHaveLength(2);
      expect(results[0].sessionKey).toBe("session-1");
      expect(results[1].sessionKey).toBe("session-2");

      // Unregister
      unregisterInternalHook("command:new", handler);

      // Trigger again - should not call handler
      const event3 = createInternalHookEvent("command", "new", "session-3");
      await triggerInternalHook(event3);

      expect(results).toHaveLength(2);
    });
  });

  describe("message lifecycle hooks", () => {
    describe("message:received", () => {
      it("fires with correct event shape", async () => {
        const handler = vi.fn();
        registerInternalHook("message:received", handler);

        const event = createInternalHookEvent("message", "received", "sess-1", {
          from: "+1234567890",
          content: "hello world",
          channel: "telegram",
          senderId: "user-123",
          senderName: "Alice",
          commandSource: "telegram",
        });
        await triggerInternalHook(event);

        expect(handler).toHaveBeenCalledOnce();
        const calledEvent = handler.mock.calls[0][0] as InternalHookEvent;
        expect(calledEvent.type).toBe("message");
        expect(calledEvent.action).toBe("received");
        expect(calledEvent.sessionKey).toBe("sess-1");
        expect(calledEvent.context).toEqual({
          from: "+1234567890",
          content: "hello world",
          channel: "telegram",
          senderId: "user-123",
          senderName: "Alice",
          commandSource: "telegram",
        });
        expect(calledEvent.timestamp).toBeInstanceOf(Date);
      });

      it("does not fire when no hooks are registered for message:received", async () => {
        const handler = vi.fn();
        registerInternalHook("command:new", handler);

        const event = createInternalHookEvent("message", "received", "sess-1", {
          from: "user",
          content: "hello",
        });
        await triggerInternalHook(event);

        expect(handler).not.toHaveBeenCalled();
      });
    });

    describe("message:before", () => {
      it("returns and merges prependContext and systemPrompt", async () => {
        registerInternalHook("message:before", () => ({
          prependContext: "context from hook A",
          systemPrompt: "system prompt A",
        }));
        registerInternalHook("message:before", () => ({
          prependContext: "context from hook B",
          systemPrompt: "system prompt B",
        }));

        const event = createInternalHookEvent("message", "before", "sess-1", {
          prompt: "user message",
          messages: [],
          agentId: "agent-main",
          sessionId: "sid-1",
          commandSource: "telegram",
        });
        const result = await triggerInternalHook(event);

        expect(result?.prependContext).toBe("context from hook A\n\ncontext from hook B");
        expect(result?.systemPrompt).toBe("system prompt B");
      });

      it("returns undefined when no hooks are registered (no-op)", async () => {
        const event = createInternalHookEvent("message", "before", "sess-1", {
          prompt: "user message",
          messages: [],
        });
        const result = await triggerInternalHook(event);

        expect(result).toBeUndefined();
      });

      it("does not fire when no hooks are registered for message:before", async () => {
        const handler = vi.fn();
        registerInternalHook("message:received", handler);

        const event = createInternalHookEvent("message", "before", "sess-1", {
          prompt: "user message",
        });
        await triggerInternalHook(event);

        expect(handler).not.toHaveBeenCalled();
      });
    });

    describe("message:sent", () => {
      it("fires with correct event shape", async () => {
        const handler = vi.fn();
        registerInternalHook("message:sent", handler);

        const event = createInternalHookEvent("message", "sent", "sess-1", {
          messages: [
            { role: "user", content: "hi" },
            { role: "assistant", content: "hello" },
          ],
          sessionId: "sid-1",
          success: true,
        });
        await triggerInternalHook(event);

        expect(handler).toHaveBeenCalledOnce();
        const calledEvent = handler.mock.calls[0][0] as InternalHookEvent;
        expect(calledEvent.type).toBe("message");
        expect(calledEvent.action).toBe("sent");
        expect(calledEvent.sessionKey).toBe("sess-1");
        expect(calledEvent.context).toEqual({
          messages: [
            { role: "user", content: "hi" },
            { role: "assistant", content: "hello" },
          ],
          sessionId: "sid-1",
          success: true,
        });
        expect(calledEvent.timestamp).toBeInstanceOf(Date);
      });

      it("does not fire when no hooks are registered for message:sent", async () => {
        const handler = vi.fn();
        registerInternalHook("message:received", handler);

        const event = createInternalHookEvent("message", "sent", "sess-1", {
          messages: [],
          sessionId: "sid-1",
          success: true,
        });
        await triggerInternalHook(event);

        expect(handler).not.toHaveBeenCalled();
      });
    });
  });

  describe("triggerInternalHook result merging", () => {
    it("returns undefined when no handlers are registered", async () => {
      const event = createInternalHookEvent("message", "before", "sess-1");
      const result = await triggerInternalHook(event);
      expect(result).toBeUndefined();
    });

    it("returns result when handler returns prependContext", async () => {
      registerInternalHook("message:before", () => ({
        prependContext: "extra context",
      }));
      const event = createInternalHookEvent("message", "before", "sess-1");
      const result = await triggerInternalHook(event);
      expect(result).toEqual({ prependContext: "extra context" });
    });

    it("merges multiple prependContext values with newlines", async () => {
      registerInternalHook("message:before", () => ({
        prependContext: "first",
      }));
      registerInternalHook("message:before", () => ({
        prependContext: "second",
      }));
      const event = createInternalHookEvent("message", "before", "sess-1");
      const result = await triggerInternalHook(event);
      expect(result?.prependContext).toBe("first\n\nsecond");
    });

    it("last systemPrompt wins", async () => {
      registerInternalHook("message:before", () => ({
        systemPrompt: "prompt-a",
      }));
      registerInternalHook("message:before", () => ({
        systemPrompt: "prompt-b",
      }));
      const event = createInternalHookEvent("message", "before", "sess-1");
      const result = await triggerInternalHook(event);
      expect(result?.systemPrompt).toBe("prompt-b");
    });

    it("ignores void/undefined returns from handlers", async () => {
      registerInternalHook("message:before", () => undefined);
      registerInternalHook("message:before", () => ({
        prependContext: "only this",
      }));
      registerInternalHook("message:before", () => {});
      const event = createInternalHookEvent("message", "before", "sess-1");
      const result = await triggerInternalHook(event);
      expect(result).toEqual({ prependContext: "only this" });
    });

    it("works with message event type across type and action handlers", async () => {
      registerInternalHook("message", async () => ({
        prependContext: "from type handler",
      }));
      registerInternalHook("message:received", async () => ({
        prependContext: "from action handler",
      }));
      const event = createInternalHookEvent("message", "received", "sess-1", {
        from: "user",
        content: "hello",
      });
      const result = await triggerInternalHook(event);
      expect(result?.prependContext).toBe("from type handler\n\nfrom action handler");
    });
  });
});
