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
  resolveEffectiveInternalHookPolicy,
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
        __openclaw_internal_hook_handlers__?: Map<
          string,
          Array<
            | ((event: unknown) => unknown)
            | {
                handler: (event: unknown) => unknown;
                eventKey: string;
                hookName?: string;
              }
          >
        >;
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

    it("skips all internal hooks when effective policy is disabled for the runtime agent", async () => {
      const handler = vi.fn();
      registerInternalHook("command:new", handler, { hookName: "command-logger" });

      const cfg = {
        hooks: { internal: { enabled: true } },
        agents: {
          list: [
            {
              id: "work",
              hooks: {
                enabled: false,
              },
            },
          ],
        },
      };
      const event = createInternalHookEvent("command", "new", "work:thread-1", { cfg });

      await triggerInternalHook(event, { config: cfg, agentId: "work" });

      expect(handler).not.toHaveBeenCalled();
    });

    it("filters handlers by effective events allowlist", async () => {
      const generalHandler = vi.fn();
      const specificHandler = vi.fn();
      registerInternalHook("command", generalHandler, { hookName: "all-commands" });
      registerInternalHook("command:new", specificHandler, { hookName: "new-command" });

      const cfg = {
        hooks: { internal: { enabled: true } },
        agents: {
          list: [
            {
              id: "work",
              hooks: {
                events: ["command:new"],
              },
            },
          ],
        },
      };
      const event = createInternalHookEvent("command", "new", "work:thread-1", { cfg });

      await triggerInternalHook(event, { config: cfg, agentId: "work" });

      expect(generalHandler).not.toHaveBeenCalled();
      expect(specificHandler).toHaveBeenCalledWith(event);
    });

    it("filters handlers by effective per-hook entry policy", async () => {
      const disabledHandler = vi.fn();
      const enabledHandler = vi.fn();
      registerInternalHook("command:new", disabledHandler, { hookName: "command-logger" });
      registerInternalHook("command:new", enabledHandler, { hookName: "session-memory" });

      const cfg = {
        hooks: {
          internal: {
            enabled: true,
            entries: {
              "command-logger": { enabled: true },
            },
          },
        },
        agents: {
          defaults: {
            hooks: {
              entries: {
                "command-logger": { enabled: false },
              },
            },
          },
        },
      };
      const event = createInternalHookEvent("command", "new", "main", { cfg });

      await triggerInternalHook(event, { config: cfg, agentId: "main" });

      expect(disabledHandler).not.toHaveBeenCalled();
      expect(enabledHandler).toHaveBeenCalledWith(event);
    });
  });

  describe("resolveEffectiveInternalHookPolicy", () => {
    it("applies global baseline then defaults then agent overrides", () => {
      const cfg = {
        hooks: {
          internal: {
            enabled: true,
            events: ["command:new"],
            entries: {
              "command-logger": { enabled: true },
              "session-memory": { enabled: true },
            },
          },
        },
        agents: {
          defaults: {
            hooks: {
              events: ["message:received"],
              entries: {
                "command-logger": { enabled: false },
              },
            },
          },
          list: [
            {
              id: "work",
              hooks: {
                enabled: false,
                events: ["session:compact:after"],
                entries: {
                  "session-memory": { enabled: false },
                },
              },
            },
          ],
        },
      };

      expect(resolveEffectiveInternalHookPolicy({ config: cfg, agentId: "work" })).toEqual({
        enabled: false,
        events: ["session:compact:after"],
        entries: {
          "command-logger": { enabled: false },
          "session-memory": { enabled: false },
        },
      });
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
