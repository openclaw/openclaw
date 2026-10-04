import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  testing,
  registerSessionBindingAdapter,
  type SessionBindingAdapter,
  type SessionBindingRecord,
} from "../../infra/outbound/session-binding-service.js";
import { resolveAgentRoute, type ResolvedAgentRoute } from "../../routing/resolve-route.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { readConversationBindingRouteFacts } from "../conversation-binding-route-facts.js";
import {
  ensureConfiguredBindingRouteReady,
  resolveRuntimeConversationBindingRoute,
  resolveRuntimeConversationBindingRouteAsync,
  inspectRuntimeConversationBindingRoute,
  type RuntimeConversationBindingRouteResult,
} from "./binding-routing.js";
const acpReadiness = vi.hoisted(() => vi.fn());
vi.mock("./acp-stateful-target-driver.js", () => ({
  ensureConfiguredAcpBindingTargetReady: acpReadiness,
}));

function createRoute(): ResolvedAgentRoute {
  const result: RuntimeConversationBindingRouteResult = {
    bindingRecord: null,
    route: {
      agentId: "main",
      channel: "demo",
      accountId: "default",
      sessionKey: "agent:main:main",
      mainSessionKey: "agent:main:main",
      lastRoutePolicy: "main",
      matchedBy: "default",
    },
  };
  return result.route;
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

  it.each([
    { targetSessionKey: "agent:review:home", metadata: { agentId: "other" } },
    { targetSessionKey: "global", metadata: { agentId: "review" } },
  ])("constructs the bound owner's route before roster selection ($targetSessionKey)", (target) => {
    const binding = createBinding(target);
    registerAdapter(binding);
    const session = { mainKey: "home", groupScope: "main" as const };
    const result = resolveRuntimeConversationBindingRoute({
      conversation: binding.conversation,
      resolveRoute: ({ boundAgentId }) =>
        resolveAgentRoute({
          cfg: boundAgentId
            ? { session }
            : { session, agents: { ownership: "explicit", entries: { main: {}, review: {} } } },
          defaultAgentId: boundAgentId,
          channel: "demo",
          peer: { kind: "group", id: "room-1" },
        }),
    });
    expect(result.route).toMatchObject({
      agentId: "review",
      sessionKey: target.targetSessionKey,
      mainSessionKey: "agent:review:home",
      groupScope: "main",
      lastRoutePolicy: target.targetSessionKey === "global" ? "session" : "main",
    });
    expect(result.boundAgentId).toBe("review");
    expect(readConversationBindingRouteFacts(result.route)).toMatchObject({
      kind: "agent",
      agentId: "review",
      observedAgentId: "review",
      bindingId: binding.bindingId,
    });
  });

  it.each([
    null,
    createBinding({ targetSessionKey: "agent:review:cron:job:run:finished" }),
    createBinding({
      metadata: {
        pluginBindingOwner: "plugin",
        pluginId: "demo",
        pluginRoot: "/synthetic/demo",
      },
    }),
    createBinding({ targetSessionKey: "global" }),
  ])("does not invent an agent for a binding without an agent owner (%j)", (binding) => {
    registerAdapter(binding);
    expect(() =>
      resolveRuntimeConversationBindingRoute({
        conversation: { channel: "demo", accountId: "default", conversationId: "room-1" },
        resolveRoute: ({ boundAgentId }) =>
          resolveAgentRoute({
            cfg: { agents: { ownership: "explicit", entries: { main: {}, review: {} } } },
            channel: "demo",
            defaultAgentId: boundAgentId,
          }),
      }),
    ).toThrow(expect.objectContaining({ code: "AGENT_SELECTION_REQUIRED" }));
  });

  it.each(["main", "home"])(
    "projects the bound agent's main session from a completed ordinary route (%s)",
    (mainKey) => {
      const ordinaryRoute = resolveAgentRoute({
        cfg: {
          agents: { entries: { main: {}, review: {} } },
          bindings: [{ agentId: "main", match: { channel: "demo" } }],
          session: { mainKey },
        },
        channel: "demo",
        peer: { kind: "group", id: "room-1" },
      });
      const result = inspectRuntimeConversationBindingRoute({
        route: ordinaryRoute,
        inspection: {
          status: "available",
          binding: createBinding({ targetSessionKey: `agent:review:${mainKey}` }),
        },
      });

      expect(result.route).toMatchObject({
        agentId: "review",
        sessionKey: `agent:review:${mainKey}`,
        mainSessionKey: `agent:review:${mainKey}`,
        lastRoutePolicy: "main",
        matchedBy: "binding.channel",
      });
      expect(ordinaryRoute).toMatchObject({
        agentId: "main",
        sessionKey: "agent:main:demo:group:room-1",
        mainSessionKey: `agent:main:${mainKey}`,
        lastRoutePolicy: "session",
      });
    },
  );

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

  it.each([
    { name: "agent session", binding: createBinding(), kind: "agent", agentId: "review" },
    {
      name: "inspection",
      binding: createBinding(),
      kind: "agent",
      agentId: "review",
      touchBinding: false,
    },
    {
      name: "global fallback",
      binding: createBinding({ targetSessionKey: "global" }),
      kind: "agent",
      agentId: "main",
    },
    {
      name: "plugin owner",
      binding: createBinding({
        metadata: {
          pluginBindingOwner: "plugin",
          pluginId: "demo-plugin",
          pluginRoot: "/tmp/demo-plugin",
        },
      }),
      kind: "plugin",
    },
    {
      name: "isolated cron",
      binding: createBinding({
        targetSessionKey: "agent:youtube:cron:monthly-report:run:closed-run-1",
      }),
      kind: "none",
    },
  ])(
    "projects $name and touches only its owning channel account",
    ({ binding, kind, agentId, touchBinding }) => {
      const route = createRoute();
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
        route,
        conversation: binding.conversation,
        touchBinding,
      });
      expect(resolveByConversation).toHaveBeenCalledWith(binding.conversation);
      if (kind !== "none" && touchBinding !== false) {
        expect(touch).toHaveBeenCalledWith("binding-1", undefined);
      } else {
        expect(touch).not.toHaveBeenCalled();
      }
      for (const siblingTouch of siblingTouches) {
        expect(siblingTouch).not.toHaveBeenCalled();
      }
      expect(result.bindingOwnerAvailable).toBe(true);
      expect(result.bindingRecord).toBe(kind === "none" ? null : binding);
      expect(result.boundSessionKey).toBe(kind === "agent" ? binding.targetSessionKey : undefined);
      expect(result.boundAgentId).toBe(agentId);
      expect(Object.fromEntries(Object.entries(result.route))).toEqual(
        kind === "agent"
          ? {
              ...route,
              agentId,
              sessionKey: binding.targetSessionKey,
              mainSessionKey: `agent:${agentId}:main`,
              lastRoutePolicy: "session",
              matchedBy: "binding.channel",
            }
          : route,
      );
      expect(readConversationBindingRouteFacts(route)).toBeUndefined();
      expect(Object.isFrozen(readConversationBindingRouteFacts(result.route))).toBe(true);
      expect(readConversationBindingRouteFacts(result.route)?.kind).toBe(kind);
    },
  );

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
});

describe("ensureConfiguredBindingRouteReady", () => {
  afterEach(() => {
    vi.useRealTimers();
    acpReadiness.mockReset();
  });

  it("returns a bounded failure when target readiness never settles", async () => {
    vi.useFakeTimers();
    acpReadiness.mockImplementation(async () => await new Promise<never>(() => {}));

    const resultPromise = ensureConfiguredBindingRouteReady({
      cfg: {} as never,
      bindingResolution: { statefulTarget: { driverId: "acp" } } as never,
    });

    await vi.advanceTimersByTimeAsync(30_000);

    await expect(resultPromise).resolves.toEqual({
      ok: false,
      error: "Configured binding route ready check timed out",
    });
  });
});
