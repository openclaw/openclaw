// Covers session binding adapter registration, generic current-conversation
// fallback, capability errors, deduping, and duplicate graph teardown.
import { expectDefined } from "@openclaw/normalization-core";
import {
  inspectConversationBinding as inspectSessionBindingByConversation,
  type ConversationBindingInspection,
} from "openclaw/plugin-sdk/conversation-binding-inspection-runtime";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
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
} from "./session-binding-service.js";

type SessionBindingServiceModule = typeof import("./session-binding-service.js");

const sessionBindingServiceModuleUrl = new URL("./session-binding-service.ts", import.meta.url)
  .href;
const tempDirs = createTrackedTempDirs();

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
  const service: SessionBindingService = {
    bind: async () => {
      throw new Error("not implemented");
    },
    getCapabilities: () => ({
      adapterAvailable: false,
      bindSupported: false,
      unbindSupported: false,
      placements: [],
    }),
    listBySession: () => [],
    resolveByConversation: () => null,
    touch: () => {},
    unbind: async () => [],
  };

  expect(
    service.resolveByConversation({
      channel: "demo",
      accountId: "default",
      conversationId: "room-1",
    }),
  ).toBeNull();
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

const requireRecord = createRequireRecord("record", "expected-label-record");

async function expectSessionBindingError(promise: Promise<unknown>, code: string) {
  try {
    await promise;
  } catch (error) {
    expect(requireRecord(error, "session binding error").code).toBe(code);
    return error;
  }
  throw new Error(`expected ${code} session binding error`);
}

