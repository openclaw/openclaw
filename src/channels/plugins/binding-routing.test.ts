// Binding routing tests cover channel binding selection and message routing behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  testing,
  registerSessionBindingAdapter,
  type SessionBindingAdapter,
  type SessionBindingRecord,
} from "../../infra/outbound/session-binding-service.js";
import type { ResolvedAgentRoute } from "../../routing/resolve-route.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { readConversationBindingRouteFacts } from "../conversation-binding-route-facts.js";
import {
  ensureConfiguredBindingRouteReady,
  resolveRuntimeConversationBindingRoute,
  resolveRuntimeConversationBindingRouteAsync,
  inspectRuntimeConversationBindingRoute,
  type RuntimeConversationBindingRouteResult,
} from "./binding-routing.js";
import { registerStatefulBindingTargetDriver } from "./stateful-target-drivers.js";

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
    channel: record?.conversation.channel ?? "demo",
    accountId: record?.conversation.accountId ?? "default",
    listBySession: () => [],
    resolveByConversation,
    touch,
  });
  return { resolveByConversation, touch };
}

describe("runtime conversation binding route", () => {
  beforeEach(() => {
    testing.resetSessionBindingAdaptersForTests();
  });

  it("rechecks the binding after awaiting activity persistence and keeps inspection pure", async () => {
    let binding = createBinding();
    const gate = createDeferredCore();
    const touchAsync = vi.fn(() => gate.promise);
    const touch = vi.fn();
    registerSessionBindingAdapter({
      channel: "demo",
      accountId: "default",
      listBySession: () => [],
      resolveByConversation: () => binding,
      touch,
      touchAsync,
    });
    const params = { route: createRoute(), conversation: binding.conversation };
    expect(
      inspectRuntimeConversationBindingRoute({
        route: params.route,
        inspection: { status: "available", binding },
      }).boundSessionKey,
    ).toBe(binding.targetSessionKey);
    expect(touchAsync).not.toHaveBeenCalled();
    expect(touch).not.toHaveBeenCalled();
    let settled = false;
    const pending = resolveRuntimeConversationBindingRouteAsync(params).then((result) => {
      settled = true;
      return result;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    binding = createBinding({ targetSessionKey: "agent:replacement:acp:session-2" });
    gate.resolve();
    expect((await pending).boundSessionKey).toBe(binding.targetSessionKey);
    expect(touch).not.toHaveBeenCalled();
  });

  it("keeps the stable runtime-route result structurally assignable", () => {
    const result: RuntimeConversationBindingRouteResult = {
      bindingRecord: null,
      route: createRoute(),
    };

    expect(result.bindingOwnerAvailable).toBeUndefined();
  });

  it.each([
    { mode: "stable", change: { bindingId: "binding-2" }, label: "new ID" },
    { mode: "churn", change: { bindingId: "binding-2" }, label: "repeated replacement" },
    { mode: "stable", change: { boundAt: 2 }, label: "reused ID with new creation time" },
    {
      mode: "stable",
      change: { targetSessionKey: "agent:replacement:main" },
      label: "reused ID with new target",
    },
    { mode: "stable", change: { targetKind: "subagent" }, label: "reused ID with new kind" },
  ] as const)("settles replacement activity before routing ($label)", async ({ mode, change }) => {
    let binding = createBinding();
    const entered = createDeferredCore();
    const firstTouch = createDeferredCore();
    const touchAsync = vi
      .fn(async (_bindingId: string) => {
        binding =
          mode === "churn"
            ? createBinding({ bindingId: "binding-3" })
            : { ...binding, metadata: { lastActivityAt: 1234 } };
      })
      .mockImplementationOnce(async () => {
        entered.resolve();
        await firstTouch.promise;
      });
    registerSessionBindingAdapter({
      channel: "demo",
      accountId: "default",
      listBySession: () => [],
      resolveByConversation: () => binding,
      inspectByConversationAsync: async () => binding,
      touchAsync,
    });
    const pending = resolveRuntimeConversationBindingRouteAsync({
      route: createRoute(),
      conversation: binding.conversation,
    });
    const failure =
      mode === "churn" ? expect(pending).rejects.toThrow(/changed.*activity/) : undefined;
    await entered.promise;
    const replacement = createBinding({
      ...change,
      metadata: { lastActivityAt: 1 },
    });
    binding = replacement;
    firstTouch.resolve();
    if (failure) {
      await failure;
    } else {
      const result = await pending;
      expect(result.boundSessionKey).toBe(replacement.targetSessionKey);
      expect(result.bindingRecord?.metadata?.lastActivityAt).toBe(1234);
    }
    expect(touchAsync.mock.calls.map(([bindingId]) => bindingId)).toEqual([
      "binding-1",
      replacement.bindingId,
    ]);
  });

  it("rewrites the route and touches only the owning channel account's binding", () => {
    const binding = createBinding();
    const { resolveByConversation, touch } = registerAdapter(binding);
    const siblingTouches = [
      { channel: "other", accountId: "default" },
      { channel: "demo", accountId: "other" },
    ].map(
      (scope) =>
        registerAdapter(createBinding({ conversation: { ...binding.conversation, ...scope } }))
          .touch,
    );

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
    for (const siblingTouch of siblingTouches) {
      expect(siblingTouch).not.toHaveBeenCalled();
    }
    expect(result.boundSessionKey).toBe("agent:review:acp:session-1");
    expect(result.boundAgentId).toBe("review");
    expect(Object.fromEntries(Object.entries(result.route))).toEqual({
      agentId: "review",
      accountId: "default",
      channel: "demo",
      sessionKey: "agent:review:acp:session-1",
      mainSessionKey: "agent:main:main",
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
    expect(Object.fromEntries(Object.entries(result.route))).toEqual(route);
    expect(readConversationBindingRouteFacts(route)).toBeUndefined();
    expect(Object.isFrozen(readConversationBindingRouteFacts(result.route))).toBe(true);
    expect(readConversationBindingRouteFacts(result.route)?.kind).toBe("plugin");
  });

  it.each([
    { targetSessionKey: "global", metadata: { agentId: "review" }, agentId: "review" },
    { targetSessionKey: "global", metadata: undefined, agentId: "main" },
    {
      targetSessionKey: "agent:review:session-1",
      metadata: { agentId: "other" },
      agentId: "review",
    },
  ])("resolves $targetSessionKey to owner $agentId", ({ targetSessionKey, metadata, agentId }) => {
    const binding = createBinding({ targetSessionKey, metadata });
    registerAdapter(binding);

    const result = resolveRuntimeConversationBindingRoute({
      route: createRoute(),
      conversation: binding.conversation,
    });

    expect(result.route).toMatchObject({ sessionKey: targetSessionKey, agentId });
    expect(result.boundAgentId).toBe(agentId);
  });

  it("rejects an opaque target when its plugin ownership metadata is missing", () => {
    const binding = createBinding({
      targetSessionKey: "plugin-thread-1",
      metadata: { agentId: "review" },
    });
    registerAdapter(binding);

    expect(() =>
      resolveRuntimeConversationBindingRoute({
        route: createRoute(),
        conversation: binding.conversation,
      }),
    ).toThrow();
  });

  it("inspects a runtime-bound route without touching the binding", () => {
    const { touch } = registerAdapter(createBinding());

    const result = resolveRuntimeConversationBindingRoute({
      route: createRoute(),
      touchBinding: false,
      conversation: {
        channel: "demo",
        accountId: "default",
        conversationId: "room-1",
      },
    });

    expect(touch).not.toHaveBeenCalled();
    expect(result.bindingOwnerAvailable).toBe(true);
    expect(result.boundSessionKey).toBe("agent:review:acp:session-1");
  });

  it("ignores runtime bindings that target isolated cron run sessions", () => {
    const route = createRoute();
    const binding = createBinding({
      targetSessionKey: "agent:youtube:cron:monthly-report:run:closed-run-1",
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

    expect(touch).not.toHaveBeenCalled();
    expect(result.bindingRecord).toBeNull();
    expect(result.boundSessionKey).toBeUndefined();
    expect(Object.fromEntries(Object.entries(result.route))).toEqual(route);
    expect(readConversationBindingRouteFacts(route)).toBeUndefined();
    expect(Object.isFrozen(readConversationBindingRouteFacts(result.route))).toBe(true);
    expect(readConversationBindingRouteFacts(result.route)?.kind).toBe("none");
  });
});

describe("ensureConfiguredBindingRouteReady", () => {
  let unregisterDriver: (() => void) | undefined;

  afterEach(() => {
    vi.useRealTimers();
    unregisterDriver?.();
  });

  it("returns a bounded failure when target readiness never settles", async () => {
    vi.useFakeTimers();
    unregisterDriver = registerStatefulBindingTargetDriver({
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
