import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __testing,
  getSessionBindingService,
  registerSessionBindingAdapter,
  type SessionBindingAdapter,
  type SessionBindingRecord,
} from "../../infra/outbound/session-binding-service.js";
import type { ResolvedAgentRoute } from "../../routing/resolve-route.js";
import {
  ensureConfiguredBindingRouteReady,
  resolveRuntimeConversationBindingRoute,
} from "./binding-routing.js";
import {
  registerStatefulBindingTargetDriver,
  unregisterStatefulBindingTargetDriver,
} from "./stateful-target-drivers.js";

function createRoute(): ResolvedAgentRoute {
  return {
    agentId: "main",
    channel: "demo",
    accountId: "default",
    sessionKey: "agent:main:main",
    mainSessionKey: "agent:main:main",
    lastRoutePolicy: "main",
    matchedBy: "default",
  };
}

function createBinding(overrides?: Partial<SessionBindingRecord>): SessionBindingRecord {
  return {
    bindingId: "binding-1",
    targetSessionKey: "agent:review:acp:session-1",
    targetKind: "session",
    conversation: {
      channel: "demo",
      accountId: "default",
      conversationId: "room-1",
    },
    status: "active",
    boundAt: 1,
    ...overrides,
  };
}

function registerAdapter(record: SessionBindingRecord | null): {
  resolveByConversation: ReturnType<typeof vi.fn>;
  touch: ReturnType<typeof vi.fn>;
} {
  const resolveByConversation = vi.fn<SessionBindingAdapter["resolveByConversation"]>(() => record);
  const touch = vi.fn<NonNullable<SessionBindingAdapter["touch"]>>();
  registerSessionBindingAdapter({
    channel: "demo",
    accountId: "default",
    listBySession: () => [],
    resolveByConversation,
    touch,
  });
  return { resolveByConversation, touch };
}

