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

const record: SessionBindingRecord = {
  bindingId: "external-binding",
  targetSessionKey: "agent:owner:main",
  targetKind: "session",
  conversation: { channel: "external", accountId: "default", conversationId: "room" },
  status: "active",
  boundAt: 1,
};

describe("awaited binding read ownership", () => {
  it.each([false, true])(
    "keeps admission inspection free of resolver mutations (async inspector=%s)",
    async (asyncInspector) => {
      const resolve = vi.fn(() => record);
      registerSessionBindingAdapter({
        channel: "external",
        accountId: "default",
        listBySession: () => [],
        inspectByConversation: () => record,
        ...(asyncInspector ? { inspectByConversationAsync: async () => record } : {}),
        resolveByConversation: resolve,
        resolveByConversationAsync: async () => resolve(),
      });
      expect(await readSessionBindingSelectionCurrent([record.conversation])).toEqual([record]);
      expect(resolve).not.toHaveBeenCalled();
    },
  );

  it.each([
    { inspect: true, change: "keep" },
    { inspect: true, change: "remove" },
    { inspect: true, change: "replace" },
    { inspect: false, change: "keep" },
    { inspect: false, change: "remove" },
    { inspect: false, change: "replace" },
  ])(
    "revalidates the adapter after read (inspect=$inspect, $change)",
    async ({ inspect, change }) => {
      const gate = createDeferredCore<SessionBindingRecord | null>();
      const entered = createDeferredCore();
      const read = vi.fn(() => {
        entered.resolve();
        return gate.promise;
      });
      const legacyRead = vi.fn(() => record);
      const adapter: SessionBindingAdapter = {
        channel: "external",
        accountId: "default",
        listBySession: () => [],
        resolveByConversation: legacyRead,
        inspectByConversation: legacyRead,
        inspectByConversationAsync: read,
        resolveByConversationAsync: read,
      };
      registerSessionBindingAdapter(adapter);
      const ref = { ...record.conversation };
      const service = getSessionBindingService();
      const pending = inspect
        ? service.inspectByConversationAsync(ref)
        : service.resolveByConversationAsync(ref);
      const rejection =
        !inspect && change !== "keep"
          ? expect(pending).rejects.toMatchObject({ code: "BINDING_ADAPTER_UNAVAILABLE" })
          : undefined;
      await entered.promise;
      ref.accountId = "unrelated";
      if (change === "remove") {
        unregisterSessionBindingAdapter({
          channel: adapter.channel,
          accountId: adapter.accountId,
          adapter,
        });
      } else if (change === "replace") {
        registerSessionBindingAdapter({ ...adapter, resolveByConversation: () => null });
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
    },
  );

  it("never calls a V2 adapter's synchronous compatibility readers", async () => {
    const legacy = () => {
      throw new Error("legacy reader must not run");
    };
    let active = true;
    let sourceCurrent = true;
    registerSessionBindingAdapterV2({
      version: 2,
      touchAsync: async () => {},
      inspectByConversationsAsync: async (refs) => ({
        bindings: refs.map(() => record),
        assertCurrent: () => {
          if (!sourceCurrent) {
            throw new Error("binding source changed");
          }
        },
      }),
      channel: "external",
      accountId: "default",
      assertCurrent: () => {
        if (!active) {
          throw new Error("closed adapter");
        }
      },
      listBySession: legacy,
      resolveByConversation: legacy,
      inspectByConversation: legacy,
      listBySessionAsync: async () => [record],
      resolveByConversationAsync: async () => record,
      inspectByConversationAsync: async () => record,
    });
    const service = getSessionBindingService();
    expect(await service.resolveByConversationAsync(record.conversation)).toEqual(record);
    expect(await readSessionBindingSelectionCurrent([record.conversation])).toEqual([record]);
    sourceCurrent = false;
    await expect(readSessionBindingSelectionCurrent([record.conversation])).rejects.toThrow(
      "binding source changed",
    );
    active = false;
    await expect(service.resolveByConversationAsync(record.conversation)).rejects.toThrow(
      "closed adapter",
    );
  });

  it("warns once for actual legacy binding use while V2 construction and reads stay silent", async () => {
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    const run = <T>(body: () => T) =>
      withPluginRuntimePluginScope({ pluginId: "binding-sdk-compat-fixture" }, body);
    try {
      await run(async () => {
        const adapter = createAccountScopedBindingAdapterV2({
          channel: "external",
          accountId: "default",
          capabilities: {},
          assertCurrent: () => {},
          bind: async () => record,
          project: (entry: SessionBindingRecord) => entry,
          listBySessionKey: () => [record],
          getByConversation: () => record,
          touchConversation: () => {},
          unbindConversation: () => null,
          unbindBySessionKey: () => [],
          listBySessionKeyAsync: async () => [record],
          getByConversationAsync: async () => record,
          inspectByConversationAsync: async () => record,
          inspectByConversations: (refs) => ({
            records: refs.map(() => record),
            assertCurrent: () => {},
          }),
          touchConversationAsync: async () => {},
        });
        registerSessionBindingAdapterV2(adapter);
        expect(
          await getSessionBindingService().resolveByConversationAsync(record.conversation),
        ).toEqual(record);
        expect(warning).not.toHaveBeenCalled();
        expect(getSessionBindingService().resolveByConversation(record.conversation)).toEqual(
          record,
        );
        getSessionBindingService().touch("", undefined, record.conversation);
      });
      run(() => getSessionBindingService().resolveByConversation(record.conversation));
      expect(warning).toHaveBeenCalledTimes(1);
      expect(warning.mock.calls[0]?.[0]).toContain(
        "Plugin binding-sdk-compat-fixture: SessionBindingService.resolveByConversation",
      );
      expect(warning.mock.calls[0]?.[0]).toContain(
        "SessionBindingService.resolveByConversationAsync",
      );
      expect(warning.mock.calls[0]?.[0]).toContain("removed in the next Plugin SDK major");
    } finally {
      warning.mockRestore();
    }
  });

  it("retains the explicit reader fallback for a legacy external adapter", async () => {
    const resolve = vi.fn(() => record);
    registerSessionBindingAdapter({
      channel: "external",
      accountId: "default",
      listBySession: () => [],
      resolveByConversation: resolve,
    });
    const service = getSessionBindingService();
    const inspection = await service.inspectByConversationAsync(record.conversation);
    expect(readSessionBindingInspectionConversation(inspection)).toEqual(record.conversation);
    expect(Object.isFrozen(readSessionBindingInspectionConversation(inspection))).toBe(true);
    expect(Object.fromEntries(Object.entries(inspection))).toEqual({
      status: "available",
      binding: record,
    });
    expect(await service.resolveByConversationAsync(record.conversation)).toEqual(record);
    expect(resolve).toHaveBeenCalledTimes(2);
  });
});
