import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  getSessionBindingService,
  registerSessionBindingAdapter,
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
        expect(await pending).toEqual(
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

  it("retains the explicit reader fallback for a legacy external adapter", async () => {
    const resolve = vi.fn(() => record);
    registerSessionBindingAdapter({
      channel: "external",
      accountId: "default",
      listBySession: () => [],
      resolveByConversation: resolve,
    });
    const service = getSessionBindingService();
    expect(await service.inspectByConversationAsync(record.conversation)).toEqual({
      status: "available",
      binding: record,
    });
    expect(await service.resolveByConversationAsync(record.conversation)).toEqual(record);
    expect(resolve).toHaveBeenCalledTimes(2);
  });
});