describe("runtime conversation binding route", () => {
  beforeEach(() => {
    __testing.resetSessionBindingAdaptersForTests();
  });

  it("rewrites the route to a runtime-bound ACP session and touches the binding", () => {
    const binding = createBinding();
    const { resolveByConversation, touch } = registerAdapter(binding);

    const result = resolveRuntimeConversationBindingRoute({
      route: createRoute(),
      conversation: {
        channel: "demo",
        accountId: "default",
        conversationId: "room-1",
      },
    });

    expect(resolveByConversation).toHaveBeenCalledWith({
      channel: "demo",
      accountId: "default",
      conversationId: "room-1",
    });
    expect(touch).toHaveBeenCalledWith("binding-1", undefined);
    expect(result.boundSessionKey).toBe("agent:review:acp:session-1");
    expect(result.boundAgentId).toBe("review");
    expect(result.route).toMatchObject({
      agentId: "review",
      sessionKey: "agent:review:acp:session-1",
      lastRoutePolicy: "session",
      matchedBy: "binding.channel",
    });
  });

  it("touches plugin-owned bindings without rewriting the channel route", () => {
    const route = createRoute();
    const binding = createBinding({
      metadata: {
        pluginBindingOwner: "plugin",
        pluginId: "demo-plugin",
        pluginRoot: "/tmp/demo-plugin",
      },
    });
    const { touch } = registerAdapter(binding);

    const result = resolveRuntimeConversationBindingRoute({
      route,
      conversation: {
        channel: "demo",
        accountId: "default",
        conversationId: "room-1",
      },
    });

    expect(touch).toHaveBeenCalledWith("binding-1", undefined);
    expect(result.bindingRecord).toBe(binding);
    expect(result.boundSessionKey).toBeUndefined();
    expect(result.route).toBe(route);
  });

  it("drops a stale binding and unbinds when targetSessionExists returns false", () => {
    const binding = createBinding();
    const { touch } = registerAdapter(binding);
    const unbind = vi.spyOn(getSessionBindingService(), "unbind");
    const targetSessionExists = vi.fn<(key: string) => boolean>(() => false);
    const route = createRoute();

    const result = resolveRuntimeConversationBindingRoute({
      route,
      conversation: {
        channel: "demo",
        accountId: "default",
        conversationId: "room-1",
      },
      targetSessionExists,
    });

    expect(targetSessionExists).toHaveBeenCalledWith("agent:review:acp:session-1");
    expect(touch).not.toHaveBeenCalled();
    expect(unbind).toHaveBeenCalledWith({
      targetSessionKey: "agent:review:acp:session-1",
      reason: "stale-target",
    });
    expect(result.bindingRecord).toBeNull();
    expect(result.boundSessionKey).toBeUndefined();
    expect(result.route).toBe(route);

    unbind.mockRestore();
  });

  it("skips targetSessionExists check for plugin-owned bindings", () => {
    const route = createRoute();
    const binding = createBinding({
      metadata: {
        pluginBindingOwner: "plugin",
        pluginId: "demo-plugin",
        pluginRoot: "/tmp/demo-plugin",
      },
    });
    registerAdapter(binding);
    const targetSessionExists = vi.fn<(key: string) => boolean>(() => false);

    const result = resolveRuntimeConversationBindingRoute({
      route,
      conversation: {
        channel: "demo",
        accountId: "default",
        conversationId: "room-1",
      },
      targetSessionExists,
    });

    expect(targetSessionExists).not.toHaveBeenCalled();
    expect(result.bindingRecord).toBe(binding);
    expect(result.route).toBe(route);
  });

  it("routes normally when targetSessionExists returns true", () => {
    const binding = createBinding();
    const { touch } = registerAdapter(binding);
    const targetSessionExists = vi.fn<(key: string) => boolean>(() => true);

    const result = resolveRuntimeConversationBindingRoute({
      route: createRoute(),
      conversation: {
        channel: "demo",
        accountId: "default",
        conversationId: "room-1",
      },
      targetSessionExists,
    });

    expect(targetSessionExists).toHaveBeenCalledWith("agent:review:acp:session-1");
    expect(touch).toHaveBeenCalledWith("binding-1", undefined);
    expect(result.boundSessionKey).toBe("agent:review:acp:session-1");
    expect(result.route).toMatchObject({ sessionKey: "agent:review:acp:session-1" });
  });

  it("suppresses and does not propagate a stale-target unbind rejection", async () => {
    const binding = createBinding();
    registerAdapter(binding);
    const unbind = vi
      .spyOn(getSessionBindingService(), "unbind")
      .mockRejectedValue(new Error("adapter write failed"));
    const route = createRoute();

    const result = resolveRuntimeConversationBindingRoute({
      route,
      conversation: { channel: "demo", accountId: "default", conversationId: "room-1" },
      targetSessionExists: () => false,
    });

    expect(result.route).toBe(route);
    await expect(Promise.resolve()).resolves.not.toThrow();

    unbind.mockRestore();
  });
});

describe("ensureConfiguredBindingRouteReady", () => {
  afterEach(() => {
    vi.useRealTimers();
    unregisterStatefulBindingTargetDriver("slow");
  });

  it("returns a bounded failure when target readiness never settles", async () => {
    vi.useFakeTimers();
    registerStatefulBindingTargetDriver({
      id: "slow",
      ensureReady: async () => await new Promise<never>(() => {}),
      ensureSession: async () => ({
        ok: false,
        sessionKey: "agent:slow:binding",
        error: "not used",
      }),
    });

    const resultPromise = ensureConfiguredBindingRouteReady({
      cfg: {} as never,
      bindingResolution: { statefulTarget: { driverId: "slow" } } as never,
    });

    await vi.advanceTimersByTimeAsync(30_000);

    await expect(resultPromise).resolves.toEqual({
      ok: false,
      error: "Configured binding route ready check timed out",
    });
  });
});
