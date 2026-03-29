import { describe, expect, it, vi } from "vitest";
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

vi.mock("../../tts/tts.js", () => ({
  maybeApplyTtsToPayload: (params: unknown) => ttsMocks.maybeApplyTtsToPayload(params),
}));

function createDispatcher(): ReplyDispatcher {
  return {
    sendToolResult: vi.fn(() => true),
    sendBlockReply: vi.fn(() => true),
    sendFinalReply: vi.fn(() => true),
    waitForIdle: vi.fn(async () => {}),
    getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
    getFailedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
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
  it("bypasses TTS when skipTts is requested", async () => {
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
    });

    await coordinator.deliver("final", { text: "hello" }, { skipTts: true });
    await coordinator.settleVisibleText();

    expect(ttsMocks.maybeApplyTtsToPayload).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({ text: "hello" });
  });

  it("tracks successful final delivery separately from routed counters", async () => {
    const coordinator = createCoordinator();

    expect(coordinator.hasDeliveredFinalReply()).toBe(false);
    expect(coordinator.hasDeliveredVisibleText()).toBe(false);
    expect(coordinator.hasFailedVisibleTextDelivery()).toBe(false);

    await coordinator.deliver("final", { text: "hello" }, { skipTts: true });
    await coordinator.settleVisibleText();

    expect(coordinator.hasDeliveredFinalReply()).toBe(true);
    expect(coordinator.hasDeliveredVisibleText()).toBe(true);
    expect(coordinator.hasFailedVisibleTextDelivery()).toBe(false);
    expect(coordinator.getRoutedCounts().final).toBe(0);
  });

  it("tracks visible direct block text for dispatcher-backed delivery", async () => {
    const coordinator = createAcpDispatchDeliveryCoordinator({
      cfg: createAcpTestConfig(),
      ctx: buildTestCtx({
        Provider: "telegram",
        Surface: "telegram",
        SessionKey: "agent:codex-acp:session-1",
      }),
      dispatcher: createDispatcher(),
      inboundAudio: false,
      shouldRouteToOriginating: false,
    });

    await coordinator.deliver("block", { text: "hello" }, { skipTts: true });
    await coordinator.settleVisibleText();

    expect(coordinator.hasDeliveredFinalReply()).toBe(false);
    expect(coordinator.hasDeliveredVisibleText()).toBe(true);
    expect(coordinator.hasFailedVisibleTextDelivery()).toBe(false);
    expect(coordinator.getRoutedCounts().block).toBe(0);
  });

  it("prefers provider over surface when detecting direct telegram visibility", async () => {
    const coordinator = createAcpDispatchDeliveryCoordinator({
      cfg: createAcpTestConfig(),
      ctx: buildTestCtx({
        Provider: "telegram",
        Surface: "webchat",
        SessionKey: "agent:codex-acp:session-1",
      }),
      dispatcher: createDispatcher(),
      inboundAudio: false,
      shouldRouteToOriginating: false,
    });

    await coordinator.deliver("block", { text: "hello" }, { skipTts: true });
    await coordinator.settleVisibleText();

    expect(coordinator.hasDeliveredVisibleText()).toBe(true);
    expect(coordinator.hasFailedVisibleTextDelivery()).toBe(false);
  });

  it("treats non-telegram direct block text as visible", async () => {
    const coordinator = createCoordinator();

    await coordinator.deliver("block", { text: "hello" }, { skipTts: true });
    await coordinator.settleVisibleText();

    expect(coordinator.hasDeliveredFinalReply()).toBe(false);
    expect(coordinator.hasDeliveredVisibleText()).toBe(true);
    expect(coordinator.hasFailedVisibleTextDelivery()).toBe(false);
  });

  it("tracks failed visible telegram block delivery separately", async () => {
    const dispatcher: ReplyDispatcher = {
      sendToolResult: vi.fn(() => true),
      sendBlockReply: vi.fn(() => false),
      sendFinalReply: vi.fn(() => true),
      waitForIdle: vi.fn(async () => {}),
      getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
      getFailedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
      markComplete: vi.fn(),
    };
    const coordinator = createAcpDispatchDeliveryCoordinator({
      cfg: createAcpTestConfig(),
      ctx: buildTestCtx({
        Provider: "telegram",
        Surface: "telegram",
        SessionKey: "agent:codex-acp:session-1",
      }),
      dispatcher,
      inboundAudio: false,
      shouldRouteToOriginating: false,
    });

    await coordinator.deliver("block", { text: "hello" }, { skipTts: true });

    expect(coordinator.hasDeliveredVisibleText()).toBe(false);
    expect(coordinator.hasFailedVisibleTextDelivery()).toBe(true);
  });

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
