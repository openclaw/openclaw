import { expectDefined } from "@openclaw/normalization-core";
import {
  inspectConversationBinding as inspectSessionBindingByConversation,
  type ConversationBindingInspection,
} from "openclaw/plugin-sdk/conversation-binding-inspection-runtime";
import { aroundEach, describe, expect, it, vi } from "vitest";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { readSessionBindingInspectionConversation } from "./session-binding-normalization.js";
import {
  testing,
  getSessionBindingService,
  isSessionBindingError,
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
  type SessionBindingAdapter,
  type SessionBindingBindInput,
  type SessionBindingRecord,
  type SessionBindingService,
  type ConversationRef,
} from "./session-binding-service.js";

type SessionBindingServiceModule = typeof import("./session-binding-service.js");

const sessionBindingServiceModuleUrl = new URL("./session-binding-service.ts", import.meta.url)
  .href;
const service = getSessionBindingService();
const unavailableCapabilities = {
  adapterAvailable: false,
  bindSupported: false,
  unbindSupported: false,
  placements: [],
};
const conversation = (channel: string, conversationId = "room-1"): ConversationRef => ({
  channel,
  accountId: "default",
  conversationId,
});
const bindInput = (
  ref: ConversationRef,
  overrides: Partial<SessionBindingBindInput> = {},
): SessionBindingBindInput => ({
  conversation: ref,
  targetSessionKey: "agent:main:shared",
  targetKind: "session",
  ...overrides,
});
const adapter = (overrides: Partial<SessionBindingAdapter> = {}): SessionBindingAdapter => ({
  channel: "adapter-chat",
  accountId: "default",
  listBySession: () => [],
  resolveByConversation: () => null,
  ...overrides,
});
const unregister = (owner: SessionBindingAdapter) =>
  unregisterSessionBindingAdapter({ ...owner, adapter: owner });
const bind = (ref: ConversationRef, overrides?: Partial<SessionBindingBindInput>) =>
  service.bind(bindInput(ref, overrides));
const register = (overrides: Partial<SessionBindingAdapter>) =>
  registerSessionBindingAdapter(adapter(overrides));
const expectInspection = (
  inspection: ConversationBindingInspection,
  ref: ConversationRef,
  expected: { status: "unavailable" } | { status: "available"; binding: null },
) => {
  expect(Object.fromEntries(Object.entries(inspection))).toEqual(expected);
  expect(readSessionBindingInspectionConversation(inspection)).toEqual(ref);
  expect(Object.isFrozen(readSessionBindingInspectionConversation(inspection))).toBe(true);
};

function setMinimalCurrentConversationRegistry(): void {
  setActivePluginRegistry(
    createTestRegistry(
      [
        { id: "workspace", conversationBindings: {} },
        { id: "teamchat", conversationBindings: {} },
        { id: "adapter-chat", conversationBindings: { bindingStore: "adapter" as const } },
        {
          id: "legacy-adapter-chat",
          conversationBindings: { createManager: () => ({ stop: () => undefined }) },
        },
      ].map(({ id, conversationBindings }) => ({
        pluginId: id,
        source: "test",
        plugin: {
          id,
          meta: { aliases: [] },
          conversationBindings: {
            supportsCurrentConversationBinding: true,
            ...conversationBindings,
          },
        },
      })),
    ),
  );
}

it("keeps the stable session-binding service shape structurally assignable", () => {
  const legacyService: SessionBindingService = {
    bind: async () => {
      throw new Error("not implemented");
    },
    getCapabilities: () => unavailableCapabilities,
    listBySession: () => [],
    resolveByConversation: () => null,
    touch: () => {},
    unbind: async () => [],
  };

  expect(legacyService.resolveByConversation(conversation("demo"))).toBeNull();
});

async function importSessionBindingServiceModule(
  cacheBust: string,
): Promise<SessionBindingServiceModule> {
  return (await import(
    `${sessionBindingServiceModuleUrl}?t=${cacheBust}`
  )) as SessionBindingServiceModule;
}

