import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FinalizedMsgContext } from "../../../auto-reply/templating.js";
import type { ReplyPayload } from "../../../auto-reply/types.js";
import type { OpenClawConfig } from "../../../config/config.js";
import type { ResolvedAgentRoute } from "../../../routing/resolve-route.js";
import { createInboundSlackTestContext, createSlackTestAccount } from "./prepare.test-helpers.js";
import type { PreparedSlackMessage } from "./types.js";

const { dispatchInboundMessageMock } = vi.hoisted(() => ({
  dispatchInboundMessageMock: vi.fn(),
}));
const { deliverRepliesMock } = vi.hoisted(() => ({
  deliverRepliesMock: vi.fn<(params: unknown) => Promise<void>>(async () => {}),
}));

vi.mock("../../../auto-reply/dispatch.js", () => ({
  dispatchInboundMessage: (params: unknown) => dispatchInboundMessageMock(params),
}));
vi.mock("../replies.js", async () => {
  const actual = await vi.importActual<typeof import("../replies.js")>("../replies.js");
  return {
    ...actual,
    deliverReplies: (params: unknown) => deliverRepliesMock(params),
  };
});

const { dispatchPreparedSlackMessage } = await import("./dispatch.js");

type MockDispatchParams = {
  dispatcher: {
    sendFinalReply: (payload: ReplyPayload) => boolean;
    markComplete: () => void;
    waitForIdle: () => Promise<void>;
    getQueuedCounts: () => Record<"tool" | "block" | "final", number>;
  };
  replyOptions?: {
    onAssistantMessageStart?: () => Promise<void> | void;
    onReasoningEnd?: () => Promise<void> | void;
    onPartialReply?: (payload: ReplyPayload) => Promise<void> | void;
  };
};

function createPreparedSlackMessage(params?: {
  chatStream?: (args: {
    channel: string;
    thread_ts: string;
    recipient_team_id?: string;
    recipient_user_id?: string;
  }) => { append: (args: { markdown_text: string }) => Promise<void>; stop: () => Promise<void> };
  replyToMode?: "off" | "first" | "all";
}): PreparedSlackMessage {
  const cfg = { channels: { slack: {} } } as OpenClawConfig;
  const ctx = createInboundSlackTestContext({
    cfg,
    appClient: {
      chatStream: params?.chatStream,
    } as never,
    defaultRequireMention: false,
    replyToMode: params?.replyToMode ?? "first",
  });
  const route: ResolvedAgentRoute = {
    agentId: "main",
    channel: "slack",
    accountId: "default",
    sessionKey: "agent:main:slack:channel:C1",
    mainSessionKey: "agent:main:main",
    lastRoutePolicy: "session",
    matchedBy: "default",
  };
  const ctxPayload = {
    Surface: "slack",
    Provider: "slack",
    MessageThreadId: "1000.1",
    CommandBody: "review all openclaw discussions",
    RawBody: "review all openclaw discussions",
  } as FinalizedMsgContext;

  return {
    ctx,
    account: createSlackTestAccount({
      streaming: "partial",
      nativeStreaming: true,
      replyToMode: params?.replyToMode ?? "first",
    }),
    message: {
      type: "message",
      channel: "C1",
      ts: "1000.1",
      text: "review all openclaw discussions",
      user: "U1",
    },
    route,
    channelConfig: null,
    replyTarget: "channel:C1",
    ctxPayload,
    replyToMode: params?.replyToMode ?? "first",
    isDirectMessage: false,
    isRoomish: true,
    historyKey: "hist-1",
    preview: "review all openclaw discussions",
    ackReactionValue: "👀",
    ackReactionPromise: null,
  };
}

