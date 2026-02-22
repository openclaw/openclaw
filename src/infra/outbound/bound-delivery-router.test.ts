import { beforeEach, describe, expect, it } from "vitest";
import { createBoundDeliveryRouter } from "./bound-delivery-router.js";
import { __testing, registerSessionBindingAdapter } from "./session-binding-service.js";

describe("bound delivery router", () => {
  beforeEach(() => {
    __testing.resetSessionBindingAdaptersForTests();
  });

  it("resolves to a bound destination when a single active binding exists", () => {
    registerSessionBindingAdapter({
      channel: "discord",
      accountId: "runtime",
      listBySession: (targetSessionKey) =>
        targetSessionKey === "agent:main:subagent:child"
          ? [
              {
                bindingId: "runtime:thread-1",
                targetSessionKey,
                targetKind: "subagent",
                conversation: {
                  channel: "discord",
                  accountId: "runtime",
                  conversationId: "thread-1",
                  parentConversationId: "parent-1",
                },
                status: "active",
                boundAt: 1,
              },
            ]
          : [],
      resolveByConversation: () => null,
    });

    const route = createBoundDeliveryRouter().resolveDestination({
      eventKind: "task_completion",
      targetSessionKey: "agent:main:subagent:child",
      requester: {
        channel: "discord",
        accountId: "runtime",
        conversationId: "parent-1",
      },
      failClosed: false,
    });

    expect(route.mode).toBe("bound");
    expect(route.binding?.conversation.conversationId).toBe("thread-1");
  });

  it("falls back when no active binding exists", () => {
    const route = createBoundDeliveryRouter().resolveDestination({
      eventKind: "task_completion",
      targetSessionKey: "agent:main:subagent:missing",
      requester: {
        channel: "discord",
        accountId: "runtime",
        conversationId: "parent-1",
      },
      failClosed: false,
    });

    expect(route).toEqual({
      binding: null,
      mode: "fallback",
      reason: "no-active-binding",
    });
  });

  it("fails closed when multiple bindings exist without requester signal", () => {
    registerSessionBindingAdapter({
      channel: "discord",
      accountId: "runtime",
      listBySession: (targetSessionKey) =>
        targetSessionKey === "agent:main:subagent:child"
          ? [
              {
                bindingId: "runtime:thread-1",
                targetSessionKey,
                targetKind: "subagent",
                conversation: {
                  channel: "discord",
                  accountId: "runtime",
                  conversationId: "thread-1",
                },
                status: "active",
                boundAt: 1,
              },
              {
                bindingId: "runtime:thread-2",
                targetSessionKey,
                targetKind: "subagent",
                conversation: {
                  channel: "discord",
                  accountId: "runtime",
                  conversationId: "thread-2",
                },
                status: "active",
                boundAt: 2,
              },
            ]
          : [],
      resolveByConversation: () => null,
    });

    const route = createBoundDeliveryRouter().resolveDestination({
      eventKind: "task_completion",
      targetSessionKey: "agent:main:subagent:child",
      failClosed: true,
    });

    expect(route).toEqual({
      binding: null,
      mode: "fallback",
      reason: "ambiguous-without-requester",
    });
  });
});