function createRecord(input: SessionBindingBindInput): SessionBindingRecord {
  const conversationId =
    input.placement === "child"
      ? "thread-created"
      : input.conversation.conversationId.trim() || "thread-current";
  return {
    bindingId: `${input.conversation.accountId}:${conversationId}`,
    targetSessionKey: input.targetSessionKey,
    targetKind: input.targetKind,
    conversation: {
      channel: input.conversation.channel,
      accountId: input.conversation.accountId,
      conversationId,
      parentConversationId: input.conversation.parentConversationId?.trim() || undefined,
    },
    status: "active",
    boundAt: 1,
  };
}

async function expectSessionBindingError(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({ code });
  return promise.catch((error: unknown) => error);
}

describe("session binding service", () => {
  aroundEach(async (run) =>
    withOpenClawTestState({ label: "session-binding", layout: "state-only" }, async () => {
      testing.resetSessionBindingAdaptersForTests();
      setMinimalCurrentConversationRegistry();
      try {
        await run();
      } finally {
        testing.resetSessionBindingAdaptersForTests();
      }
    }),
  );

  it.each([false, true])(
    "awaits async touch settlement (rejected: %s) without a legacy mutation",
    async (rejected) => {
      const gate = createDeferredCore();
      const failure = new Error("persistence rejected");
      const touch = vi.fn(() => {
        if (rejected) {
          throw failure;
        }
      });
      const touchAsync = vi.fn(() => gate.promise);
      register({ touch, touchAsync });
      const scope = { channel: "adapter-chat", accountId: "default" };
      let settled = false;
      const pending = service.touchAsync("binding-1", 123, scope).then(() => {
        settled = true;
      });
      const rejection = rejected ? expect(pending).rejects.toBe(failure) : undefined;
      await Promise.resolve();
      expect(touchAsync).toHaveBeenCalledWith("binding-1", 123);
      expect(touch).not.toHaveBeenCalled();
      expect(settled).toBe(false);
      if (rejected) {
        gate.reject(failure);
        await rejection;
        expect(touch).not.toHaveBeenCalled();
        expect(() => service.touch("binding-1", 1, scope)).toThrow(failure);
      } else {
        gate.resolve();
        await pending;
        expect(settled).toBe(true);
        service.touch("binding-1", 456, scope);
        expect(touch).toHaveBeenCalledWith("binding-1", 456);
        expect(touchAsync).toHaveBeenCalledTimes(1);
      }
    },
  );

  it.each(["keep", "remove", "replace"] as const)(
    "revalidates captured adapters after an earlier touch waits (%s)",
    async (change) => {
      const gate = createDeferredCore();
      const firstTouch = vi.fn(() => gate.promise);
      const secondTouch = vi.fn(async () => {});
      const replacementTouch = vi.fn(async () => {});
      const first = adapter({ accountId: "first", touchAsync: firstTouch });
      const second: SessionBindingAdapter = {
        ...first,
        accountId: "second",
        touchAsync: secondTouch,
      };
      registerSessionBindingAdapter(first);
      registerSessionBindingAdapter(second);
      const pending = service.touchAsync("binding-1", 123);
      expect(firstTouch).toHaveBeenCalledWith("binding-1", 123);
      expect(secondTouch).not.toHaveBeenCalled();
      if (change !== "keep") {
        unregister(second);
      }
      if (change === "replace") {
        registerSessionBindingAdapter({ ...second, touchAsync: replacementTouch });
      }
      gate.resolve();
      await pending;
      expect(secondTouch).toHaveBeenCalledTimes(change === "keep" ? 1 : 0);
      expect(replacementTouch).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["normalized implicit current", undefined, undefined, "subagent", "thread-1", undefined],
    ["explicit child", "child", ["child"], "session", "thread-created", undefined],
    [
      "unsupported child",
      "child",
      ["current"],
      "session",
      undefined,
      "BINDING_CAPABILITY_UNSUPPORTED",
    ],
    ["failed bind", undefined, undefined, "subagent", undefined, "BINDING_CREATE_FAILED"],
  ] as const)(
    "handles %s placement",
    async (_name, placement, placements, targetKind, expected, error) => {
      const adapterBind = vi.fn(async (input: SessionBindingBindInput) =>
        error === "BINDING_CREATE_FAILED" ? null : createRecord(input),
      );
      register({
        channel: "demo-binding",
        capabilities: { placements: placements ? [...placements] : undefined },
        bind: adapterBind,
        unbind: async () => [],
      });
      expect(service.getCapabilities({ channel: "demo-binding", accountId: "default" })).toEqual({
        adapterAvailable: true,
        bindSupported: true,
        unbindSupported: true,
        placements: placements ?? ["current", "child"],
      });
      expect(service.getCapabilities({ channel: "demo-binding", accountId: "other" })).toEqual(
        unavailableCapabilities,
      );
      const pending = bind(
        { channel: "Demo-Binding", accountId: "DEFAULT", conversationId: " thread-1 " },
        { targetSessionKey: "agent:main:subagent:child-1", targetKind, placement },
      );
      if (error) {
        const rejected = await expectSessionBindingError(pending, error);
        expect(isSessionBindingError(rejected)).toBe(true);
        if (placement) {
          expect(rejected).toMatchObject({
            message: 'Session binding placement "child" is not supported for demo-binding:default',
          });
        }
      } else {
        const result = await pending;
        expect(result.conversation).toMatchObject(conversation("demo-binding", expected));
        expect(adapterBind).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            placement: placement ?? "current",
            conversation: conversation("demo-binding", "thread-1"),
          }),
        );
      }
    },
  );

  it("keeps colliding adapter ids scoped while session-wide cleanup reaches every owner", async () => {
    const bindings: SessionBindingRecord[] = [];
    for (const channel of ["channel-a", "channel-b"]) {
      let current: SessionBindingRecord | null = null;
      registerSessionBindingAdapter({
        channel,
        accountId: "default",
        bind: async (input) => (current = createRecord(input)),
        resolveByConversation: () => current,
        listBySession: (key) => (current?.targetSessionKey === key ? [current] : []),
        touch: (id, at) => {
          if (current?.bindingId === id) {
            current = { ...current, metadata: { lastActivityAt: at } };
          }
        },
        unbind: async (input) => {
          if (
            !current ||
            (input.bindingId !== current.bindingId &&
              input.targetSessionKey !== current.targetSessionKey)
          ) {
            return [];
          }
          const removed = current;
          current = null;
          return [removed];
        },
      });
      bindings.push(await bind(conversation(channel)));
    }
    const first = expectDefined(bindings[0], "first binding");
    const second = expectDefined(bindings[1], "second binding");
    expect(first.bindingId).toBe(second.bindingId);
    expect(service.listBySession(first.targetSessionKey)).toEqual(bindings);

    const scope = { channel: " CHANNEL-A ", accountId: " DEFAULT " };
    service.touch(first.bindingId, 1234, scope);
    expect(service.resolveByConversation(first.conversation)?.metadata?.lastActivityAt).toBe(1234);
    expect(service.resolveByConversation(second.conversation)).toEqual(second);
    await expect(
      service.unbind({ bindingId: first.bindingId, scope, reason: "manual" }),
    ).resolves.toHaveLength(1);
    expect(service.resolveByConversation(first.conversation)).toBeNull();
    expect(service.resolveByConversation(second.conversation)).toEqual(second);

    await service.unbind({
      bindingId: second.bindingId,
      scope: { ...scope, accountId: "missing" },
      reason: "manual",
    });
    expect(service.resolveByConversation(second.conversation)).toEqual(second);
    const rebound = await bind(first.conversation, {
      targetSessionKey: first.targetSessionKey,
      targetKind: first.targetKind,
    });
    expect(rebound.bindingId).toBe(first.bindingId);
    expect(
      await service.unbind({ targetSessionKey: first.targetSessionKey, reason: "session-ended" }),
    ).toEqual([rebound, second]);
    expect(service.listBySession(first.targetSessionKey)).toEqual([]);
  });

  it("honors owner scopes for generic touch, detach, and session cleanup", async () => {
    const first = await bind(conversation("workspace"));
    const second = await bind(conversation("teamchat"), {
      targetSessionKey: first.targetSessionKey,
    });
    service.touch(first.bindingId, 1234, second.conversation);
    expect(service.resolveByConversation(first.conversation)).toEqual(first);
    await expect(
      service.unbind({ bindingId: first.bindingId, scope: second.conversation, reason: "manual" }),
    ).resolves.toEqual([]);
    service.touch(first.bindingId, 1234, first.conversation);
    expect(service.resolveByConversation(first.conversation)?.metadata?.lastActivityAt).toBe(1234);
    await expect(
      service.unbind({
        targetSessionKey: first.targetSessionKey,
        scope: first.conversation,
        reason: "session-ended",
      }),
    ).resolves.toHaveLength(1);
    expect(service.resolveByConversation(first.conversation)).toBeNull();
    closeOpenClawStateDatabaseForTest();
    expect(service.resolveByConversation(second.conversation)).toEqual(second);
  });

  it.each(["adapter-chat", "legacy-adapter-chat"])(
    "distinguishes an unavailable %s owner from an empty result",
    async (channel) => {
      const ref = conversation(channel);

      expect(service.getCapabilities(ref)).toEqual(unavailableCapabilities);
      expectInspection(inspectSessionBindingByConversation(ref), ref, { status: "unavailable" });
      await expectSessionBindingError(
        bind(ref, { targetSessionKey: "agent:finance:bound" }),
        "BINDING_ADAPTER_UNAVAILABLE",
      );
      const owner = adapter({ channel });
      registerSessionBindingAdapter(owner);
      expectInspection(inspectSessionBindingByConversation(ref), ref, {
        status: "available",
        binding: null,
      });
      unregister(owner);
      expect(Object.fromEntries(Object.entries(inspectSessionBindingByConversation(ref)))).toEqual({
        status: "unavailable",
      });
    },
  );

  it("falls back to generic current-conversation bindings for registered channels", async () => {
    const ref = conversation("workspace", "user:U123");
    const input = bindInput(ref, { targetSessionKey: "agent:codex:acp:workspace-dm" });
    expect(service.getCapabilities({ channel: "Workspace", accountId: " DEFAULT " })).toEqual({
      adapterAvailable: true,
      bindSupported: true,
      unbindSupported: true,
      placements: ["current"],
    });

    const rejected = await expectSessionBindingError(
      service.bind({ ...input, placement: "child" }),
      "BINDING_CAPABILITY_UNSUPPORTED",
    );
    expect(rejected).toMatchObject({
      message: 'Session binding placement "child" is not supported for workspace:default',
    });

    const bound = await service.bind({
      ...input,
      conversation: {
        channel: " Workspace ",
        accountId: " DEFAULT ",
        conversationId: " user:U123 ",
      },
      metadata: { label: "workspace-dm" },
      ttlMs: 60_000,
    });

    expect(bound).toMatchObject({
      bindingId: "generic:workspace\u241fdefault\u241f\u241fuser:U123",
      targetSessionKey: "agent:codex:acp:workspace-dm",
      targetKind: "session",
      status: "active",
      conversation: ref,
      metadata: { label: "workspace-dm" },
    });

    const resolved = service.resolveByConversation(ref);
    expect(resolved).toMatchObject({
      bindingId: bound.bindingId,
      targetSessionKey: "agent:codex:acp:workspace-dm",
    });
    expect(service.listBySession("agent:codex:acp:workspace-dm")).toEqual([resolved]);

    service.touch(bound.bindingId, 1234);
    expect(service.resolveByConversation(bound.conversation)?.metadata).toMatchObject({
      label: "workspace-dm",
      lastActivityAt: 1234,
    });

    const unbound = await service.unbind({
      targetSessionKey: "agent:codex:acp:workspace-dm",
      reason: "test cleanup",
    });
    expect(unbound).toHaveLength(1);
    expect(unbound[0]?.bindingId).toBe(bound.bindingId);
    expect(service.resolveByConversation(ref)).toBeNull();
  });

  it("hides spawned-worker bindings that own the current conversation but keeps child threads", async () => {
    const current = conversation("workspace", "user:U123");
    const workerKey = "agent:main:subagent:legacy-worker";
    await bind(current, {
      targetSessionKey: workerKey,
      targetKind: "subagent",
      metadata: { boundBy: "system" },
    });

    expect(service.resolveByConversation(current)).toBeNull();
    await expect(service.resolveByConversationAsync(current)).resolves.toBeNull();
    expect(inspectSessionBindingByConversation(current)).toMatchObject({ binding: null });
    expect(service.listBySession(workerKey)).toEqual([]);

    // A user's explicit bind of the same conversation still owns it.
    await bind(current, {
      targetSessionKey: "agent:codex:acp:user-owned",
      metadata: { boundBy: "U123" },
    });
    expect(service.resolveByConversation(current)?.targetSessionKey).toBe(
      "agent:codex:acp:user-owned",
    );

    const childThread = conversation("adapter-chat", "thread-created");
    register({
      ...childThread,
      capabilities: { bindSupported: true, placements: ["current", "child"] },
      resolveByConversation: (ref) => ({
        ...createRecord(bindInput(ref, { targetSessionKey: workerKey, targetKind: "subagent" })),
        metadata: { boundBy: "system" },
      }),
    });
    expect(service.resolveByConversation(childThread)?.targetSessionKey).toBe(workerKey);
  });

  it("shares registered adapters across duplicate module instances", async () => {
    const first = await importSessionBindingServiceModule(`first-${Date.now()}`);
    const second = await importSessionBindingServiceModule(`second-${Date.now()}`);
    const firstBind = vi.fn(async (input: SessionBindingBindInput) => createRecord(input));
    const secondBind = vi.fn(async (input: SessionBindingBindInput) => createRecord(input));
    const binding = (conversationId: string) =>
      createRecord(
        bindInput(conversation("demo-binding", conversationId), { targetSessionKey: "agent:main" }),
      );
    const firstBinding = binding("thread-1"),
      secondBinding = binding("thread-2");
    const firstAdapter = adapter({
      channel: "demo-binding",
      bind: firstBind,
      listBySession: (key) => (key === "agent:main" ? [firstBinding] : []),
    });
    const secondAdapter = adapter({
      channel: "Demo-Binding",
      accountId: "DEFAULT",
      bind: secondBind,
      listBySession: (key) => (key === "agent:main" ? [secondBinding] : []),
    });

    first.testing.resetSessionBindingAdaptersForTests();
    first.registerSessionBindingAdapter(firstAdapter);
    second.registerSessionBindingAdapter(secondAdapter);

    expect(second.testing.getRegisteredAdapterKeys()).toEqual(["demo-binding:default"]);
    expect(second.getSessionBindingService().listBySession("agent:main")).toEqual([secondBinding]);

    const sharedService = second.getSessionBindingService();
    const bindChild = (index: number) =>
      sharedService.bind(
        bindInput(conversation("demo-binding", `thread-${index}`), {
          targetSessionKey: `agent:main:subagent:child-${index}`,
          targetKind: "subagent",
        }),
      );
    const secondBound = await bindChild(1);
    expect(secondBound.conversation).toMatchObject(conversation("demo-binding", "thread-1"));
    expect(firstBind).not.toHaveBeenCalled();
    expect(secondBind).toHaveBeenCalledTimes(1);

    second.unregisterSessionBindingAdapter({ ...secondAdapter, adapter: secondAdapter });

    expect(second.getSessionBindingService().listBySession("agent:main")).toEqual([firstBinding]);
    const firstBound = await bindChild(2);
    expect(firstBound.conversation).toMatchObject(conversation("demo-binding", "thread-2"));
    expect(firstBind).toHaveBeenCalledTimes(1);
    expect(secondBind).toHaveBeenCalledTimes(1);

    first.unregisterSessionBindingAdapter({ ...firstAdapter, adapter: firstAdapter });

    expect(second.getSessionBindingService().listBySession("agent:main")).toStrictEqual([]);
    await expectSessionBindingError(bindChild(3), "BINDING_ADAPTER_UNAVAILABLE");

    first.testing.resetSessionBindingAdaptersForTests();
  });
});
