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
const makeAdapter = (overrides: Partial<SessionBindingAdapter>): SessionBindingAdapter => ({
  channel: "external",
  accountId: "default",
  listBySession: () => [],
  resolveByConversation: () => null,
  ...overrides,
});

describe("awaited binding read ownership", () => {
  it.each([false, true])(
    "keeps admission inspection free of resolver mutations (async inspector=%s)",
    async (asyncInspector) => {
      const resolve = vi.fn(() => record);
      registerSessionBindingAdapter(
        makeAdapter({
          inspectByConversation: () => record,
          ...(asyncInspector ? { inspectByConversationAsync: async () => record } : {}),
          resolveByConversation: resolve,
          resolveByConversationAsync: async () => resolve(),
        }),
      );
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
    const owner = makeAdapter({
      resolveByConversation: legacyRead,
      inspectByConversation: legacyRead,
      inspectByConversationAsync: read,
      resolveByConversationAsync: read,
    });
    registerSessionBindingAdapter(owner);
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
    registerSessionBindingAdapter(makeAdapter({ resolveByConversation: resolve }));
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
