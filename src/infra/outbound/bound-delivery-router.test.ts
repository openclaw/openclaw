import { beforeEach, describe, expect, it } from "vitest";
import { createBoundDeliveryRouter } from "./bound-delivery-router.js";
import {
  __testing,
  registerSessionBindingAdapter,
  type SessionBindingRecord,
} from "./session-binding-service.js";

const TARGET_SESSION_KEY = "agent:main:subagent:child";

function createDiscordBinding(
  targetSessionKey: string,
  conversationId: string,
  boundAt: number,
  parentConversationId?: string,
): SessionBindingRecord {
  return {
    bindingId: `runtime:${conversationId}`,
    targetSessionKey,
    targetKind: "subagent",
    conversation: {
      channel: "discord",
      accountId: "runtime",
      conversationId,
      parentConversationId,
    },
    status: "active",
    boundAt,
  };
}

function registerDiscordSessionBindings(
  targetSessionKey: string,
  bindings: SessionBindingRecord[],
): void {
  registerSessionBindingAdapter({
    channel: "discord",
    accountId: "runtime",
    listBySession: (requestedSessionKey) =>
      requestedSessionKey === targetSessionKey ? bindings : [],
    resolveByConversation: () => null,
  });
}

describe("bound delivery router", () => {
  beforeEach(() => {
    __testing.resetSessionBindingAdaptersForTests();
  });

  it("resolves to a bound destination when a single active binding exists", () => {
    registerDiscordSessionBindings(TARGET_SESSION_KEY, [
      createDiscordBinding(TARGET_SESSION_KEY, "thread-1", 1, "parent-1"),
    ]);

    const route = createBoundDeliveryRouter().resolveDestination({
      eventKind: "task_completion",
      targetSessionKey: TARGET_SESSION_KEY,
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
    registerDiscordSessionBindings(TARGET_SESSION_KEY, [
      createDiscordBinding(TARGET_SESSION_KEY, "thread-1", 1),
      createDiscordBinding(TARGET_SESSION_KEY, "thread-2", 2),
    ]);

    const route = createBoundDeliveryRouter().resolveDestination({
      eventKind: "task_completion",
      targetSessionKey: TARGET_SESSION_KEY,
      failClosed: true,
    });

    expect(route).toEqual({
      binding: null,
      mode: "fallback",
      reason: "ambiguous-without-requester",
    });
  });

  it("selects requester-matching conversation when multiple bindings exist", () => {
    registerDiscordSessionBindings(TARGET_SESSION_KEY, [
      createDiscordBinding(TARGET_SESSION_KEY, "thread-1", 1),
      createDiscordBinding(TARGET_SESSION_KEY, "thread-2", 2),
    ]);

    const route = createBoundDeliveryRouter().resolveDestination({
      eventKind: "task_completion",
      targetSessionKey: TARGET_SESSION_KEY,
      requester: {
        channel: "discord",
        accountId: "runtime",
        conversationId: "thread-2",
      },
      failClosed: true,
    });

    expect(route.mode).toBe("bound");
    expect(route.reason).toBe("requester-match");
    expect(route.binding?.conversation.conversationId).toBe("thread-2");
  });

  it("falls back for invalid requester conversation values", () => {
    registerDiscordSessionBindings(TARGET_SESSION_KEY, [
      createDiscordBinding(TARGET_SESSION_KEY, "thread-1", 1),
    ]);

    const route = createBoundDeliveryRouter().resolveDestination({
      eventKind: "task_completion",
      targetSessionKey: TARGET_SESSION_KEY,
      requester: {
        channel: "discord",
        accountId: "runtime",
        conversationId: " ",
      },
      failClosed: true,
    });

    expect(route).toEqual({
      binding: null,
      mode: "fallback",
      reason: "invalid-requester",
    });
  });
});
