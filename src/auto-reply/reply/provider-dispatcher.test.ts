import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { FinalizedMsgContext } from "../templating.js";

const mocks = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  dispatchInboundMessageWithBufferedDispatcher: vi.fn(async () => ({
    queuedFinal: true,
    counts: { tool: 0, block: 0, final: 1 },
  })),
  dispatchInboundMessageWithDispatcher: vi.fn(async () => ({
    queuedFinal: true,
    counts: { tool: 0, block: 0, final: 1 },
  })),
}));

vi.mock("node:child_process", () => ({
  execFileSync: mocks.execFileSync,
}));

vi.mock("../dispatch.js", () => ({
  dispatchInboundMessageWithBufferedDispatcher: mocks.dispatchInboundMessageWithBufferedDispatcher,
  dispatchInboundMessageWithDispatcher: mocks.dispatchInboundMessageWithDispatcher,
}));

const { dispatchReplyWithBufferedBlockDispatcher, dispatchReplyWithDispatcher } =
  await import("./provider-dispatcher.js");

function ctx(channel: "telegram" | "imessage" | "webchat"): FinalizedMsgContext {
  return {
    Body: "loop me",
    BodyForAgent: "loop me",
    RawBody: "loop me",
    CommandBody: "loop me",
    From: `${channel}:sender`,
    To: `${channel}:target`,
    SessionKey: `agent:main:${channel}:target`,
    Provider: channel,
    Surface: channel,
    MessageSid: `${channel}-message-1`,
  } as FinalizedMsgContext;
}

const baseParams = {
  cfg: {} as OpenClawConfig,
  dispatcherOptions: {
    deliver: vi.fn(),
  },
};

describe("provider dispatcher fleet-loop-guard", () => {
  beforeEach(() => {
    mocks.execFileSync.mockReset();
    mocks.dispatchInboundMessageWithBufferedDispatcher.mockClear();
    mocks.dispatchInboundMessageWithDispatcher.mockClear();
    mocks.execFileSync.mockReturnValue(JSON.stringify({ suppress: false }));
  });

  it("allows first telegram dispatch through fleet-loop-guard", async () => {
    const result = await dispatchReplyWithBufferedBlockDispatcher({
      ...baseParams,
      ctx: ctx("telegram"),
    });

    expect(mocks.execFileSync).toHaveBeenCalledWith(
      expect.stringContaining("fleet-loop-guard"),
      ["--check-json"],
      expect.objectContaining({
        input: expect.stringContaining('"bridge":"telegram"'),
      }),
    );
    expect(mocks.dispatchInboundMessageWithBufferedDispatcher).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } });
  });

  it("suppresses repeated telegram dispatch before agent fanout", async () => {
    mocks.execFileSync.mockImplementation(() => {
      const error = new Error("suppressed") as Error & { status: number };
      error.status = 75;
      throw error;
    });

    const result = await dispatchReplyWithBufferedBlockDispatcher({
      ...baseParams,
      ctx: ctx("telegram"),
    });

    expect(mocks.dispatchInboundMessageWithBufferedDispatcher).not.toHaveBeenCalled();
    expect(result).toEqual({ queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } });
  });

  it("suppresses repeated imessage dispatch before agent fanout", async () => {
    mocks.execFileSync.mockReturnValue(JSON.stringify({ suppress: true }));

    const result = await dispatchReplyWithDispatcher({
      ...baseParams,
      ctx: ctx("imessage"),
    });

    expect(mocks.execFileSync).toHaveBeenCalledWith(
      expect.stringContaining("fleet-loop-guard"),
      ["--check-json"],
      expect.objectContaining({
        input: expect.stringContaining('"bridge":"imessage"'),
      }),
    );
    expect(mocks.dispatchInboundMessageWithDispatcher).not.toHaveBeenCalled();
    expect(result).toEqual({ queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } });
  });

  it("does not run fleet-loop-guard for unrelated channels", async () => {
    await dispatchReplyWithBufferedBlockDispatcher({
      ...baseParams,
      ctx: ctx("webchat"),
    });

    expect(mocks.execFileSync).not.toHaveBeenCalled();
    expect(mocks.dispatchInboundMessageWithBufferedDispatcher).toHaveBeenCalledTimes(1);
  });
});
