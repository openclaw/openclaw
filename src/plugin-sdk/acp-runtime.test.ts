import { beforeEach, describe, expect, it, vi } from "vitest";

const { bypassMock, dispatchMock } = vi.hoisted(() => ({
  bypassMock: vi.fn(),
  dispatchMock: vi.fn(),
}));

vi.mock("../auto-reply/reply/dispatch-acp.runtime.js", () => ({
  shouldBypassAcpDispatchForCommand: bypassMock,
  tryDispatchAcpReply: dispatchMock,
}));

import { tryDispatchAcpReplyHook } from "./acp-runtime.js";

const event = {
  ctx: {
    SessionKey: "agent:test:session",
    BodyForAgent: "hello",
  },
  runId: "run-1",
  sessionKey: "agent:test:session",
  inboundAudio: false,
  sessionTtsAuto: "off" as const,
  ttsChannel: undefined,
  suppressUserDelivery: false,
  shouldRouteToOriginating: false,
  originatingChannel: undefined,
  originatingTo: undefined,
  shouldSendToolSummaries: true,
  sendPolicy: "allow" as const,
};

const ctx = {
  cfg: {},
  dispatcher: {
    sendToolResult: () => false,
    sendBlockReply: () => false,
    sendFinalReply: () => false,
    waitForIdle: async () => {},
    getQueuedCounts: () => ({ tool: 0, block: 0, final: 0 }),
    getFailedCounts: () => ({ tool: 0, block: 0, final: 0 }),
    markComplete: () => {},
  },
  abortSignal: undefined,
  onReplyStart: undefined,
  recordProcessed: vi.fn(),
  markIdle: vi.fn(),
};

describe("tryDispatchAcpReplyHook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips ACP dispatch when send policy denies delivery and no bypass applies", async () => {
    bypassMock.mockResolvedValue(false);

    const result = await tryDispatchAcpReplyHook({ ...event, sendPolicy: "deny" }, ctx);

    expect(result).toBeUndefined();
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("dispatches through ACP when command bypass applies", async () => {
    bypassMock.mockResolvedValue(true);
    dispatchMock.mockResolvedValue({
      queuedFinal: true,
      counts: { tool: 1, block: 2, final: 3 },
    });

    const result = await tryDispatchAcpReplyHook({ ...event, sendPolicy: "deny" }, ctx);

    expect(result).toEqual({
      handled: true,
      queuedFinal: true,
      counts: { tool: 1, block: 2, final: 3 },
    });
    expect(dispatchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: event.ctx,
        cfg: ctx.cfg,
        dispatcher: ctx.dispatcher,
        bypassForCommand: true,
      }),
    );
  });

  it("returns unhandled when ACP dispatcher declines the turn", async () => {
    bypassMock.mockResolvedValue(false);
    dispatchMock.mockResolvedValue(undefined);

    const result = await tryDispatchAcpReplyHook(event, ctx);

    expect(result).toBeUndefined();
    expect(dispatchMock).toHaveBeenCalledOnce();
  });
});
