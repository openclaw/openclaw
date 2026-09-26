// Internal hook tests cover dispatch for command, session, agent, and gateway hooks.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  clearInternalHooks,
  createInternalHookEvent,
  getRegisteredEventKeys,
  isAgentBootstrapEvent,
  isGatewayStartupEvent,
  registerInternalHook,
  setInternalHooksEnabled,
  triggerInternalHook,
  unregisterInternalHook,
  type AgentBootstrapHookContext,
  type GatewayStartupHookContext,
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
    resetPluginRuntimeStateForTest();
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
  });

  describe("clearInternalHooks", () => {
    it("should remove all registered handlers", () => {
      registerInternalHook("command:new", vi.fn());
      registerInternalHook("command:stop", vi.fn());

      clearInternalHooks();

      const keys = getRegisteredEventKeys();
      expect(keys).toStrictEqual([]);
    });

    it("removes legacy hooks from the active plugin registry", () => {
      const active = createEmptyPluginRegistry();
      active.legacyInternalHooks.push({
        pluginId: "active-plugin",
        name: "active-plugin",
        event: "command:stop",
        handler: vi.fn(),
      });
      setActivePluginRegistry(active);

      clearInternalHooks();

      expect(active.legacyInternalHooks).toStrictEqual([]);
      expect(getRegisteredEventKeys()).toStrictEqual([]);
    });
  });
});
