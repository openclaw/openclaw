import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BoundDeliveryRouter } from "../../infra/outbound/bound-delivery-router.js";
import type { SessionBindingRecord } from "../../infra/outbound/session-binding-service.js";
import { createAcpDispatchDeliveryCoordinator } from "./dispatch-acp-delivery.js";
import type { ReplyDispatcher } from "./reply-dispatcher.js";
import { buildTestCtx } from "./test-ctx.js";
import { createAcpTestConfig } from "./test-fixtures/acp-runtime.js";

const ttsMocks = vi.hoisted(() => ({
  maybeApplyTtsToPayload: vi.fn(async (paramsUnknown: unknown) => {
    const params = paramsUnknown as { payload: unknown };
    return params.payload;
  }),
}));

const routeMocks = vi.hoisted(() => ({
  routeReply: vi.fn(async (_params: unknown) => ({ ok: true, messageId: "mock" })),
}));

vi.mock("../../tts/tts.js", () => ({
  maybeApplyTtsToPayload: (params: unknown) => ttsMocks.maybeApplyTtsToPayload(params),
}));

vi.mock("./route-reply.js", () => ({
  routeReply: (params: unknown) => routeMocks.routeReply(params),
}));

function createDispatcher(): ReplyDispatcher {
  return {
    sendToolResult: vi.fn(() => true),
    sendBlockReply: vi.fn(() => true),
    sendFinalReply: vi.fn(() => true),
    waitForIdle: vi.fn(async () => {}),
    getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
    markComplete: vi.fn(),
  };
}

function createCoordinator(onReplyStart?: (...args: unknown[]) => Promise<void>) {
  return createAcpDispatchDeliveryCoordinator({
    cfg: createAcpTestConfig(),
    ctx: buildTestCtx({
      Provider: "discord",
      Surface: "discord",
      SessionKey: "agent:codex-acp:session-1",
    }),
    dispatcher: createDispatcher(),
    inboundAudio: false,
    shouldRouteToOriginating: false,
    ...(onReplyStart ? { onReplyStart } : {}),
  });
}

describe("createAcpDispatchDeliveryCoordinator", () => {
  it("starts reply lifecycle only once when called directly and through deliver", async () => {
    const onReplyStart = vi.fn(async () => {});
    const coordinator = createCoordinator(onReplyStart);

    await coordinator.startReplyLifecycle();
    await coordinator.deliver("final", { text: "hello" });
    await coordinator.startReplyLifecycle();
    await coordinator.deliver("block", { text: "world" });

    expect(onReplyStart).toHaveBeenCalledTimes(1);
  });

  it("starts reply lifecycle once when deliver triggers first", async () => {
    const onReplyStart = vi.fn(async () => {});
    const coordinator = createCoordinator(onReplyStart);

    await coordinator.deliver("final", { text: "hello" });
    await coordinator.startReplyLifecycle();

    expect(onReplyStart).toHaveBeenCalledTimes(1);
  });

  it("does not start reply lifecycle for empty payload delivery", async () => {
    const onReplyStart = vi.fn(async () => {});
    const coordinator = createCoordinator(onReplyStart);

    await coordinator.deliver("final", {});

    expect(onReplyStart).not.toHaveBeenCalled();
  });
});

function createMockBinding(overrides?: Partial<SessionBindingRecord>): SessionBindingRecord {
  return {
    bindingId: "bind-1",
    targetSessionKey: "agent:codex-acp:session-1",
    targetKind: "subagent",
    conversation: {
      channel: "discord",
      accountId: "acct-discord-1",
      conversationId: "thread-12345",
    },
    status: "active",
    boundAt: Date.now(),
    ...overrides,
  };
}

function createMockBoundDeliveryRouter(
  result: ReturnType<BoundDeliveryRouter["resolveDestination"]>,
): BoundDeliveryRouter {
  return {
    resolveDestination: vi.fn(() => result),
  };
}

