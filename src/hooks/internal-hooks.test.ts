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

    it("stores handlers in the global singleton registry", async () => {
      const globalHooks = globalThis as typeof globalThis & {
        __openclaw_internal_hook_handlers__?: Map<string, Array<(event: unknown) => unknown>>;
      };
      const handler = vi.fn();
      registerInternalHook("command:new", handler);

      const event = createInternalHookEvent("command", "new", "test-session");
      await triggerInternalHook(event);

      expect(handler).toHaveBeenCalledWith(event);
      expect(globalHooks.__openclaw_internal_hook_handlers__?.has("command:new")).toBe(true);

      const injectedHandler = vi.fn();
      globalHooks.__openclaw_internal_hook_handlers__?.set("command:new", [injectedHandler]);
      await triggerInternalHook(event);
      expect(injectedHandler).toHaveBeenCalledWith(event);
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
    const cases: Array<{
      name: string;
      event: ReturnType<typeof createInternalHookEvent>;
      expected: boolean;
    }> = [
      {
        name: "returns true for agent:bootstrap events with expected context",
        event: createInternalHookEvent("agent", "bootstrap", "test-session", {
          workspaceDir: "/tmp",
          bootstrapFiles: [],
        } satisfies AgentBootstrapHookContext),
        expected: true,
      },
      {
        name: "returns false for non-bootstrap events",
        event: createInternalHookEvent("command", "new", "test-session"),
        expected: false,
      },
    ];

    for (const testCase of cases) {
      it(testCase.name, () => {
        expect(isAgentBootstrapEvent(testCase.event)).toBe(testCase.expected);
      });
    }
  });

  describe("isGatewayStartupEvent", () => {
    const cases: Array<{
      name: string;
      event: ReturnType<typeof createInternalHookEvent>;
      expected: boolean;
    }> = [
      {
        name: "returns true for gateway:startup events with expected context",
        event: createInternalHookEvent("gateway", "startup", "gateway:startup", {
          cfg: {},
        } satisfies GatewayStartupHookContext),
        expected: true,
      },
      {
        name: "returns false for non-startup gateway events",
        event: createInternalHookEvent("gateway", "shutdown", "gateway:shutdown", {}),
        expected: false,
      },
    ];

    for (const testCase of cases) {
      it(testCase.name, () => {
        expect(isGatewayStartupEvent(testCase.event)).toBe(testCase.expected);
      });
    }
  });

  describe("isMessageReceivedEvent", () => {
    const cases: Array<{
      name: string;
      event: ReturnType<typeof createInternalHookEvent>;
      expected: boolean;
    }> = [
      {
        name: "returns true for message:received events with expected context",
        event: createInternalHookEvent("message", "received", "test-session", {
          from: "+1234567890",
          content: "Hello world",
          channelId: "whatsapp",
          conversationId: "chat-123",
          timestamp: Date.now(),
        } satisfies MessageReceivedHookContext),
        expected: true,
      },
      {
        name: "returns false for message:sent events",
        event: createInternalHookEvent("message", "sent", "test-session", {
          to: "+1234567890",
          content: "Hello world",
          success: true,
          channelId: "whatsapp",
        } satisfies MessageSentHookContext),
        expected: false,
      },
    ];

    for (const testCase of cases) {
      it(testCase.name, () => {
        expect(isMessageReceivedEvent(testCase.event)).toBe(testCase.expected);
      });
    }
  });

  describe("isMessageSentEvent", () => {
    const cases: Array<{
      name: string;
      event: ReturnType<typeof createInternalHookEvent>;
      expected: boolean;
    }> = [
      {
        name: "returns true for message:sent events with expected context",
        event: createInternalHookEvent("message", "sent", "test-session", {
          to: "+1234567890",
          content: "Hello world",
          success: true,
          channelId: "telegram",
          conversationId: "chat-456",
          messageId: "msg-789",
        } satisfies MessageSentHookContext),
        expected: true,
      },
      {
        name: "returns true when success is false (error case)",
        event: createInternalHookEvent("message", "sent", "test-session", {
          to: "+1234567890",
          content: "Hello world",
          success: false,
          error: "Network error",
          channelId: "whatsapp",
        } satisfies MessageSentHookContext),
        expected: true,
      },
      {
        name: "returns false for message:received events",
        event: createInternalHookEvent("message", "received", "test-session", {
          from: "+1234567890",
          content: "Hello world",
          channelId: "whatsapp",
        } satisfies MessageReceivedHookContext),
        expected: false,
      },
    ];

    for (const testCase of cases) {
      it(testCase.name, () => {
        expect(isMessageSentEvent(testCase.event)).toBe(testCase.expected);
      });
    }
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

  describe("postHookActions", () => {
    it("executes post-hook actions after all handlers complete", async () => {
      const order: string[] = [];

      registerInternalHook("command:new", async (event) => {
        order.push("handler-1");
        event.postHookActions.push(async () => {
          order.push("post-action-1");
        });
      });

      registerInternalHook("command:new", async () => {
        order.push("handler-2");
      });

      const event = createInternalHookEvent("command", "new", "test-session");
      await triggerInternalHook(event);

      expect(order).toEqual(["handler-1", "handler-2", "post-action-1"]);
    });

    it("post-hook actions see context set by later handlers", async () => {
      let sawFlag = false;

      registerInternalHook("command:new", async (event) => {
        event.postHookActions.push(async () => {
          sawFlag = event.context.myFlag === true;
        });
      });

      registerInternalHook("command:new", async (event) => {
        event.context.myFlag = true;
      });

      const event = createInternalHookEvent("command", "new", "test-session");
      await triggerInternalHook(event);

      expect(sawFlag).toBe(true);
    });

    it("post-hook action errors don't prevent other post-hook actions", async () => {
      const executed: string[] = [];

      registerInternalHook("command:new", async (event) => {
        event.postHookActions.push(async () => {
          throw new Error("boom");
        });
        event.postHookActions.push(async () => {
          executed.push("second-action");
        });
      });

      const event = createInternalHookEvent("command", "new", "test-session");
      await triggerInternalHook(event);

      expect(executed).toEqual(["second-action"]);
    });

    it("multiple handlers can push post-hook actions; all execute in order", async () => {
      const order: string[] = [];

      registerInternalHook("command:new", async (event) => {
        event.postHookActions.push(() => {
          order.push("from-handler-1");
        });
      });

      registerInternalHook("command:new", async (event) => {
        event.postHookActions.push(() => {
          order.push("from-handler-2");
        });
      });

      const event = createInternalHookEvent("command", "new", "test-session");
      await triggerInternalHook(event);

      expect(order).toEqual(["from-handler-1", "from-handler-2"]);
    });

    it("initializes postHookActions as empty array", () => {
      const event = createInternalHookEvent("command", "new", "test-session");
      expect(event.postHookActions).toEqual([]);
    });

    it("does not run post-hook actions when no handlers are registered", async () => {
      const event = createInternalHookEvent("command", "new", "test-session");
      event.postHookActions.push(() => {
        throw new Error("should not run");
      });
      // triggerInternalHook returns early when no handlers — post-hooks don't run
      await expect(triggerInternalHook(event)).resolves.not.toThrow();
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
