import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  matchesConversationBindingRouteFacts,
  readConversationBindingRouteFacts,
  withConversationBindingRouteFacts,
} from "../../channels/conversation-binding-route-facts.js";
import {
  resolveConfiguredBindingRoute,
  ensureConfiguredBindingRouteReady,
  inspectRuntimeConversationBindingRoute,
  resolveRuntimeConversationBindingRouteAsync,
} from "../../channels/plugins/binding-routing.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { ResolvedAgentRoute } from "../../routing/resolve-route.js";
import { createBoundDeliveryRouter } from "./bound-delivery-router.js";
import {
  nativeSessionBindingListBySession,
  nativeSessionBindingSelection,
} from "./session-binding-native-selection.js";
import {
  getSessionBindingService,
  inspectSessionBindingByConversation,
  listSessionBindingsBySessionAsync,
  readSessionBindingSelectionCurrent,
  registerSessionBindingAdapter,
  testing,
  type SessionBindingAdapter,
  type SessionBindingBindInput,
  type SessionBindingRecord,
} from "./session-binding-service.js";

const durable = vi.hoisted(() => ({
  entries: new Map<string, SessionEntry>(),
  read: vi.fn(),
  configured: vi.fn(),
  ready: vi.fn(),
}));
vi.mock("../../channels/plugins/configured-binding-registry.js", () => ({
  resolveConfiguredBinding: durable.configured,
}));
vi.mock("../../channels/plugins/binding-targets.js", () => ({
  ensureConfiguredBindingTargetReady: durable.ready,
}));
vi.mock("../../config/config.js", () => ({ getRuntimeConfig: () => ({}) }));
vi.mock("../../config/sessions/session-entry-read-runtime.js", () => ({
  withSessionEntryReadOnlyInWorker: async (
    scope: { sessionKey: string },
    assertCurrent: () => void,
    consume: (read: { ok: true; value: SessionEntry | undefined }) => Promise<unknown>,
  ) => {
    assertCurrent();
    durable.read(scope);
    const value = await consume({ ok: true, value: durable.entries.get(scope.sessionKey) });
    assertCurrent();
    return value;
  },
}));

const conversation = { channel: "policy-test", accountId: "default", conversationId: "room" };
const route: ResolvedAgentRoute = {
  agentId: "main",
  channel: conversation.channel,
  accountId: conversation.accountId,
  sessionKey: "agent:main:discord:channel:room",
  mainSessionKey: "agent:main:main",
  lastRoutePolicy: "session",
  matchedBy: "default",
};
const blockedTargets: Array<
  Pick<SessionBindingBindInput, "targetSessionKey" | "targetKind" | "metadata">
> = [
  { targetSessionKey: "agent:worker:main", targetKind: "subagent" },
  { targetSessionKey: "agent:worker:subagent:child", targetKind: "session" },
  {
    targetSessionKey: "agent:worker:subagent:plugin-child",
    targetKind: "session",
    metadata: { pluginBindingOwner: "plugin", pluginId: "demo", pluginRoot: "/synthetic-plugin" },
  },
  { targetSessionKey: "  AgEnT:Worker:SuBaGeNt:child  ", targetKind: "session" },
  { targetSessionKey: " SUBAGENT:child ", targetKind: "session" },
  {
    targetSessionKey: "agent:worker:acp:child",
    targetKind: "session",
    metadata: { boundBy: "system" },
  },
  { targetSessionKey: " ACP:child ", targetKind: "session", metadata: { boundBy: " SYSTEM " } },
];
function record(target: (typeof blockedTargets)[number]): SessionBindingRecord {
  return { ...target, conversation, bindingId: "persisted", status: "active", boundAt: 1 };
}
function register(
  bindingRecord: SessionBindingRecord,
  native = false,
  adapterConversation = conversation,
) {
  const bind = vi.fn(async (input: SessionBindingBindInput) => ({ ...bindingRecord, ...input }));
  const touch = vi.fn();
  const unbind = vi.fn(async () => [bindingRecord]);
  const adapter: SessionBindingAdapter = {
    channel: adapterConversation.channel,
    accountId: adapterConversation.accountId,
    bind,
    touch,
    unbind,
    listBySession: () => [bindingRecord],
    resolveByConversation: () => bindingRecord,
    inspectByConversation: () => bindingRecord,
    inspectByConversationAsync: async () => bindingRecord,
    resolveByConversationAsync: async () => bindingRecord,
    ...(native
      ? {
          [nativeSessionBindingSelection]: async (refs: readonly unknown[]) =>
            refs.map(() => bindingRecord),
          [nativeSessionBindingListBySession]: async () => [bindingRecord],
        }
      : {}),
  };
  registerSessionBindingAdapter(adapter);
  return { bind, touch, unbind };
}

