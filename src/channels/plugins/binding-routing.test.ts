import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
} from "./binding-routing.js";
import {
  ensureConfiguredBindingTargetReady,
  resetConfiguredBindingTargetInPlace,
} from "./binding-targets.js";
import type { ConfiguredBindingResolution } from "./binding-types.js";
const acp = vi.hoisted(() => ({
  ensureConfiguredAcpBindingTargetReady: vi.fn(),
  resolveAcpBindingTargetBySessionKey: vi.fn(),
  resetConfiguredAcpBindingTargetInPlace: vi.fn(),
}));
// mock-isolation: Readiness timeout tests must not initialize ACP backend registries or Gateway reset state.
vi.mock("./acp-stateful-target-driver.js", () => acp);

const conversation = { channel: "demo", accountId: "default", conversationId: "room-1" };
const peer = { kind: "group", id: "room-1" } as const;
const cronSessionKey = "agent:review:cron:job:run:finished";
const pluginOwner = {
  pluginBindingOwner: "plugin",
  pluginId: "demo-plugin",
  pluginRoot: "/synthetic/demo",
};

const route: ResolvedAgentRoute = {
  agentId: "main",
  channel: "demo",
  accountId: "default",
  sessionKey: "agent:main:main",
  mainSessionKey: "agent:main:main",
  lastRoutePolicy: "main",
  matchedBy: "default",
};

function createBinding(overrides?: Partial<SessionBindingRecord>): SessionBindingRecord {
  return {
    bindingId: "binding-1",
    targetSessionKey: "agent:review:acp:session-1",
    targetKind: "session",
    conversation,
    status: "active",
    boundAt: 1,
    ...overrides,
  };
}

function registerAdapter(
  record: SessionBindingRecord | null,
  touchAsync?: SessionBindingAdapter["touchAsync"],
) {
  const resolveByConversation = vi.fn<SessionBindingAdapter["resolveByConversation"]>(() => record);
  const touch = vi.fn<NonNullable<SessionBindingAdapter["touch"]>>();
  registerSessionBindingAdapter({
    channel: record?.conversation.channel ?? "demo",
    accountId: record?.conversation.accountId ?? "default",
    listBySession: () => [],
    resolveByConversation,
    touch,
    touchAsync,
  });
  return { resolveByConversation, touch };
}

function inspectBinding(binding: SessionBindingRecord, baseRoute = route) {
  return inspectRuntimeConversationBindingRoute({
    route: baseRoute,
    inspection: { status: "available", binding },
  });
}

beforeEach(() => {
  testing.resetSessionBindingAdaptersForTests();
  vi.resetAllMocks();
});
afterEach(() => vi.useRealTimers());

it("does not invent an agent owner for a plugin binding", () => {
  registerAdapter(createBinding({ metadata: pluginOwner }));
  expect(() =>
    resolveRuntimeConversationBindingRoute({
      conversation,
      resolveRoute: ({ boundAgentId }) =>
        resolveAgentRoute({
          cfg: boundAgentId
            ? {}
            : { agents: { ownership: "explicit", entries: { main: {}, review: {} } } },
          defaultAgentId: boundAgentId,
          channel: "demo",
        }),
    }),
  ).toThrow(expect.objectContaining({ code: "AGENT_SELECTION_REQUIRED" }));
});

