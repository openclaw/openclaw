import { beforeEach, describe, expect, it, vi } from "vitest";

const reactSlackMessageMock = vi.fn(async () => ({}));
const removeSlackReactionMock = vi.fn(async () => ({}));
const dispatchInboundMessageMock = vi.fn(
  async (params: { replyOptions?: { onAgentRunStart?: (runId: string) => void } }) => {
    params.replyOptions?.onAgentRunStart?.("run-1");
    return { queuedFinal: false, counts: { final: 0, block: 0, tool: 0 } };
  },
);
const draftStreamClearMock = vi.fn(async () => {});
const markDispatchIdleMock = vi.fn();

vi.mock("../../../auto-reply/dispatch.js", () => ({
  dispatchInboundMessage: (params: unknown) => dispatchInboundMessageMock(params as never),
}));

vi.mock("../../../auto-reply/reply/reply-dispatcher.js", () => ({
  createReplyDispatcherWithTyping: () => ({
    dispatcher: {
      markComplete: () => {},
      waitForIdle: async () => {},
    },
    replyOptions: {},
    markDispatchIdle: markDispatchIdleMock,
  }),
}));

vi.mock("../../../agents/identity.js", () => ({
  resolveHumanDelayConfig: () => undefined,
}));

vi.mock("../../../auto-reply/reply/history.js", () => ({
  clearHistoryEntriesIfEnabled: () => {},
}));

vi.mock("../../../channels/reply-prefix.js", () => ({
  createReplyPrefixOptions: () => ({ onModelSelected: () => {} }),
}));

vi.mock("../../../channels/typing.js", () => ({
  createTypingCallbacks: () => ({
    start: async () => {},
    stop: async () => {},
    onIdle: () => {},
  }),
}));

vi.mock("../../../config/sessions.js", () => ({
  resolveStorePath: () => "/tmp/test-sessions.json",
  updateLastRoute: async () => {},
}));

vi.mock("../../../infra/outbound/identity.js", () => ({
  resolveAgentOutboundIdentity: () => null,
}));

vi.mock("../../../security/dm-policy-shared.js", () => ({
  resolvePinnedMainDmOwnerFromAllowlist: () => null,
}));

vi.mock("../../actions.js", () => ({
  reactSlackMessage: (...args: unknown[]) => reactSlackMessageMock(...args),
  removeSlackReaction: (...args: unknown[]) => removeSlackReactionMock(...args),
}));

vi.mock("../../draft-stream.js", () => ({
  createSlackDraftStream: () => ({
    flush: async () => {},
    stop: () => {},
    clear: draftStreamClearMock,
    update: () => {},
    forceNewMessage: () => {},
    messageId: () => undefined,
    channelId: () => undefined,
  }),
}));

vi.mock("../../format.js", () => ({
  normalizeSlackOutboundText: (text: string) => text,
}));

vi.mock("../../sent-thread-cache.js", () => ({
  recordSlackThreadParticipation: () => {},
}));

vi.mock("../../stream-mode.js", () => ({
  applyAppendOnlyStreamUpdate: ({ incoming }: { incoming: string }) => ({
    rendered: incoming,
    source: incoming,
    changed: true,
  }),
  buildStatusFinalPreviewText: () => "Status: complete.",
  resolveSlackStreamingConfig: () => ({
    mode: "off",
    nativeStreaming: false,
    draftMode: "replace",
  }),
}));

vi.mock("../../streaming.js", () => ({
  appendSlackStream: async () => {},
  startSlackStream: async () => ({ threadTs: "123.456", stopped: false }),
  stopSlackStream: async () => {},
}));

vi.mock("../../threading.js", () => ({
  resolveSlackThreadTargets: () => ({ statusThreadTs: undefined, isThreadReply: false }),
}));

vi.mock("../replies.js", () => ({
  createSlackReplyDeliveryPlan: () => ({
    nextThreadTs: () => undefined,
    markSent: () => {},
  }),
  deliverReplies: async () => {},
  resolveSlackThreadTs: () => undefined,
}));

import { dispatchPreparedSlackMessage } from "./dispatch.js";

describe("dispatchPreparedSlackMessage", () => {
  beforeEach(() => {
    reactSlackMessageMock.mockClear();
    removeSlackReactionMock.mockClear();
    dispatchInboundMessageMock.mockClear();
    draftStreamClearMock.mockClear();
    markDispatchIdleMock.mockClear();
  });

  it("starts the Slack ack reaction on agent run start when configured", async () => {
    await dispatchPreparedSlackMessage({
      ctx: {
        cfg: {},
        app: { client: {} },
        runtime: { error: vi.fn() },
        botToken: "xoxb-test",
        teamId: "T1",
        allowFrom: [],
        textLimit: 4000,
        typingReaction: "",
        removeAckAfterReply: false,
        ackReactionTiming: "run-start",
        setSlackThreadStatus: async () => {},
        channelHistories: new Map(),
        historyLimit: 0,
      },
      account: {
        accountId: "default",
        config: {},
      },
      message: {
        channel: "C123",
        ts: "123.456",
        user: "U123",
      },
      route: {
        agentId: "knox",
        accountId: "default",
        mainSessionKey: "agent:knox:main",
      },
      channelConfig: null,
      replyTarget: "user:U123",
      ctxPayload: {},
      replyToMode: "off",
      isDirectMessage: false,
      isRoomish: false,
      historyKey: "slack:C123",
      preview: "hello",
      ackReactionMessageTs: "123.456",
      ackReactionValue: "eyes",
      ackReactionAllowed: true,
      ackReactionPromise: null,
    } as never);

    expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
    expect(reactSlackMessageMock).toHaveBeenCalledTimes(1);
    expect(reactSlackMessageMock).toHaveBeenCalledWith("C123", "123.456", "eyes", {
      token: "xoxb-test",
      client: {},
    });
    expect(draftStreamClearMock).toHaveBeenCalledTimes(1);
  });

  it("does not start the Slack ack reaction on run start when the scope gate disallows it", async () => {
    await dispatchPreparedSlackMessage({
      ctx: {
        cfg: {},
        app: { client: {} },
        runtime: { error: vi.fn() },
        botToken: "xoxb-test",
        teamId: "T1",
        allowFrom: [],
        textLimit: 4000,
        typingReaction: "",
        removeAckAfterReply: false,
        ackReactionTiming: "run-start",
        setSlackThreadStatus: async () => {},
        channelHistories: new Map(),
        historyLimit: 0,
      },
      account: {
        accountId: "default",
        config: {},
      },
      message: {
        channel: "C123",
        ts: "123.456",
        user: "U123",
      },
      route: {
        agentId: "knox",
        accountId: "default",
        mainSessionKey: "agent:knox:main",
      },
      channelConfig: null,
      replyTarget: "user:U123",
      ctxPayload: {},
      replyToMode: "off",
      isDirectMessage: false,
      isRoomish: false,
      historyKey: "slack:C123",
      preview: "hello",
      ackReactionMessageTs: "123.456",
      ackReactionValue: "eyes",
      ackReactionAllowed: false,
      ackReactionPromise: null,
    } as never);

    expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
    expect(reactSlackMessageMock).not.toHaveBeenCalled();
    expect(draftStreamClearMock).toHaveBeenCalledTimes(1);
  });
});
