import {
  registerSessionBindingAdapterV2 as registerSdkSessionBindingAdapter,
  type SessionBindingAdapterV2,
} from "openclaw/plugin-sdk/thread-bindings-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withPluginRuntimePluginScope } from "../../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createAccountScopedBindingAdapterV2 } from "./session-binding-adapter.js";
import { readSessionBindingInspectionConversation } from "./session-binding-normalization.js";
import {
  getSessionBindingService,
  readSessionBindingSelectionCurrent,
  registerSessionBindingAdapter,
  registerSessionBindingAdapterV2,
  testing,
  unregisterSessionBindingAdapter,
  type SessionBindingAdapter,
  type SessionBindingRecord,
} from "./session-binding-service.js";

afterEach(() => testing.resetSessionBindingAdaptersForTests());
const service = getSessionBindingService();

const record: SessionBindingRecord = {
  bindingId: "external-binding",
  targetSessionKey: "agent:owner:main",
  targetKind: "session",
  conversation: { channel: "external", accountId: "default", conversationId: "room" },
  status: "active",
  boundAt: 1,
};
const ref = record.conversation;
function register(overrides: Partial<SessionBindingAdapter>) {
  const owner: SessionBindingAdapter = {
    channel: "external",
    accountId: "default",
    listBySession: () => [],
    resolveByConversation: () => null,
    ...overrides,
  };
  registerSessionBindingAdapter(owner);
  return owner;
}
function createV2(
  assertCurrent = () => {},
  assertSourceCurrent = () => {},
  legacyRead = () => record,
) {
  return {
    ...createAccountScopedBindingAdapterV2({
      channel: "external",
      accountId: "default",
      capabilities: {},
      assertCurrent,
      bind: async () => record,
      project: (entry: SessionBindingRecord) => entry,
      listBySessionKey: () => [legacyRead()],
      getByConversation: legacyRead,
      touchConversation: () => {},
      unbindConversation: () => null,
      unbindBySessionKey: () => [],
      listBySessionKeyAsync: async () => [record],
      getByConversationAsync: async () => record,
      inspectByConversationAsync: async () => record,
      inspectByConversations: (refs) => ({
        records: refs.map(() => record),
        assertCurrent: assertSourceCurrent,
      }),
      touchConversationAsync: async () => {},
    }),
    inspectByConversation: legacyRead,
  };
}