it("projects the bound main session without mutating the ordinary route", () => {
  const mainKey = "home";
  const ordinaryRoute = resolveAgentRoute({
    cfg: {
      agents: { entries: { main: {}, review: {} } },
      bindings: [{ agentId: "main", match: { channel: "demo" } }],
      session: { mainKey },
    },
    channel: "demo",
    peer,
  });
  const result = inspectBinding(
    createBinding({ targetSessionKey: `agent:review:${mainKey}`, metadata: { agentId: "other" } }),
    ordinaryRoute,
  );

  expect(result.boundAgentId).toBe("review");
  expect(readConversationBindingRouteFacts(result.route)).toMatchObject({
    kind: "agent",
    agentId: "review",
    observedAgentId: "review",
    bindingId: "binding-1",
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
});

it("awaits activity persistence and keeps inspection pure", async () => {
  const binding = createBinding();
  const gate = createDeferredCore();
  const touchAsync = vi.fn(() => gate.promise);
  const { touch } = registerAdapter(binding, touchAsync);
  const params = { route, conversation: binding.conversation };
  expect(inspectBinding(binding, params.route).boundSessionKey).toBe(binding.targetSessionKey);
  expect(touchAsync).not.toHaveBeenCalled();
  expect(touch).not.toHaveBeenCalled();
  const settled = vi.fn();
  const pending = resolveRuntimeConversationBindingRouteAsync(params);
  void pending.then(settled);
  await Promise.resolve();
  expect(settled).not.toHaveBeenCalled();
  gate.resolve();
  expect((await pending).boundSessionKey).toBe(binding.targetSessionKey);
  expect(touch).not.toHaveBeenCalled();
});

it.each([
  ["agent session", createBinding(), "agent", "review"],
  ["inspection", createBinding(), "agent", "review", false],
  ["global fallback", createBinding({ targetSessionKey: "global" }), "agent", "main"],
  ["plugin owner", createBinding({ metadata: pluginOwner }), "plugin"],
  ["isolated cron", createBinding({ targetSessionKey: cronSessionKey }), "none"],
] as const)(
  "routes %s within its owner scope",
  (_name, binding, kind, agentId?: string, touchBinding?: boolean) => {
    const { resolveByConversation, touch } = registerAdapter(binding);
    const siblingTouches = [{ channel: "other" }, { accountId: "other" }].map(
      (scope) =>
        registerAdapter(createBinding({ conversation: { ...conversation, ...scope } })).touch,
    );
    const result = resolveRuntimeConversationBindingRoute({
      route,
      conversation: binding.conversation,
      touchBinding,
    });
    expect(resolveByConversation).toHaveBeenCalledWith(binding.conversation);
    expect(touch.mock.calls).toEqual(
      kind !== "none" && touchBinding !== false ? [["binding-1", undefined]] : [],
    );
    for (const siblingTouch of siblingTouches) {
      expect(siblingTouch).not.toHaveBeenCalled();
    }
    expect(result.bindingOwnerAvailable).toBe(true);
    expect(result.boundSessionKey).toBe(kind === "agent" ? binding.targetSessionKey : undefined);
    expect(result.boundAgentId).toBe(agentId);
    expect(result.bindingRecord).toBe(kind === "none" ? null : binding);
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

it("rejects opaque targets missing plugin ownership", () => {
  const binding = createBinding({
    targetSessionKey: "plugin-thread-1",
    metadata: { agentId: "review" },
  });
  registerAdapter(binding);
  expect(() =>
    resolveRuntimeConversationBindingRoute({
      route,
      conversation: binding.conversation,
    }),
  ).toThrow();
});
it("bounds unsettled configured-binding readiness", async () => {
  vi.useFakeTimers();
  acp.ensureConfiguredAcpBindingTargetReady.mockReturnValue(new Promise<never>(() => {}));
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

function createBindingResolution(driverId: string): ConfiguredBindingResolution {
  const target = { conversationId: conversation.conversationId };
  const statefulTarget = {
    kind: "stateful" as const,
    driverId,
    sessionKey: `agent:codex:${driverId}`,
    agentId: "codex",
  };
  const record = createBinding({ targetSessionKey: statefulTarget.sessionKey });
  return {
    conversation,
    match: target,
    record,
    statefulTarget,
    compiledBinding: {
      channel: conversation.channel,
      binding: {
        type: "acp",
        agentId: "codex",
        match: {
          channel: conversation.channel,
          peer: { kind: "channel", id: target.conversationId },
        },
        acp: { mode: "persistent" },
      },
      bindingConversationId: target.conversationId,
      target,
      agentId: "codex",
      provider: { compileConfiguredBinding: () => target, matchInboundConversation: () => target },
      targetFactory: { driverId, materialize: () => ({ record, statefulTarget }) },
    },
  };
}

it("delegates readiness to the ACP owner", async () => {
  const ensureReady = acp.ensureConfiguredAcpBindingTargetReady.mockResolvedValue({ ok: true });
  const params = { cfg: {}, bindingResolution: createBindingResolution("acp") };
  await expect(ensureConfiguredBindingTargetReady(params)).resolves.toEqual({ ok: true });
  expect(ensureReady).toHaveBeenCalledTimes(1);
  expect(ensureReady).toHaveBeenCalledWith(params);
});

it("resolves resets through the ACP session-key lookup", async () => {
  const resetInPlace = acp.resetConfiguredAcpBindingTargetInPlace.mockResolvedValue({ ok: true });
  const bindingTarget = createBindingResolution("acp").statefulTarget;
  acp.resolveAcpBindingTargetBySessionKey.mockResolvedValue(bindingTarget);
  const params = {
    cfg: {},
    sessionKey: "agent:codex:acp",
    reason: "reset" as const,
    commandSource: "discord:native",
  };
  await expect(resetConfiguredBindingTargetInPlace(params)).resolves.toEqual({ ok: true });
  expect(resetInPlace).toHaveBeenCalledTimes(1);
  expect(resetInPlace).toHaveBeenCalledWith({ ...params, bindingTarget });
});

it("returns a typed error for an unsupported target driver", async () => {
  await expect(
    ensureConfiguredBindingTargetReady({
      cfg: {},
      bindingResolution: createBindingResolution("missing-driver"),
    }),
  ).resolves.toEqual({
    ok: false,
    error: "Configured binding target driver unavailable: missing-driver",
  });
});

it("does not enter the ACP owner after readiness authority is revoked", async () => {
  await expect(
    ensureConfiguredBindingTargetReady({
      cfg: {},
      bindingResolution: createBindingResolution("acp"),
      assertActive: () => {
        throw new Error("admission retired");
      },
    }),
  ).resolves.toEqual({ ok: false, error: "admission retired" });
  expect(acp.ensureConfiguredAcpBindingTargetReady).not.toHaveBeenCalled();
});

it("skips reset when the ACP owner finds no target", async () => {
  acp.resolveAcpBindingTargetBySessionKey.mockResolvedValue(null);
  await expect(
    resetConfiguredBindingTargetInPlace({
      cfg: {},
      sessionKey: "agent:main:main",
      reason: "new",
    }),
  ).resolves.toEqual({ ok: false, skipped: true });
  expect(acp.resetConfiguredAcpBindingTargetInPlace).not.toHaveBeenCalled();
});