describe("session binding service", () => {
  let previousStateDir: string | undefined;
  let testStateDir = "";

  beforeEach(async () => {
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    testStateDir = await tempDirs.make("openclaw-session-binding-");
    process.env.OPENCLAW_STATE_DIR = testStateDir;
    testing.resetSessionBindingAdaptersForTests();
    setMinimalCurrentConversationRegistry();
  });

  afterEach(async () => {
    testing.resetSessionBindingAdaptersForTests();
    closeOpenClawStateDatabaseForTest();
    if (previousStateDir == null) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    await tempDirs.cleanup();
  });

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
      registerSessionBindingAdapter({
        channel: "adapter-chat",
        accountId: "default",
        listBySession: () => [],
        resolveByConversation: () => null,
        touch,
        touchAsync,
      });
      const service = getSessionBindingService();
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
      const first: SessionBindingAdapter = {
        channel: "adapter-chat",
        accountId: "first",
        listBySession: () => [],
        resolveByConversation: () => null,
        touchAsync: firstTouch,
      };
      const second: SessionBindingAdapter = {
        ...first,
        accountId: "second",
        touchAsync: secondTouch,
      };
      registerSessionBindingAdapter(first);
      registerSessionBindingAdapter(second);
      const pending = getSessionBindingService().touchAsync("binding-1", 123);
      expect(firstTouch).toHaveBeenCalledWith("binding-1", 123);
      expect(secondTouch).not.toHaveBeenCalled();
      if (change !== "keep") {
        unregisterSessionBindingAdapter({
          channel: second.channel,
          accountId: second.accountId,
          adapter: second,
        });
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
    {
      name: "normalized implicit current",
      placement: undefined,
      placements: undefined,
      targetKind: "subagent",
      expected: "thread-1",
    },
    {
      name: "explicit child",
      placement: "child",
      placements: ["child"],
      targetKind: "session",
      expected: "thread-created",
    },
    {
      name: "unsupported child",
      placement: "child",
      placements: ["current"],
      targetKind: "session",
      error: "BINDING_CAPABILITY_UNSUPPORTED",
    },
    {
      name: "failed bind",
      placement: undefined,
      placements: undefined,
      targetKind: "subagent",
      error: "BINDING_CREATE_FAILED",
    },
  ] satisfies Array<{
    name: string;
    placement: SessionBindingBindInput["placement"];
    placements: NonNullable<SessionBindingAdapter["capabilities"]>["placements"];
    targetKind: SessionBindingBindInput["targetKind"];
    expected?: string;
    error?: string;
  }>)("handles $name placement", async ({ placement, placements, targetKind, expected, error }) => {
    const bind = vi.fn(async (input: SessionBindingBindInput) =>
      error === "BINDING_CREATE_FAILED" ? null : createRecord(input),
    );
    registerSessionBindingAdapter({
      channel: "demo-binding",
      accountId: "default",
      capabilities: { placements },
      bind,
      listBySession: () => [],
      resolveByConversation: () => null,
      unbind: async () => [],
    });
    const service = getSessionBindingService();
    expect(service.getCapabilities({ channel: "demo-binding", accountId: "default" })).toEqual({
      adapterAvailable: true,
      bindSupported: true,
      unbindSupported: true,
      placements: placements ?? ["current", "child"],
    });
    expect(service.getCapabilities({ channel: "demo-binding", accountId: "other" })).toEqual({
      adapterAvailable: false,
      bindSupported: false,
      unbindSupported: false,
      placements: [],
    });
    const pending = service.bind({
      targetSessionKey: "agent:main:subagent:child-1",
      targetKind,
      placement,
      conversation: { channel: "Demo-Binding", accountId: "DEFAULT", conversationId: " thread-1 " },
    });
    if (error) {
      const rejected = await expectSessionBindingError(pending, error);
      expect(isSessionBindingError(rejected)).toBe(true);
      if (placement) {
        expect(rejected).toMatchObject({ details: { placement } });
      }
    } else {
      const result = await pending;
      expect(result.conversation).toMatchObject({
        channel: "demo-binding",
        accountId: "default",
        conversationId: expected,
      });
      expect(bind).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          placement: placement ?? "current",
          conversation: {
            channel: "demo-binding",
            accountId: "default",
            conversationId: "thread-1",
          },
        }),
      );
    }
  });

  it("keeps colliding adapter ids scoped while session-wide cleanup reaches every owner", async () => {
    const service = getSessionBindingService();
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
      bindings.push(
        await service.bind({
          conversation: { channel, accountId: "default", conversationId: "room-1" },
          targetSessionKey: "agent:main:shared",
          targetKind: "session",
        }),
      );
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
    const rebound = await service.bind({
      targetSessionKey: first.targetSessionKey,
      targetKind: first.targetKind,
      conversation: first.conversation,
    });
    expect(rebound.bindingId).toBe(first.bindingId);
    expect(
      await service.unbind({ targetSessionKey: first.targetSessionKey, reason: "session-ended" }),
    ).toEqual([rebound, second]);
    expect(service.listBySession(first.targetSessionKey)).toEqual([]);
  });

  it("honors owner scopes for generic touch, detach, and session cleanup", async () => {
    const service = getSessionBindingService();
    const first = await service.bind({
      targetSessionKey: "agent:main:shared",
      targetKind: "session",
      conversation: { channel: "workspace", accountId: "default", conversationId: "room-1" },
    });
    const second = await service.bind({
      targetSessionKey: first.targetSessionKey,
      targetKind: "session",
      conversation: { channel: "teamchat", accountId: "default", conversationId: "room-1" },
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
      const service = getSessionBindingService();
      const conversation = {
        channel,
        accountId: "default",
        conversationId: "room-1",
      };

      expect(service.getCapabilities(conversation)).toEqual({
        adapterAvailable: false,
        bindSupported: false,
        unbindSupported: false,
        placements: [],
      });
      const unavailable: ConversationBindingInspection =
        inspectSessionBindingByConversation(conversation);
      expect(Object.fromEntries(Object.entries(unavailable))).toEqual({
        status: "unavailable",
      });
      expect(readSessionBindingInspectionConversation(unavailable)).toEqual(conversation);
      expect(Object.isFrozen(readSessionBindingInspectionConversation(unavailable))).toBe(true);
      await expectSessionBindingError(
        service.bind({
          targetSessionKey: "agent:finance:bound",
          targetKind: "session",
          conversation,
        }),
        "BINDING_ADAPTER_UNAVAILABLE",
      );
      const adapter: SessionBindingAdapter = {
        channel,
        accountId: "default",
        listBySession: () => [],
        resolveByConversation: () => null,
      };
      registerSessionBindingAdapter(adapter);
      const empty = inspectSessionBindingByConversation(conversation);
      expect(Object.fromEntries(Object.entries(empty))).toEqual({
        status: "available",
        binding: null,
      });
      expect(readSessionBindingInspectionConversation(empty)).toEqual(conversation);
      expect(Object.isFrozen(readSessionBindingInspectionConversation(empty))).toBe(true);
      unregisterSessionBindingAdapter({ channel, accountId: "default", adapter });
      expect(
        Object.fromEntries(Object.entries(inspectSessionBindingByConversation(conversation))),
      ).toEqual({
        status: "unavailable",
      });
    },
  );

  it("falls back to generic current-conversation bindings for registered channels", async () => {
    const service = getSessionBindingService();

    expect(
      service.getCapabilities({
        channel: "Workspace",
        accountId: " DEFAULT ",
      }),
    ).toEqual({
      adapterAvailable: true,
      bindSupported: true,
      unbindSupported: true,
      placements: ["current"],
    });

    const rejected = await expectSessionBindingError(
      service.bind({
        targetSessionKey: "agent:codex:acp:workspace-dm",
        targetKind: "session",
        conversation: { channel: "workspace", accountId: "default", conversationId: "user:U123" },
        placement: "child",
      }),
      "BINDING_CAPABILITY_UNSUPPORTED",
    );
    expect(rejected).toMatchObject({
      details: { channel: "workspace", accountId: "default", placement: "child" },
    });

    const bound = await service.bind({
      targetSessionKey: "agent:codex:acp:workspace-dm",
      targetKind: "session",
      conversation: {
        channel: " Workspace ",
        accountId: " DEFAULT ",
        conversationId: " user:U123 ",
      },
      metadata: {
        label: "workspace-dm",
      },
      ttlMs: 60_000,
    });

    expect(bound).toMatchObject({
      bindingId: "generic:workspace\u241fdefault\u241f\u241fuser:U123",
      targetSessionKey: "agent:codex:acp:workspace-dm",
      targetKind: "session",
      status: "active",
    });
    expect(bound.conversation).toMatchObject({
      channel: "workspace",
      accountId: "default",
      conversationId: "user:U123",
    });
    expect(bound.metadata).toMatchObject({
      label: "workspace-dm",
    });

    const resolved = service.resolveByConversation({
      channel: "workspace",
      accountId: "default",
      conversationId: "user:U123",
    });
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
    expect(
      service.resolveByConversation({
        channel: "workspace",
        accountId: "default",
        conversationId: "user:U123",
      }),
    ).toBeNull();
  });

  it("hides spawned-worker bindings that own the current conversation but keeps child threads", async () => {
    const service = getSessionBindingService();
    const current = { channel: "workspace", accountId: "default", conversationId: "user:U123" };
    const workerKey = "agent:main:subagent:legacy-worker";
    await service.bind({
      targetSessionKey: workerKey,
      targetKind: "subagent",
      conversation: current,
      metadata: { boundBy: "system" },
    });

    expect(service.resolveByConversation(current)).toBeNull();
    await expect(service.resolveByConversationAsync(current)).resolves.toBeNull();
    expect(inspectSessionBindingByConversation(current)).toMatchObject({ binding: null });
    expect(service.listBySession(workerKey)).toEqual([]);

    // A user's explicit bind of the same conversation still owns it.
    await service.bind({
      targetSessionKey: "agent:codex:acp:user-owned",
      targetKind: "session",
      conversation: current,
      metadata: { boundBy: "U123" },
    });
    expect(service.resolveByConversation(current)?.targetSessionKey).toBe(
      "agent:codex:acp:user-owned",
    );

    const childThread = {
      channel: "adapter-chat",
      accountId: "default",
      conversationId: "thread-created",
    };
    registerSessionBindingAdapter({
      ...childThread,
      capabilities: { bindSupported: true, placements: ["current", "child"] },
      listBySession: () => [],
      resolveByConversation: (ref) => ({
        ...createRecord({ targetSessionKey: workerKey, targetKind: "subagent", conversation: ref }),
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
      createRecord({
        targetSessionKey: "agent:main",
        targetKind: "session",
        conversation: { channel: "demo-binding", accountId: "default", conversationId },
      });
    const firstBinding = binding("thread-1"),
      secondBinding = binding("thread-2");
    const firstAdapter: SessionBindingAdapter = {
      channel: "demo-binding",
      accountId: "default",
      bind: firstBind,
      listBySession: (key) => (key === "agent:main" ? [firstBinding] : []),
      resolveByConversation: () => null,
    };
    const secondAdapter: SessionBindingAdapter = {
      channel: "Demo-Binding",
      accountId: "DEFAULT",
      bind: secondBind,
      listBySession: (key) => (key === "agent:main" ? [secondBinding] : []),
      resolveByConversation: () => null,
    };

    first.testing.resetSessionBindingAdaptersForTests();
    first.registerSessionBindingAdapter(firstAdapter);
    second.registerSessionBindingAdapter(secondAdapter);

    expect(second.testing.getRegisteredAdapterKeys()).toEqual(["demo-binding:default"]);
    expect(second.getSessionBindingService().listBySession("agent:main")).toEqual([secondBinding]);

    const secondBound = await second.getSessionBindingService().bind({
      targetSessionKey: "agent:main:subagent:child-1",
      targetKind: "subagent",
      conversation: {
        channel: "demo-binding",
        accountId: "default",
        conversationId: "thread-1",
      },
    });
    expect(secondBound.conversation).toMatchObject({
      channel: "demo-binding",
      accountId: "default",
      conversationId: "thread-1",
    });
    expect(firstBind).not.toHaveBeenCalled();
    expect(secondBind).toHaveBeenCalledTimes(1);

    second.unregisterSessionBindingAdapter({
      channel: "demo-binding",
      accountId: "default",
      adapter: secondAdapter,
    });

    expect(second.getSessionBindingService().listBySession("agent:main")).toEqual([firstBinding]);
    const firstBound = await second.getSessionBindingService().bind({
      targetSessionKey: "agent:main:subagent:child-2",
      targetKind: "subagent",
      conversation: {
        channel: "demo-binding",
        accountId: "default",
        conversationId: "thread-2",
      },
    });
    expect(firstBound.conversation).toMatchObject({
      channel: "demo-binding",
      accountId: "default",
      conversationId: "thread-2",
    });
    expect(firstBind).toHaveBeenCalledTimes(1);
    expect(secondBind).toHaveBeenCalledTimes(1);

    first.unregisterSessionBindingAdapter({
      channel: "demo-binding",
      accountId: "default",
      adapter: firstAdapter,
    });

    expect(second.getSessionBindingService().listBySession("agent:main")).toStrictEqual([]);
    await expectSessionBindingError(
      second.getSessionBindingService().bind({
        targetSessionKey: "agent:main:subagent:child-3",
        targetKind: "subagent",
        conversation: {
          channel: "demo-binding",
          accountId: "default",
          conversationId: "thread-3",
        },
      }),
      "BINDING_ADAPTER_UNAVAILABLE",
    );

    first.testing.resetSessionBindingAdaptersForTests();
  });
});