describe("createAcpDispatchDeliveryCoordinator — binding resolution", () => {
  beforeEach(() => {
    routeMocks.routeReply.mockReset();
    routeMocks.routeReply.mockResolvedValue({ ok: true, messageId: "mock" });
  });

  it("routes to Discord thread when binding is found", async () => {
    const binding = createMockBinding();
    const router = createMockBoundDeliveryRouter({
      binding,
      mode: "bound",
      reason: "requester-match",
    });

    const coordinator = createAcpDispatchDeliveryCoordinator({
      cfg: createAcpTestConfig(),
      ctx: buildTestCtx({
        Provider: "discord",
        Surface: "discord",
        SessionKey: "agent:codex-acp:session-1",
      }),
      dispatcher: createDispatcher(),
      inboundAudio: false,
      shouldRouteToOriginating: false,
      boundDeliveryRouter: router,
    });

    await coordinator.deliver("block", { text: "hello from ACP" });

    expect(routeMocks.routeReply).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "discord",
        to: "thread-12345",
      }),
    );
    expect(coordinator.getRoutedCounts().block).toBe(1);
  });

  it("falls through to dispatcher when no binding exists", async () => {
    const router = createMockBoundDeliveryRouter({
      binding: null,
      mode: "fallback",
      reason: "no-active-binding",
    });

    const dispatcher = createDispatcher();
    const coordinator = createAcpDispatchDeliveryCoordinator({
      cfg: createAcpTestConfig(),
      ctx: buildTestCtx({
        Provider: "discord",
        Surface: "discord",
        SessionKey: "agent:codex-acp:session-1",
      }),
      dispatcher,
      inboundAudio: false,
      shouldRouteToOriginating: false,
      boundDeliveryRouter: router,
    });

    await coordinator.deliver("block", { text: "hello" });

    expect(routeMocks.routeReply).not.toHaveBeenCalled();
    expect(dispatcher.sendBlockReply).toHaveBeenCalled();
  });

  it("throws on stale/ambiguous binding (fail closed)", async () => {
    const router = createMockBoundDeliveryRouter({
      binding: null,
      mode: "fallback",
      reason: "ambiguous-without-requester",
    });

    const dispatcher = createDispatcher();
    const coordinator = createAcpDispatchDeliveryCoordinator({
      cfg: createAcpTestConfig(),
      ctx: buildTestCtx({
        Provider: "discord",
        Surface: "discord",
        SessionKey: "agent:codex-acp:session-1",
      }),
      dispatcher,
      inboundAudio: false,
      shouldRouteToOriginating: false,
      boundDeliveryRouter: router,
    });

    await expect(coordinator.deliver("block", { text: "hello" })).rejects.toThrow(
      /binding resolution failed closed/,
    );
    expect(routeMocks.routeReply).not.toHaveBeenCalled();
    expect(dispatcher.sendBlockReply).not.toHaveBeenCalled();
  });

  it("skips binding resolution when originating context is already set", async () => {
    const router = createMockBoundDeliveryRouter({
      binding: createMockBinding(),
      mode: "bound",
      reason: "requester-match",
    });

    const coordinator = createAcpDispatchDeliveryCoordinator({
      cfg: createAcpTestConfig(),
      ctx: buildTestCtx({
        Provider: "discord",
        Surface: "discord",
        SessionKey: "agent:codex-acp:session-1",
      }),
      dispatcher: createDispatcher(),
      inboundAudio: false,
      shouldRouteToOriginating: true,
      originatingChannel: "telegram",
      originatingTo: "telegram:chat-99",
      boundDeliveryRouter: router,
    });

    await coordinator.deliver("block", { text: "hello" });

    // Router should not be called since originating was already set
    expect(router.resolveDestination).not.toHaveBeenCalled();
    expect(routeMocks.routeReply).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        to: "telegram:chat-99",
      }),
    );
  });

  it("passes requester to disambiguate multiple bindings", async () => {
    const router = createMockBoundDeliveryRouter({
      binding: createMockBinding(),
      mode: "bound",
      reason: "requester-match",
    });

    const requester = {
      channel: "discord",
      accountId: "acct-discord-1",
      conversationId: "thread-12345",
    };

    createAcpDispatchDeliveryCoordinator({
      cfg: createAcpTestConfig(),
      ctx: buildTestCtx({
        Provider: "discord",
        Surface: "discord",
        SessionKey: "agent:codex-acp:session-1",
      }),
      dispatcher: createDispatcher(),
      inboundAudio: false,
      shouldRouteToOriginating: false,
      boundDeliveryRouter: router,
      requester,
    });

    expect(router.resolveDestination).toHaveBeenCalledWith(
      expect.objectContaining({
        requester,
        targetSessionKey: "agent:codex-acp:session-1",
        failClosed: true,
      }),
    );
  });
});
