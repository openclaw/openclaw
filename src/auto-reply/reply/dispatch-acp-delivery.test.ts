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

  it("does not treat non-telegram direct block text as visible", async () => {
    const coordinator = createCoordinator();

    await coordinator.deliver("block", { text: "hello" }, { skipTts: true });
    await coordinator.settleVisibleText();

    expect(coordinator.hasDeliveredFinalReply()).toBe(false);
    expect(coordinator.hasDeliveredVisibleText()).toBe(false);
    expect(coordinator.hasFailedVisibleTextDelivery()).toBe(false);
    expect(coordinator.getRoutedCounts().block).toBe(0);
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

  it("keeps parent-owned background ACP child delivery silent while preserving accumulated output", async () => {
    const dispatcher = createDispatcher();
    const coordinator = createAcpDispatchDeliveryCoordinator({
      cfg: createAcpTestConfig(),
      ctx: buildTestCtx({
        Provider: "telegram",
        Surface: "telegram",
        SessionKey: "agent:codex-acp:session-1",
      }),
      dispatcher,
      inboundAudio: false,
      suppressUserDelivery: true,
      shouldRouteToOriginating: true,
      originatingChannel: "telegram",
      originatingTo: "telegram:123",
    });

    const blockDelivered = await coordinator.deliver("block", { text: "working on it" });
    const finalDelivered = await coordinator.deliver("final", { text: "done" });
    await coordinator.settleVisibleText();

    expect(blockDelivered).toBe(false);
    expect(finalDelivered).toBe(false);
    expect(dispatcher.sendBlockReply).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(coordinator.getAccumulatedBlockText()).toBe("working on it");
    expect(coordinator.hasDeliveredVisibleText()).toBe(false);
  });
});

describe("tool-only replyMode filtering", () => {
  function createToolOnlyCoordinator(replyMode?: string) {
    const dispatcher = createDispatcher();
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
      replyMode,
    });
    return { coordinator, dispatcher };
  }

  it("suppresses block text when replyMode is tool-only", async () => {
    const { coordinator, dispatcher } = createToolOnlyCoordinator("tool-only");

    const delivered = await coordinator.deliver(
      "block",
      { text: "streaming chunk" },
      { skipTts: true },
    );

    expect(delivered).toBe(false);
    expect(dispatcher.sendBlockReply).not.toHaveBeenCalled();
  });

  it("suppresses tool results when replyMode is tool-only", async () => {
    const { coordinator, dispatcher } = createToolOnlyCoordinator("tool-only");

    const delivered = await coordinator.deliver("tool", { text: "tool output" }, { skipTts: true });

    expect(delivered).toBe(false);
    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
  });

  it("suppresses tool even with shouldSendToolSummaries context (orthogonal concerns)", async () => {
    const dispatcher = createDispatcher();
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
      replyMode: "tool-only",
    });

    const delivered = await coordinator.deliver(
      "tool",
      { text: "🔧 tool_call · read_file · completed" },
      { skipTts: true },
    );

    expect(delivered).toBe(false);
    expect(dispatcher.sendToolResult).not.toHaveBeenCalled();
  });

  it("delivers tool results when replyMode is undefined (auto behavior preserved)", async () => {
    const { coordinator, dispatcher } = createToolOnlyCoordinator(undefined);

    const delivered = await coordinator.deliver("tool", { text: "tool output" }, { skipTts: true });

    expect(delivered).toBe(true);
    expect(dispatcher.sendToolResult).toHaveBeenCalledWith({ text: "tool output" });
  });

  it("suppresses text-only final when replyMode is tool-only", async () => {
    const { coordinator, dispatcher } = createToolOnlyCoordinator("tool-only");

    const delivered = await coordinator.deliver("final", { text: "done" }, { skipTts: true });

    expect(delivered).toBe(false);
    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
  });

  it("delivers final with mediaUrl when replyMode is tool-only", async () => {
    const { coordinator, dispatcher } = createToolOnlyCoordinator("tool-only");

    const delivered = await coordinator.deliver(
      "final",
      { text: "image result", mediaUrl: "https://example.com/img.png" },
      { skipTts: true },
    );

    expect(delivered).toBe(true);
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({
      text: "image result",
      mediaUrl: "https://example.com/img.png",
    });
  });

  it("delivers final with isError when replyMode is tool-only", async () => {
    const { coordinator, dispatcher } = createToolOnlyCoordinator("tool-only");

    const delivered = await coordinator.deliver(
      "final",
      { text: "something failed", isError: true },
      { skipTts: true },
    );

    expect(delivered).toBe(true);
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({
      text: "something failed",
      isError: true,
    });
  });

  it("delivers final with interactive blocks when replyMode is tool-only", async () => {
    const { coordinator, dispatcher } = createToolOnlyCoordinator("tool-only");

    const payload = {
      interactive: {
        blocks: [{ type: "buttons" as const, buttons: [{ label: "OK", value: "ok" }] }],
      },
    };
    const delivered = await coordinator.deliver("final", payload, { skipTts: true });

    expect(delivered).toBe(true);
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith(payload);
  });

  it("delivers final with channelData when replyMode is tool-only", async () => {
    const { coordinator, dispatcher } = createToolOnlyCoordinator("tool-only");

    const payload = {
      channelData: { telegram: { reply_markup: { inline_keyboard: [] } } },
    };
    const delivered = await coordinator.deliver("final", payload, { skipTts: true });

    expect(delivered).toBe(true);
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith(payload);
  });

  it("delivers block text when replyMode is undefined (auto behavior preserved)", async () => {
    const { coordinator, dispatcher } = createToolOnlyCoordinator(undefined);

    const delivered = await coordinator.deliver(
      "block",
      { text: "streaming chunk" },
      { skipTts: true },
    );

    expect(delivered).toBe(true);
    expect(dispatcher.sendBlockReply).toHaveBeenCalledWith({ text: "streaming chunk" });
  });
});