beforeEach(() => {
  testing.resetSessionBindingAdaptersForTests();
  durable.entries.clear();
  durable.read.mockClear();
  durable.configured.mockReset();
  durable.ready.mockReset().mockResolvedValue({ ok: true });
});
afterEach(() => testing.resetSessionBindingAdaptersForTests());

describe("delegated workers cannot own conversations", () => {
  it.each(blockedTargets)(
    "rejects $targetSessionKey ($targetKind) before adapter effects",
    async (target) => {
      const adapter = register(record(target));
      for (const placement of ["current", "child"] as const) {
        await expect(
          getSessionBindingService().bind({ ...target, conversation, placement }),
        ).rejects.toMatchObject({
          code: "BINDING_CAPABILITY_UNSUPPORTED",
        });
      }
      expect(adapter.bind).not.toHaveBeenCalled();
      expect(adapter.touch).not.toHaveBeenCalled();
      expect(adapter.unbind).not.toHaveBeenCalled();
      expect(durable.read).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "ignores saved bindings on every read and delivery surface, native=%s",
    async (native) => {
      for (const target of blockedTargets) {
        testing.resetSessionBindingAdaptersForTests();
        const saved = record(target);
        const adapter = register(saved, native);
        const service = getSessionBindingService();
        expect(service.resolveByConversation(conversation)).toBeNull();
        expect(inspectSessionBindingByConversation(conversation)).toMatchObject({
          status: "available",
          binding: null,
        });
        expect(service.listBySession(target.targetSessionKey)).toEqual([]);
        expect(await service.resolveByConversationAsync(conversation)).toBeNull();
        expect(await service.inspectByConversationAsync(conversation)).toMatchObject({
          status: "available",
          binding: null,
        });
        expect(await listSessionBindingsBySessionAsync(target.targetSessionKey)).toEqual([]);
        expect(await readSessionBindingSelectionCurrent([conversation, conversation])).toEqual([
          null,
          null,
        ]);
        expect(
          await createBoundDeliveryRouter().resolveDestination({
            eventKind: "task_completion",
            targetSessionKey: target.targetSessionKey,
            requester: conversation,
            failClosed: true,
          }),
        ).toMatchObject({ mode: "fallback", binding: null });
        const routed = await resolveRuntimeConversationBindingRouteAsync({ route, conversation });
        expect(routed.route.sessionKey).toBe(route.sessionKey);
        expect(routed.bindingRecord).toBeNull();
        expect(adapter.touch).not.toHaveBeenCalled();
        expect(adapter.unbind).not.toHaveBeenCalled();
        // Selection is not a sweep: maintenance can still explicitly remove the saved row.
        expect(await service.unbind({ bindingId: saved.bindingId, reason: "user-unbind" })).toEqual(
          [saved],
        );
      }
      expect(durable.read).not.toHaveBeenCalled();
    },
  );

  it.each([
    { spawnDepth: 1 },
    { subagentRole: "leaf" as const },
    { spawnedBy: "agent:main:main" },
    { createdVia: "spawn" as const },
  ])("checks durable ACP delegation even when relabeled as a user binding: %j", async (lineage) => {
    const saved = record({
      targetSessionKey: "agent:worker:acp:delegated",
      targetKind: "session",
      metadata: { boundBy: "human-1" },
    });
    durable.entries.set(saved.targetSessionKey, { sessionId: "child", updatedAt: 1, ...lineage });
    const adapter = register(saved, true);
    await expect(
      getSessionBindingService().bind({ ...saved, placement: "current" }),
    ).rejects.toMatchObject({ code: "BINDING_CAPABILITY_UNSUPPORTED" });
    expect(adapter.bind).not.toHaveBeenCalled();
    expect(await getSessionBindingService().resolveByConversationAsync(conversation)).toBeNull();
    expect(await readSessionBindingSelectionCurrent([conversation])).toEqual([null]);
    expect(await listSessionBindingsBySessionAsync(saved.targetSessionKey)).toEqual([]);
    expect(durable.read).toHaveBeenCalled();
  });

  it.each([
    { targetSessionKey: "agent:worker:main", metadata: { boundBy: "system" } },
    { targetSessionKey: "agent:main:discord:channel:room:thread:ordinary" },
    { targetSessionKey: "agent:worker:acp:user-owned", metadata: { boundBy: "human-1" } },
  ])("preserves normal and explicit user ACP bindings: $targetSessionKey", async (target) => {
    const saved = record({ ...target, targetKind: "session" });
    durable.entries.set(saved.targetSessionKey, {
      sessionId: "user-session",
      updatedAt: 1,
      spawnDepth: 0,
      parentSessionKey: "agent:main:discord:channel:room",
    });
    register(saved, true);
    const service = getSessionBindingService();
    expect(await service.bind({ ...saved, placement: "current" })).toMatchObject(saved);
    expect(service.resolveByConversation(conversation)).toEqual(saved);
    expect(service.listBySession(saved.targetSessionKey)).toEqual([saved]);
    expect(await service.resolveByConversationAsync(conversation)).toEqual(saved);
    expect(await readSessionBindingSelectionCurrent([conversation])).toEqual([saved]);
    expect(await listSessionBindingsBySessionAsync(saved.targetSessionKey)).toEqual([saved]);
  });

  it.each(blockedTargets)(
    "rejects prepared delegated route facts for $targetSessionKey",
    (target) => {
      const saved = record(target);
      const prepare = () =>
        withConversationBindingRouteFacts(
          { ...route, sessionKey: saved.targetSessionKey },
          { kind: "agent", binding: saved, sessionKey: saved.targetSessionKey },
          route.agentId,
          conversation,
        );
      if (saved.targetSessionKey.trim().toLowerCase().startsWith("agent:")) {
        const facts = readConversationBindingRouteFacts(prepare())!;
        expect(matchesConversationBindingRouteFacts(facts, saved)).toBe(false);
      } else {
        // Unscoped legacy aliases are already rejected by the prepared-route producer.
        expect(prepare).toThrow("Session key does not contain an agent id");
      }
      const normal = inspectRuntimeConversationBindingRoute({
        route,
        inspection: { status: "available", binding: saved },
      });
      expect(normal.bindingRecord).toBeNull();
      expect(normal.route.sessionKey).toBe(route.sessionKey);
      expect(
        matchesConversationBindingRouteFacts(
          readConversationBindingRouteFacts(normal.route)!,
          saved,
        ),
      ).toBe(true);
    },
  );
});

it.each(["record", "descriptor"] as const)(
  "ignores a configured native child in the %s",
  (side) => {
    const ordinary = record({ targetSessionKey: "agent:worker:main", targetKind: "session" });
    const workerKey = "agent:worker:subagent:legacy";
    durable.configured.mockReturnValue({
      record: side === "record" ? { ...ordinary, targetSessionKey: workerKey } : ordinary,
      statefulTarget: {
        kind: "stateful",
        driverId: "test",
        agentId: "worker",
        sessionKey: side === "descriptor" ? workerKey : ordinary.targetSessionKey,
      },
    });
    expect(resolveConfiguredBindingRoute({ cfg: {}, route, conversation })).toMatchObject({
      bindingResolution: null,
      route,
    });
  },
);

it.each(["agent:worker:dashboard:visible", "agent:worker:renamed-child"])(
  "checks durable native provenance for %s",
  async (targetSessionKey) => {
    const saved = record({
      targetSessionKey,
      targetKind: "session",
      metadata: { boundBy: "human-1" },
    });
    durable.entries.set(targetSessionKey, {
      sessionId: "child",
      updatedAt: 1,
      spawnDepth: 1,
      spawnedBy: "agent:main:main",
    });
    const adapter = register(saved, true);
    await expect(getSessionBindingService().bind(saved)).rejects.toMatchObject({
      code: "BINDING_CAPABILITY_UNSUPPORTED",
    });
    expect(adapter.bind).not.toHaveBeenCalled();
    expect(await readSessionBindingSelectionCurrent([conversation])).toEqual([null]);
    expect(await listSessionBindingsBySessionAsync(targetSessionKey)).toEqual([]);
  },
);

it("rejects binding replacement while durable provenance is being inspected", async () => {
  let current = record({ targetSessionKey: "agent:worker:main", targetKind: "session" });
  registerSessionBindingAdapter({
    ...conversation,
    listBySession: () => [current],
    resolveByConversation: () => current,
    inspectByConversation: () => current,
  });
  durable.read.mockImplementationOnce(() => {
    current = { ...current, targetSessionKey: "agent:replacement:main" };
  });
  await expect(readSessionBindingSelectionCurrent([conversation])).rejects.toThrow(
    "binding changed during target inspection",
  );
});

it.each(["webchat", "tui", "heartbeat", "cron", "webhook", "voice", "sessions_send"])(
  "preserves internal session bindings for %s without inspecting worker provenance",
  async (channel) => {
    const internalConversation = { ...conversation, channel };
    const saved = {
      ...record({ targetSessionKey: "agent:worker:subagent:child", targetKind: "session" }),
      conversation: internalConversation,
    };
    const adapter = register(saved, true, internalConversation);
    const service = getSessionBindingService();
    expect(await service.bind({ ...saved, placement: "current" })).toMatchObject(saved);
    expect(service.resolveByConversation(internalConversation)).toEqual(saved);
    expect(await service.resolveByConversationAsync(internalConversation)).toEqual(saved);
    expect(await readSessionBindingSelectionCurrent([internalConversation])).toEqual([saved]);
    expect(await listSessionBindingsBySessionAsync(saved.targetSessionKey)).toEqual([saved]);
    expect(adapter.bind).toHaveBeenCalledTimes(1);
    expect(durable.read).not.toHaveBeenCalled();
  },
);

it("keeps internal and chat-channel classification separate for the same visible child", async () => {
  const targetSessionKey = "agent:worker:dashboard:mixed";
  durable.entries.set(targetSessionKey, { sessionId: "child", updatedAt: 1, spawnDepth: 1 });
  const internalConversation = { ...conversation, channel: "webchat" };
  const internal = {
    ...record({ targetSessionKey, targetKind: "session" }),
    bindingId: "internal",
    conversation: internalConversation,
  };
  register(internal, true, internalConversation);
  register(record({ targetSessionKey, targetKind: "session" }), true);
  expect(await listSessionBindingsBySessionAsync(targetSessionKey)).toEqual([internal]);
});

it.each(["resolve", "inspect", "list"] as const)(
  "rejects a replaced binding during %s provenance inspection",
  async (surface) => {
    let current = record({ targetSessionKey: "agent:worker:main", targetKind: "session" });
    registerSessionBindingAdapter({
      ...conversation,
      listBySession: () => [current],
      resolveByConversation: () => current,
      inspectByConversation: () => current,
    });
    durable.read.mockImplementationOnce(() => {
      current = { ...current, targetSessionKey: "agent:replacement:main" };
    });
    const service = getSessionBindingService();
    const read =
      surface === "resolve"
        ? service.resolveByConversationAsync(conversation)
        : surface === "inspect"
          ? service.inspectByConversationAsync(conversation)
          : listSessionBindingsBySessionAsync("agent:worker:main");
    await expect(read).rejects.toThrow("binding changed during target inspection");
  },
);

it.each([true, false])(
  "admits configured targets through durable provenance (delegated=%s)",
  async (delegated) => {
    const targetSessionKey = "agent:worker:dashboard:configured";
    const saved = record({ targetSessionKey, targetKind: "session" });
    durable.entries.set(targetSessionKey, {
      sessionId: "configured",
      updatedAt: 1,
      spawnDepth: delegated ? 1 : 0,
    });
    durable.configured.mockReturnValue({
      record: saved,
      statefulTarget: {
        kind: "stateful",
        driverId: "test",
        agentId: "worker",
        sessionKey: targetSessionKey,
      },
    });
    const projection = resolveConfiguredBindingRoute({ cfg: {}, route, conversation });
    const result = await ensureConfiguredBindingRouteReady({
      cfg: {},
      bindingResolution: projection.bindingResolution,
    });
    expect(result.ok).toBe(!delegated);
    expect(durable.ready).toHaveBeenCalledTimes(delegated ? 0 : 1);
  },
);
