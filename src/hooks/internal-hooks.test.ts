// Internal hook tests cover dispatch for command, session, agent, and gateway hooks.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  clearInternalHooks,
  createInternalHookEvent,
  getRegisteredEventKeys,
  isAgentBootstrapEvent,
  isGatewayStartupEvent,
  isMessageReceivedEvent,
  isMessageSentEvent,
  registerInternalHook,
  setInternalHooksEnabled,
  triggerInternalHook,
  triggerInternalHookWithCycleGuard,
  unregisterInternalHook,
  type AgentBootstrapHookContext,
  type GatewayStartupHookContext,
  type MessageReceivedHookContext,
  type MessageSentHookContext,
} from "./internal-hooks.js";

const INTERNAL_HOOK_HANDLERS_KEY = Symbol.for("openclaw.internalHookHandlers");

describe("hooks", () => {
  beforeEach(() => {
    clearInternalHooks();
    setInternalHooksEnabled(true);
  });

  afterEach(() => {
    clearInternalHooks();
    setInternalHooksEnabled(true);
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

    it("resolves when no handlers are registered", async () => {
      const event = createInternalHookEvent("command", "new", "test-session");
      await expect(triggerInternalHook(event)).resolves.toBeUndefined();
    });

    it("skips hook execution when internal hooks are disabled", async () => {
      const handler = vi.fn();
      registerInternalHook("command:new", handler);
      setInternalHooksEnabled(false);

      await triggerInternalHook(createInternalHookEvent("command", "new", "test-session"));

      expect(handler).not.toHaveBeenCalled();
    });

    it("stores handlers in the global singleton registry", async () => {
      const globalHooks = resolveGlobalSingleton<Map<string, Array<(event: unknown) => unknown>>>(
        INTERNAL_HOOK_HANDLERS_KEY,
        () => new Map<string, Array<(event: unknown) => unknown>>(),
      );
      const handler = vi.fn();
      registerInternalHook("command:new", handler);

      const event = createInternalHookEvent("command", "new", "test-session");
      await triggerInternalHook(event);

      expect(handler).toHaveBeenCalledWith(event);
      expect(globalHooks.has("command:new")).toBe(true);

      const injectedHandler = vi.fn();
      globalHooks.set("command:new", [injectedHandler]);
      await triggerInternalHook(event);
      expect(injectedHandler).toHaveBeenCalledWith(event);
    });
  });

  describe("triggerInternalHookWithCycleGuard", () => {
    // The cycle guard is opt-in: only the proven recursive producers
    // (`command:new`, `agent:bootstrap`) call this function. The shared
    // dispatcher (`triggerInternalHook`) keeps its "unconditional delivery"
    // contract for every other event/call site.

    it("should prevent re-entrant triggers within the same handler chain", async () => {
      const callCount = { value: 0 };
      const reentrantHandler = vi.fn(async () => {
        callCount.value++;
        // Simulate a re-entrant trigger through the same guarded producer.
        if (callCount.value < 5) {
          const event = createInternalHookEvent("command", "new", "test-session");
          await triggerInternalHookWithCycleGuard(event);
        }
      });

      registerInternalHook("command:new", reentrantHandler);

      const event = createInternalHookEvent("command", "new", "test-session");
      await triggerInternalHookWithCycleGuard(event);

      // The handler should only be called once; re-entrant calls are blocked
      expect(reentrantHandler).toHaveBeenCalledTimes(1);
    });

    it("should allow sequential triggers after the first completes", async () => {
      const handler = vi.fn();
      registerInternalHook("command:new", handler);

      const event = createInternalHookEvent("command", "new", "test-session");
      await triggerInternalHookWithCycleGuard(event);
      await triggerInternalHookWithCycleGuard(event);

      // The guard key is cleared after each dispatch, so the second call
      // sees an empty set and proceeds normally.
      expect(handler).toHaveBeenCalledTimes(2);
    });

    it("should allow concurrent triggers for the same key from independent contexts", async () => {
      // Two independent concurrent triggers for the same key (e.g., two
      // embedded agent runs starting at the same time) must both be
      // delivered. Each call has its own async root with no inherited
      // AsyncLocalStorage store.
      const handler = vi.fn();
      registerInternalHook("command:new", handler);

      const event1 = createInternalHookEvent("command", "new", "session-a");
      const event2 = createInternalHookEvent("command", "new", "session-a");

      await Promise.all([
        triggerInternalHookWithCycleGuard(event1),
        triggerInternalHookWithCycleGuard(event2),
      ]);

      expect(handler).toHaveBeenCalledTimes(2);
    });

    it("should not block different session keys", async () => {
      const handler = vi.fn();
      registerInternalHook("command:new", handler);

      const event1 = createInternalHookEvent("command", "new", "session-a");
      const event2 = createInternalHookEvent("command", "new", "session-b");

      await Promise.all([
        triggerInternalHookWithCycleGuard(event1),
        triggerInternalHookWithCycleGuard(event2),
      ]);

      expect(handler).toHaveBeenCalledTimes(2);
    });

    it("should not block different event types", async () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      registerInternalHook("command:new", handler1);
      registerInternalHook("command:reset", handler2);

      const event1 = createInternalHookEvent("command", "new", "test-session");
      const event2 = createInternalHookEvent("command", "reset", "test-session");

      await Promise.all([
        triggerInternalHookWithCycleGuard(event1),
        triggerInternalHookWithCycleGuard(event2),
      ]);

      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);
    });

    it("should block re-entrant trigger even with a slow handler and concurrent independent trigger", async () => {
      // Handler A is slow (still running). An independent concurrent trigger
      // for the same key should be delivered. But a re-entrant call from
      // within Handler A's chain should be blocked.
      const resolvers: Array<() => void> = [];
      const slowHandler = vi.fn(async () => {
        await new Promise<void>((resolve) => {
          resolvers.push(resolve);
        });
      });
      const reentrantCount = { value: 0 };
      const reentrantHandler = vi.fn(async () => {
        reentrantCount.value++;
        if (reentrantCount.value < 3) {
          await triggerInternalHookWithCycleGuard(
            createInternalHookEvent("message", "received", "session-a"),
          );
        }
      });

      registerInternalHook("message", slowHandler);
      registerInternalHook("message:received", reentrantHandler);

      // Start first dispatch (slow handler will not complete until we resolve)
      const firstDispatch = triggerInternalHookWithCycleGuard(
        createInternalHookEvent("message", "received", "session-a"),
      );

      // Start independent concurrent dispatch for the same key
      const independentDispatch = triggerInternalHookWithCycleGuard(
        createInternalHookEvent("message", "received", "session-a"),
      );

      // Resolve all slow handler invocations to let both dispatches complete
      for (const resolve of resolvers) {
        resolve();
      }

      await Promise.all([firstDispatch, independentDispatch]);

      // slowHandler called twice (both independent dispatches)
      expect(slowHandler).toHaveBeenCalledTimes(2);
      // reentrantHandler called twice (both independent dispatches), not more
      expect(reentrantHandler).toHaveBeenCalledTimes(2);
    });

    it("should deliver a delayed same-key hook scheduled from within a handler after dispatch completes", async () => {
      // Regression: a handler that schedules a delayed same-key redispatch
      // (e.g. via setTimeout) should have that delayed call delivered after
      // the original dispatch returns, not blocked by the guard.
      //
      // The handler uses fire-and-forget for the setTimeout (does not await
      // it), so the dispatch completes and the guard key is cleared before
      // the delayed trigger fires.
      let delayedTriggered = false;
      const handler = vi.fn(async (event) => {
        if (event.context.fromDelayed) {
          delayedTriggered = true;
          return;
        }
        // Fire-and-forget: schedule a delayed guarded trigger but don't
        // await it. This simulates a handler that schedules follow-up work
        // without blocking on it.
        setTimeout(() => {
          const delayedEvent = createInternalHookEvent("command", "new", "test-session", {
            fromDelayed: true,
          });
          void triggerInternalHookWithCycleGuard(delayedEvent);
        }, 10);
      });

      registerInternalHook("command:new", handler);

      const event = createInternalHookEvent("command", "new", "test-session");
      await triggerInternalHookWithCycleGuard(event);

      // At this point, dispatch is complete and guard key is cleared.
      // Wait for the delayed trigger to fire and complete.
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 50);
      });

      // Handler should be called twice: once for the original, once for the delayed
      expect(handler).toHaveBeenCalledTimes(2);
      expect(delayedTriggered).toBe(true);
    });

    it("should not affect the shared dispatcher's unconditional delivery contract", async () => {
      // The guarded producer must not change the contract of
      // `triggerInternalHook` for any other event/call site. Registering
      // a guarded dispatch in parallel with a plain dispatch for the same
      // key should not cause one to silently drop the other.
      const plainHandler = vi.fn();
      const guardedHandler = vi.fn();
      registerInternalHook("command:new", plainHandler);
      registerInternalHook("command:new", guardedHandler);

      const event = createInternalHookEvent("command", "new", "test-session");
      await triggerInternalHook(event);

      // The plain dispatcher delivers to all registered handlers.
      expect(plainHandler).toHaveBeenCalledTimes(1);
      expect(guardedHandler).toHaveBeenCalledTimes(1);
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

      expect(event.context).toStrictEqual({});
    });
  });

  describe("isAgentBootstrapEvent", () => {
    it.each([
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
    ] satisfies Array<{
      name: string;
      event: ReturnType<typeof createInternalHookEvent>;
      expected: boolean;
    }>)("$name", ({ event, expected }) => {
      expect(isAgentBootstrapEvent(event)).toBe(expected);
    });
  });

  describe("isGatewayStartupEvent", () => {
    it.each([
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
    ] satisfies Array<{
      name: string;
      event: ReturnType<typeof createInternalHookEvent>;
      expected: boolean;
    }>)("$name", ({ event, expected }) => {
      expect(isGatewayStartupEvent(event)).toBe(expected);
    });
  });

  describe("isMessageReceivedEvent", () => {
    it.each([
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
      {
        name: "returns false when content is missing",
        event: createInternalHookEvent("message", "received", "test-session", {
          from: "+1234567890",
          channelId: "whatsapp",
        }),
        expected: false,
      },
      {
        name: "returns false when content is not a string",
        event: createInternalHookEvent("message", "received", "test-session", {
          from: "+1234567890",
          content: 123,
          channelId: "whatsapp",
        }),
        expected: false,
      },
    ] satisfies Array<{
      name: string;
      event: ReturnType<typeof createInternalHookEvent>;
      expected: boolean;
    }>)("$name", ({ event, expected }) => {
      expect(isMessageReceivedEvent(event)).toBe(expected);
    });
  });

  describe("isMessageSentEvent", () => {
    it.each([
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
      {
        name: "returns false when content is missing",
        event: createInternalHookEvent("message", "sent", "test-session", {
          to: "+1234567890",
          success: true,
          channelId: "telegram",
        }),
        expected: false,
      },
      {
        name: "returns false when content is not a string",
        event: createInternalHookEvent("message", "sent", "test-session", {
          to: "+1234567890",
          content: false,
          success: true,
          channelId: "telegram",
        }),
        expected: false,
      },
    ] satisfies Array<{
      name: string;
      event: ReturnType<typeof createInternalHookEvent>;
      expected: boolean;
    }>)("$name", ({ event, expected }) => {
      expect(isMessageSentEvent(event)).toBe(expected);
    });
  });

  describe("message type-guard shared negatives", () => {
    it("returns false for non-message and missing-context shapes", () => {
      const cases = [
        {
          match: isMessageReceivedEvent,
        },
        {
          match: isMessageSentEvent,
        },
      ] as const;
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

      for (const { match } of cases) {
        expect(match(nonMessageEvent)).toBe(false);
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
      expect(keys).toStrictEqual([]);
    });
  });

  describe("clearInternalHooks", () => {
    it("should remove all registered handlers", () => {
      registerInternalHook("command:new", vi.fn());
      registerInternalHook("command:stop", vi.fn());

      clearInternalHooks();

      const keys = getRegisteredEventKeys();
      expect(keys).toStrictEqual([]);
    });
  });
});