describe("dispatchPreparedSlackMessage native streaming", () => {
  beforeEach(() => {
    dispatchInboundMessageMock.mockReset();
    deliverRepliesMock.mockReset();
    deliverRepliesMock.mockResolvedValue(undefined);
  });

  it("streams partial assistant text before the final reply", async () => {
    const append = vi.fn(async () => {});
    const stop = vi.fn(async () => {});
    const chatStream = vi.fn(() => ({ append, stop }));

    dispatchInboundMessageMock.mockImplementation(async (raw: unknown) => {
      const params = raw as MockDispatchParams;
      await params.replyOptions?.onPartialReply?.({ text: "Hello" });
      await params.replyOptions?.onPartialReply?.({ text: "Hello world" });
      params.dispatcher.sendFinalReply({ text: "Hello world!" });
      params.dispatcher.markComplete();
      await params.dispatcher.waitForIdle();
      return {
        queuedFinal: true,
        counts: params.dispatcher.getQueuedCounts(),
      };
    });

    await dispatchPreparedSlackMessage(
      createPreparedSlackMessage({
        chatStream,
      }),
    );

    expect(chatStream).toHaveBeenCalledWith({
      channel: "C1",
      thread_ts: "1000.1",
      recipient_team_id: "T1",
      recipient_user_id: "U1",
    });
    expect(append).toHaveBeenCalledTimes(3);
    expect(append).toHaveBeenNthCalledWith(1, { markdown_text: "Hello" });
    expect(append).toHaveBeenNthCalledWith(2, { markdown_text: " world" });
    expect(append).toHaveBeenNthCalledWith(3, { markdown_text: "!" });
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("starts a new streamed segment after an assistant message boundary", async () => {
    const append = vi.fn(async () => {});
    const stop = vi.fn(async () => {});
    const chatStream = vi.fn(() => ({ append, stop }));

    dispatchInboundMessageMock.mockImplementation(async (raw: unknown) => {
      const params = raw as MockDispatchParams;
      await params.replyOptions?.onPartialReply?.({ text: "First pass" });
      await params.replyOptions?.onAssistantMessageStart?.();
      await params.replyOptions?.onPartialReply?.({ text: "Second" });
      params.dispatcher.sendFinalReply({ text: "Second message" });
      params.dispatcher.markComplete();
      await params.dispatcher.waitForIdle();
      return {
        queuedFinal: true,
        counts: params.dispatcher.getQueuedCounts(),
      };
    });

    await dispatchPreparedSlackMessage(
      createPreparedSlackMessage({
        chatStream,
      }),
    );

    expect(append).toHaveBeenCalledTimes(3);
    expect(append).toHaveBeenNthCalledWith(1, { markdown_text: "First pass" });
    expect(append).toHaveBeenNthCalledWith(2, { markdown_text: "\nSecond" });
    expect(append).toHaveBeenNthCalledWith(3, { markdown_text: " message" });
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("falls back to normal delivery when streaming append fails mid-stream", async () => {
    const append = vi
      .fn<({ markdown_text }: { markdown_text: string }) => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("append failed"));
    const stop = vi.fn(async () => {});
    const chatStream = vi.fn(() => ({ append, stop }));

    dispatchInboundMessageMock.mockImplementation(async (raw: unknown) => {
      const params = raw as MockDispatchParams;
      await params.replyOptions?.onPartialReply?.({ text: "Hello" });
      await params.replyOptions?.onPartialReply?.({ text: "Hello world" });
      params.dispatcher.sendFinalReply({ text: "Recovered final reply" });
      params.dispatcher.markComplete();
      await params.dispatcher.waitForIdle();
      return {
        queuedFinal: true,
        counts: params.dispatcher.getQueuedCounts(),
      };
    });

    await dispatchPreparedSlackMessage(createPreparedSlackMessage({ chatStream }));

    expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
    expect(deliverRepliesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [expect.objectContaining({ text: "Recovered final reply" })],
        replyThreadTs: "1000.1",
      }),
    );
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("bypasses native streaming for media payloads", async () => {
    const append = vi.fn(async () => {});
    const stop = vi.fn(async () => {});
    const chatStream = vi.fn(() => ({ append, stop }));

    dispatchInboundMessageMock.mockImplementation(async (raw: unknown) => {
      const params = raw as MockDispatchParams;
      params.dispatcher.sendFinalReply({
        text: "caption",
        mediaUrl: "https://example.com/report.png",
      });
      params.dispatcher.markComplete();
      await params.dispatcher.waitForIdle();
      return {
        queuedFinal: true,
        counts: params.dispatcher.getQueuedCounts(),
      };
    });

    await dispatchPreparedSlackMessage(createPreparedSlackMessage({ chatStream }));

    expect(chatStream).not.toHaveBeenCalled();
    expect(deliverRepliesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [
          expect.objectContaining({
            text: "caption",
            mediaUrl: "https://example.com/report.png",
          }),
        ],
      }),
    );
  });

  it("treats a rewritten final as an implicit new streamed segment", async () => {
    const append = vi.fn(async () => {});
    const stop = vi.fn(async () => {});
    const chatStream = vi.fn(() => ({ append, stop }));

    dispatchInboundMessageMock.mockImplementation(async (raw: unknown) => {
      const params = raw as MockDispatchParams;
      await params.replyOptions?.onPartialReply?.({ text: "Hello" });
      params.dispatcher.sendFinalReply({ text: "Rewritten final answer" });
      params.dispatcher.markComplete();
      await params.dispatcher.waitForIdle();
      return {
        queuedFinal: true,
        counts: params.dispatcher.getQueuedCounts(),
      };
    });

    await dispatchPreparedSlackMessage(createPreparedSlackMessage({ chatStream }));

    expect(deliverRepliesMock).not.toHaveBeenCalled();
    expect(append).toHaveBeenCalledTimes(2);
    expect(append).toHaveBeenNthCalledWith(1, { markdown_text: "Hello" });
    expect(append).toHaveBeenNthCalledWith(2, { markdown_text: "\nRewritten final answer" });
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("starts a new streamed segment after reasoning ends", async () => {
    const append = vi.fn(async () => {});
    const stop = vi.fn(async () => {});
    const chatStream = vi.fn(() => ({ append, stop }));

    dispatchInboundMessageMock.mockImplementation(async (raw: unknown) => {
      const params = raw as MockDispatchParams;
      await params.replyOptions?.onPartialReply?.({ text: "Status" });
      await params.replyOptions?.onReasoningEnd?.();
      await params.replyOptions?.onPartialReply?.({ text: "Answer" });
      params.dispatcher.sendFinalReply({ text: "Answer done" });
      params.dispatcher.markComplete();
      await params.dispatcher.waitForIdle();
      return {
        queuedFinal: true,
        counts: params.dispatcher.getQueuedCounts(),
      };
    });

    await dispatchPreparedSlackMessage(createPreparedSlackMessage({ chatStream }));

    expect(append).toHaveBeenCalledTimes(3);
    expect(append).toHaveBeenNthCalledWith(1, { markdown_text: "Status" });
    expect(append).toHaveBeenNthCalledWith(2, { markdown_text: "\nAnswer" });
    expect(append).toHaveBeenNthCalledWith(3, { markdown_text: " done" });
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