describe("awaited binding read ownership", () => {
  it("retains class adapter methods and their receiver through SDK registration", async () => {
    class Adapter implements SessionBindingAdapterV2 {
      readonly version = 2;
      readonly channel = " External ";
      readonly accountId = " DEFAULT ";
      #binding: SessionBindingRecord | null = record;

      assertCurrent() {
        if (!this.#binding) {
          throw new Error("adapter closed");
        }
      }
      listBySession(key: string) {
        return this.#binding?.targetSessionKey === key ? [this.#binding] : [];
      }
      resolveByConversation(
        conversation: Parameters<SessionBindingAdapterV2["resolveByConversation"]>[0],
      ) {
        return this.#binding?.conversation.conversationId === conversation.conversationId
          ? this.#binding
          : null;
      }
      async listBySessionAsync(key: string) {
        return this.listBySession(key);
      }
      async resolveByConversationAsync(
        conversation: Parameters<SessionBindingAdapterV2["resolveByConversation"]>[0],
      ) {
        return this.resolveByConversation(conversation);
      }
      async inspectByConversationAsync(
        conversation: Parameters<SessionBindingAdapterV2["resolveByConversation"]>[0],
      ) {
        return this.resolveByConversation(conversation);
      }
      async inspectByConversationsAsync(
        refs: Parameters<SessionBindingAdapterV2["inspectByConversationsAsync"]>[0],
      ) {
        return {
          bindings: refs.map((conversation) => this.resolveByConversation(conversation)),
          assertCurrent: () => this.assertCurrent(),
        };
      }
      async bind(input: Parameters<NonNullable<SessionBindingAdapterV2["bind"]>>[0]) {
        input.assertCurrent?.();
        this.#binding = {
          ...record,
          targetSessionKey: input.targetSessionKey,
          conversation: input.conversation,
        };
        return this.#binding;
      }
      async touchAsync(_id: string, at = 1) {
        this.#binding = this.#binding ? { ...this.#binding, boundAt: at } : null;
      }
      async unbind() {
        const removed = this.#binding ? [this.#binding] : [];
        this.#binding = null;
        return removed;
      }
    }

    const adapter = new Adapter();
    registerSdkSessionBindingAdapter(adapter);
    const scope = { channel: "external", accountId: "default" };
    expect(service.getCapabilities(scope)).toMatchObject({
      adapterAvailable: true,
      bindSupported: true,
      unbindSupported: true,
    });
    expect(await service.resolveByConversationAsync(record.conversation)).toBe(record);
    const bound = await service.bind({
      targetSessionKey: "agent:owner:other",
      targetKind: "session",
      conversation: { ...record.conversation, channel: " External ", accountId: " DEFAULT " },
    });
    expect(bound.conversation).toEqual(record.conversation);
    await service.touchAsync(bound.bindingId, 42, scope);
    expect(await service.resolveByConversationAsync(record.conversation)).toMatchObject({
      targetSessionKey: "agent:owner:other",
      boundAt: 42,
    });
    expect(await service.unbind({ scope, reason: "test" })).toHaveLength(1);
    expect(adapter.channel).toBe(" External ");
    expect(adapter.accountId).toBe(" DEFAULT ");
    unregisterSessionBindingAdapter({ ...scope, adapter });
    expect(testing.getRegisteredAdapterKeys()).toEqual([]);
  });

  it.each([false, true])(
    "inspects admission without resolver mutations (async=%s)",
    async (asyncInspector) => {
      const resolve = vi.fn(() => record);
      register({
        inspectByConversation: () => record,
        ...(asyncInspector ? { inspectByConversationAsync: async () => record } : {}),
        resolveByConversation: resolve,
        resolveByConversationAsync: async () => resolve(),
      });
      expect(await readSessionBindingSelectionCurrent([ref])).toEqual([record]);
      expect(resolve).not.toHaveBeenCalled();
    },
  );

  it.each([
    [true, "keep"],
    [true, "remove"],
    [true, "replace"],
    [false, "keep"],
    [false, "remove"],
    [false, "replace"],
  ] as const)("revalidates the adapter after read (inspect=%s, %s)", async (inspect, change) => {
    const gate = createDeferredCore<SessionBindingRecord | null>();
    const entered = createDeferredCore();
    const read = vi.fn(() => {
      entered.resolve();
      return gate.promise;
    });
    const legacyRead = vi.fn(() => record);
    const owner = register({
      resolveByConversation: legacyRead,
      inspectByConversation: legacyRead,
      inspectByConversationAsync: read,
      resolveByConversationAsync: read,
    });
    const mutableRef = { ...record.conversation };
    const pending = inspect
      ? service.inspectByConversationAsync(mutableRef)
      : service.resolveByConversationAsync(mutableRef);
    const rejection =
      !inspect && change !== "keep"
        ? expect(pending).rejects.toMatchObject({ code: "BINDING_ADAPTER_UNAVAILABLE" })
        : undefined;
    await entered.promise;
    mutableRef.accountId = "unrelated";
    if (change === "remove") {
      unregisterSessionBindingAdapter({ ...owner, adapter: owner });
    } else if (change === "replace") {
      registerSessionBindingAdapter({ ...owner, resolveByConversation: () => null });
    }
    gate.resolve(record);
    if (rejection) {
      await rejection;
    } else {
      const result = await pending;
      expect(result && inspect ? Object.fromEntries(Object.entries(result)) : result).toEqual(
        inspect
          ? change === "keep"
            ? { status: "available", binding: record }
            : { status: "unavailable" }
          : record,
      );
    }
    expect(legacyRead).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledExactlyOnceWith(record.conversation);
  });

  it("never calls a V2 adapter's synchronous compatibility readers", async () => {
    const legacy = () => {
      throw new Error("legacy reader must not run");
    };
    let active = true;
    let sourceCurrent = true;
    registerSessionBindingAdapterV2(
      createV2(
        () => {
          if (!active) {
            throw new Error("closed adapter");
          }
        },
        () => {
          if (!sourceCurrent) {
            throw new Error("binding source changed");
          }
        },
        legacy,
      ),
    );
    expect(await service.resolveByConversationAsync(ref)).toEqual(record);
    expect(await readSessionBindingSelectionCurrent([ref])).toEqual([record]);
    sourceCurrent = false;
    await expect(readSessionBindingSelectionCurrent([ref])).rejects.toThrow(
      "binding source changed",
    );
    active = false;
    await expect(service.resolveByConversationAsync(ref)).rejects.toThrow("closed adapter");
  });

  it("warns once per legacy binding method while V2 construction and reads stay silent", async () => {
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    const run = <T>(body: () => T) =>
      withPluginRuntimePluginScope({ pluginId: "binding-sdk-compat-fixture" }, body);
    try {
      await run(async () => {
        registerSessionBindingAdapterV2(createV2());
        expect(await service.resolveByConversationAsync(ref)).toEqual(record);
        expect(warning).not.toHaveBeenCalled();
        expect(service.resolveByConversation(ref)).toEqual(record);
        service.touch("", undefined, ref);
      });
      run(() => service.resolveByConversation(ref));
      expect(warning.mock.calls).toEqual([
        [
          expect.stringContaining(
            "SessionBindingService.resolveByConversation is deprecated; use SessionBindingService.resolveByConversationAsync",
          ),
          { code: "DEP_PLUGIN_SDK", type: "DeprecationWarning" },
        ],
        [
          expect.stringContaining(
            "SessionBindingAdapter.resolveByConversation is deprecated; use SessionBindingAdapterV2.resolveByConversationAsync",
          ),
          { code: "DEP_PLUGIN_SDK", type: "DeprecationWarning" },
        ],
        [
          expect.stringContaining(
            "SessionBindingService.touch is deprecated; use SessionBindingService.touchAsync",
          ),
          { code: "DEP_PLUGIN_SDK", type: "DeprecationWarning" },
        ],
      ]);
      const message = warning.mock.calls[0]?.[0];
      expect(message).toContain(
        "Plugin binding-sdk-compat-fixture: SessionBindingService.resolveByConversation",
      );
      expect(message).toContain("SessionBindingService.resolveByConversationAsync");
      expect(message).toContain("Final compatibility day: 2026-12-31");
    } finally {
      warning.mockRestore();
    }
  });

  it("retains the explicit reader fallback for a legacy external adapter", async () => {
    const resolve = vi.fn(() => record);
    register({ resolveByConversation: resolve });
    const inspection = await service.inspectByConversationAsync(ref);
    expect(readSessionBindingInspectionConversation(inspection)).toEqual(ref);
    expect(Object.isFrozen(readSessionBindingInspectionConversation(inspection))).toBe(true);
    expect(Object.fromEntries(Object.entries(inspection))).toEqual({
      status: "available",
      binding: record,
    });
    expect(await service.resolveByConversationAsync(ref)).toEqual(record);
    expect(resolve).toHaveBeenCalledTimes(2);
  });
});
