import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ClawdbotConfig } from "../../config/config.js";
import type { MsgContext } from "../templating.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import type { ReplyDispatcher } from "./reply-dispatcher.js";

const mocks = vi.hoisted(() => ({
  routeReply: vi.fn(async () => ({ ok: true, messageId: "mock" })),
  tryFastAbortFromMessage: vi.fn(async () => ({
    handled: false,
    aborted: false,
  })),
}));

vi.mock("./route-reply.js", () => ({
  isRoutableChannel: (channel: string | undefined) =>
    Boolean(
      channel &&
      ["telegram", "slack", "discord", "signal", "imessage", "whatsapp"].includes(channel),
    ),
  routeReply: mocks.routeReply,
}));

vi.mock("./abort.js", () => ({
  tryFastAbortFromMessage: mocks.tryFastAbortFromMessage,
  formatAbortReplyText: (stoppedSubagents?: number) => {
    if (typeof stoppedSubagents !== "number" || stoppedSubagents <= 0) {
      return "⚙️ Agent was aborted.";
    }
    const label = stoppedSubagents === 1 ? "sub-agent" : "sub-agents";
    return `⚙️ Agent was aborted. Stopped ${stoppedSubagents} ${label}.`;
  },
}));

const { dispatchReplyFromConfig } = await import("./dispatch-from-config.js");
const { resetInboundDedupe } = await import("./inbound-dedupe.js");

function createDispatcher(): ReplyDispatcher {
  return {
    sendToolResult: vi.fn(() => true),
    sendBlockReply: vi.fn(() => true),
    sendFinalReply: vi.fn(() => true),
    waitForIdle: vi.fn(async () => {}),
    getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
  };
}

describe("dispatchReplyFromConfig", () => {
  beforeEach(() => {
    resetInboundDedupe();
  });
  it("does not route when Provider matches OriginatingChannel (even if Surface is missing)", async () => {
    mocks.tryFastAbortFromMessage.mockResolvedValue({
      handled: false,
      aborted: false,
    });
    mocks.routeReply.mockClear();
    const cfg = {} as ClawdbotConfig;
    const dispatcher = createDispatcher();
    const ctx: MsgContext = {
      Provider: "slack",
      OriginatingChannel: "slack",
      OriginatingTo: "channel:C123",
    };

    const replyResolver = async (
      _ctx: MsgContext,
      _opts: GetReplyOptions | undefined,
      _cfg: ClawdbotConfig,
    ) => ({ text: "hi" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(mocks.routeReply).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledTimes(1);
  });

  it("routes when OriginatingChannel differs from Provider", async () => {
    mocks.tryFastAbortFromMessage.mockResolvedValue({
      handled: false,
      aborted: false,
    });
    mocks.routeReply.mockClear();
    const cfg = {} as ClawdbotConfig;
    const dispatcher = createDispatcher();
    const ctx: MsgContext = {
      Provider: "slack",
      AccountId: "acc-1",
      MessageThreadId: 123,
      OriginatingChannel: "telegram",
      OriginatingTo: "telegram:999",
    };

    const replyResolver = async (
      _ctx: MsgContext,
      _opts: GetReplyOptions | undefined,
      _cfg: ClawdbotConfig,
    ) => ({ text: "hi" }) satisfies ReplyPayload;
    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(dispatcher.sendFinalReply).not.toHaveBeenCalled();
    expect(mocks.routeReply).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        to: "telegram:999",
        accountId: "acc-1",
        threadId: 123,
      }),
    );
  });

  it("fast-aborts without calling the reply resolver", async () => {
    mocks.tryFastAbortFromMessage.mockResolvedValue({
      handled: true,
      aborted: true,
    });
    const cfg = {} as ClawdbotConfig;
    const dispatcher = createDispatcher();
    const ctx: MsgContext = {
      Provider: "telegram",
      Body: "/stop",
    };
    const replyResolver = vi.fn(async () => ({ text: "hi" }) as ReplyPayload);

    await dispatchReplyFromConfig({ ctx, cfg, dispatcher, replyResolver });

    expect(replyResolver).not.toHaveBeenCalled();
    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({
      text: "⚙️ Agent was aborted.",
    });
  });

  it("fast-abort reply includes stopped subagent count when provided", async () => {
    mocks.tryFastAbortFromMessage.mockResolvedValue({
      handled: true,
      aborted: true,
      stoppedSubagents: 2,
    });
    const cfg = {} as ClawdbotConfig;
    const dispatcher = createDispatcher();
    const ctx: MsgContext = {
      Provider: "telegram",
      Body: "/stop",
    };

    await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher,
      replyResolver: vi.fn(async () => ({ text: "hi" }) as ReplyPayload),
    });

    expect(dispatcher.sendFinalReply).toHaveBeenCalledWith({
      text: "⚙️ Agent was aborted. Stopped 2 sub-agents.",
    });
  });

  it("deduplicates inbound messages by MessageSid and origin", async () => {
    mocks.tryFastAbortFromMessage.mockResolvedValue({
      handled: false,
      aborted: false,
    });
    const cfg = {} as ClawdbotConfig;
    const ctx: MsgContext = {
      Provider: "whatsapp",
      OriginatingChannel: "whatsapp",
      OriginatingTo: "whatsapp:+15555550123",
      MessageSid: "msg-1",
    };
    const replyResolver = vi.fn(async () => ({ text: "hi" }) as ReplyPayload);

    await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher: createDispatcher(),
      replyResolver,
    });
    await dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher: createDispatcher(),
      replyResolver,
    });

    expect(replyResolver).toHaveBeenCalledTimes(1);
  });
});
