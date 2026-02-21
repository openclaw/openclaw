import { beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchPreparedSlackMessage } from "./dispatch.js";

const testState = vi.hoisted(() => ({
  deliver: null as null | ((payload: Record<string, unknown>) => Promise<void>),
  finalPayload: { text: "Final response text" } as Record<string, unknown>,
  draft: null as null | {
    flush: ReturnType<typeof vi.fn>;
    clear: ReturnType<typeof vi.fn>;
  },
}));

const chatUpdateMock = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
const dispatchInboundMessageMock = vi.hoisted(() =>
  vi.fn(
    async (params: {
      replyOptions?: {
        onPartialReply?: (payload: { text?: string }) => Promise<void> | void;
      };
    }) => {
      await params.replyOptions?.onPartialReply?.({ text: "Partial draft text" });
      if (!testState.deliver) {
        throw new Error("missing deliver callback");
      }
      await testState.deliver(testState.finalPayload);
      return { queuedFinal: false, counts: { final: 1, block: 0, tool: 0 } };
    },
  ),
);
const deliverRepliesMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("../../../agents/identity.js", () => ({
  resolveHumanDelayConfig: vi.fn(() => undefined),
}));

vi.mock("../../../auto-reply/dispatch.js", () => ({
  dispatchInboundMessage: dispatchInboundMessageMock,
}));

vi.mock("../../../auto-reply/reply/history.js", () => ({
  clearHistoryEntriesIfEnabled: vi.fn(() => undefined),
}));

vi.mock("../../../auto-reply/reply/reply-dispatcher.js", () => ({
  createReplyDispatcherWithTyping: vi.fn((params: { deliver: typeof testState.deliver }) => {
    testState.deliver = params.deliver;
    return { dispatcher: {}, replyOptions: {}, markDispatchIdle: vi.fn() };
  }),
}));

vi.mock("../../../channels/ack-reactions.js", () => ({
  removeAckReactionAfterReply: vi.fn(() => undefined),
}));

vi.mock("../../../channels/logging.js", () => ({
  logAckFailure: vi.fn(() => undefined),
  logTypingFailure: vi.fn(() => undefined),
}));

vi.mock("../../../channels/reply-prefix.js", () => ({
  createReplyPrefixOptions: vi.fn(() => ({ onModelSelected: undefined })),
}));

vi.mock("../../../channels/typing.js", () => ({
  createTypingCallbacks: vi.fn(() => ({
    onReplyStart: vi.fn(),
    onIdle: vi.fn(),
  })),
}));

vi.mock("../../../config/sessions.js", () => ({
  resolveStorePath: vi.fn(() => "/tmp/sessions.json"),
  updateLastRoute: vi.fn(async () => undefined),
}));

vi.mock("../../../globals.js", () => ({
  danger: (message: string) => message,
  logVerbose: vi.fn(() => undefined),
  shouldLogVerbose: vi.fn(() => false),
}));

vi.mock("../../actions.js", () => ({
  removeSlackReaction: vi.fn(async () => undefined),
}));

vi.mock("../../draft-stream.js", () => ({
  createSlackDraftStream: vi.fn((params: { onMessageSent?: () => void }) => {
    let pendingText = "";
    let channelId: string | undefined;
    let messageId: string | undefined;
    const stream = {
      update: vi.fn((text: string) => {
        pendingText = text;
      }),
      flush: vi.fn(async () => {
        if (pendingText && !messageId) {
          channelId = "C-preview";
          messageId = "200.300";
          params.onMessageSent?.();
        }
        pendingText = "";
      }),
      clear: vi.fn(async () => {
        pendingText = "";
        channelId = undefined;
        messageId = undefined;
      }),
      stop: vi.fn(() => undefined),
      forceNewMessage: vi.fn(() => {
        pendingText = "";
        channelId = undefined;
        messageId = undefined;
      }),
      messageId: vi.fn(() => messageId),
      channelId: vi.fn(() => channelId),
    };
    testState.draft = stream;
    return stream;
  }),
}));

vi.mock("../../stream-mode.js", () => ({
  applyAppendOnlyStreamUpdate: vi.fn((params: { incoming: string }) => ({
    rendered: params.incoming,
    source: params.incoming,
    changed: true,
  })),
  buildStatusFinalPreviewText: vi.fn(() => "Status: thinking..."),
  resolveSlackStreamMode: vi.fn(() => "replace"),
}));

vi.mock("../../streaming.js", () => ({
  appendSlackStream: vi.fn(async () => undefined),
  startSlackStream: vi.fn(async () => ({ stopped: false, threadTs: "100.200" })),
  stopSlackStream: vi.fn(async () => undefined),
}));

vi.mock("../../threading.js", () => ({
  resolveSlackThreadTargets: vi.fn(() => ({ statusThreadTs: undefined })),
}));

vi.mock("../replies.js", () => ({
  createSlackReplyDeliveryPlan: vi.fn(() => ({
    nextThreadTs: vi.fn(() => "100.200"),
    markSent: vi.fn(() => undefined),
  })),
  deliverReplies: deliverRepliesMock,
  resolveSlackThreadTs: vi.fn(() => "100.200"),
}));

function createPrepared() {
  return {
    ctx: {
      cfg: {},
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
      },
      replyToMode: "all",
      setSlackThreadStatus: vi.fn(async () => undefined),
      textLimit: 4000,
      botToken: "xoxb-test",
      app: {
        client: {
          chat: {
            update: chatUpdateMock,
          },
        },
      },
      teamId: "T1",
      channelHistories: new Map(),
      historyLimit: 20,
      removeAckAfterReply: false,
    },
    account: {
      accountId: "aiden",
      config: {
        streaming: false,
        streamMode: "replace",
      },
    },
    message: {
      channel: "C1",
      user: "U1",
      ts: "100.200",
      event_ts: "100.200",
    },
    route: {
      agentId: "main",
      mainSessionKey: "agent:main:main",
      accountId: "aiden",
    },
    channelConfig: null,
    replyTarget: "channel:C1",
    ctxPayload: {},
    isDirectMessage: false,
    isRoomish: false,
    historyKey: "C1",
    preview: "hello",
    ackReactionValue: "eyes",
    ackReactionPromise: null,
  } as never;
}

describe("dispatchPreparedSlackMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testState.deliver = null;
    testState.finalPayload = { text: "Final response text" };
    testState.draft = null;
  });

  it("flushes pending draft before final send and edits preview instead of posting duplicate text", async () => {
    await dispatchPreparedSlackMessage(createPrepared());

    expect(testState.draft?.flush).toHaveBeenCalled();
    expect(chatUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C-preview",
        ts: "200.300",
        text: "Final response text",
      }),
    );
    expect(deliverRepliesMock).not.toHaveBeenCalled();
  });

  it("clears stale preview before fallback send when final payload cannot edit preview", async () => {
    testState.finalPayload = { text: "Something failed", isError: true };

    await dispatchPreparedSlackMessage(createPrepared());

    expect(chatUpdateMock).not.toHaveBeenCalled();
    expect(testState.draft?.clear).toHaveBeenCalledTimes(1);
    expect(deliverRepliesMock).toHaveBeenCalledTimes(1);
  });
});
