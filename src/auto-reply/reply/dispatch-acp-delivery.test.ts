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

const routeMocks = vi.hoisted(() => ({
  routeReply: vi.fn(async (_params: unknown) => ({ ok: true, messageId: "mock" })),
}));

const messageActionMocks = vi.hoisted(() => ({
  runMessageAction: vi.fn(async (_params: unknown) => ({ ok: true as const })),
}));

vi.mock("../../tts/tts.js", () => ({
  maybeApplyTtsToPayload: (params: unknown) => ttsMocks.maybeApplyTtsToPayload(params),
}));

vi.mock("./route-reply.js", () => ({
  routeReply: (params: unknown) => routeMocks.routeReply(params),
}));

vi.mock("../../infra/outbound/message-action-runner.js", () => ({
  runMessageAction: (params: unknown) => messageActionMocks.runMessageAction(params),
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

function createRestartCoordinator() {
  return createAcpDispatchDeliveryCoordinator({
    cfg: createAcpTestConfig(),
    target: {
      targetKey: "run-1:primary",
      targetId: "primary",
      sessionKey: "agent:codex-acp:session-1",
      runId: "run-1",
      channel: "telegram",
      to: "telegram:thread-1",
      routeMode: "originating",
      toolReplayPolicy: "append_only_after_restart",
      createdAt: 1,
      updatedAt: 1,
    },
    inboundAudio: false,
    shouldRouteToOriginating: false,
    restartMode: true,
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

  it("downgrades restarted tool updates to append-only delivery for interleaved tool calls", async () => {
    const coordinator = createRestartCoordinator();

    await coordinator.deliver(
      "tool",
      { text: "tool-a pending" },
      { toolCallId: "tool-a", allowEdit: true },
    );
    await coordinator.deliver(
      "tool",
      { text: "tool-b pending" },
      { toolCallId: "tool-b", allowEdit: true },
    );
    await coordinator.deliver(
      "tool",
      { text: "tool-a completed" },
      { toolCallId: "tool-a", allowEdit: true },
    );
    await coordinator.deliver(
      "tool",
      { text: "tool-b completed" },
      { toolCallId: "tool-b", allowEdit: true },
    );

    expect(messageActionMocks.runMessageAction).not.toHaveBeenCalled();
    expect(routeMocks.routeReply).toHaveBeenCalledTimes(4);
    expect(routeMocks.routeReply.mock.calls.map(([params]) => params)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: "telegram",
          to: "telegram:thread-1",
          payload: expect.objectContaining({ text: "tool-a pending" }),
        }),
        expect.objectContaining({
          channel: "telegram",
          to: "telegram:thread-1",
          payload: expect.objectContaining({ text: "tool-b completed" }),
        }),
      ]),
    );
  });
});
