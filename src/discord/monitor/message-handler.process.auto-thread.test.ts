import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBaseDiscordMessageContext } from "./message-handler.test-harness.js";

const dispatchInboundMessage = vi.fn(async (_params?: unknown) => ({
  queuedFinal: false,
  counts: { final: 0, tool: 0, block: 0 },
}));
const recordInboundSession = vi.fn(async () => {});

vi.mock("../../auto-reply/dispatch.js", () => ({ dispatchInboundMessage }));
vi.mock("../../channels/session.js", () => ({ recordInboundSession }));
vi.mock("../../config/sessions.js", () => ({
  readSessionUpdatedAt: vi.fn(() => undefined),
  resolveStorePath: vi.fn(() => "/tmp/openclaw-discord-process-test-sessions.json"),
}));
vi.mock("../send.js", () => ({
  reactMessageDiscord: vi.fn(async () => {}),
  removeReactionDiscord: vi.fn(async () => {}),
}));
vi.mock("../send.messages.js", () => ({ editMessageDiscord: vi.fn(async () => ({})) }));
vi.mock("../draft-stream.js", () => ({
  createDiscordDraftStream: vi.fn(() => ({
    update: vi.fn(),
    flush: vi.fn(async () => {}),
    messageId: vi.fn(() => "preview-1"),
    clear: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    forceNewMessage: vi.fn(),
  })),
}));
vi.mock("./reply-delivery.js", () => ({ deliverDiscordReply: vi.fn(async () => {}) }));
vi.mock("../../auto-reply/reply/reply-dispatcher.js", () => ({
  createReplyDispatcherWithTyping: vi.fn(
    (opts: { deliver: (payload: unknown, info: { kind: string }) => Promise<void> | void }) => ({
      dispatcher: {
        sendToolResult: vi.fn(() => true),
        sendBlockReply: vi.fn((payload: unknown) => {
          void opts.deliver(payload as never, { kind: "block" });
          return true;
        }),
        sendFinalReply: vi.fn((payload: unknown) => {
          void opts.deliver(payload as never, { kind: "final" });
          return true;
        }),
        waitForIdle: vi.fn(async () => {}),
        getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
        markComplete: vi.fn(),
      },
      replyOptions: {},
      markDispatchIdle: vi.fn(),
      markRunComplete: vi.fn(),
    }),
  ),
}));
vi.mock("./threading.js", async () => {
  const actual = await vi.importActual<typeof import("./threading.js")>("./threading.js");
  return {
    ...actual,
    resolveDiscordAutoThreadReplyPlan: vi.fn(async () => ({
      deliverTarget: "channel:thread-99",
      replyTarget: "channel:thread-99",
      replyReference: null,
      createdThreadId: "thread-99",
      autoThreadContext: {
        createdThreadId: "thread-99",
        From: "discord:channel:thread-99",
        To: "channel:thread-99",
        OriginatingTo: "channel:thread-99",
        SessionKey: "agent:main:discord:channel:thread-99",
        ParentSessionKey: "agent:main:discord:channel:c1",
      },
    })),
    resolveDiscordThreadStarter: vi.fn(async () => null),
  };
});

const { processDiscordMessage } = await import("./message-handler.process.js");

beforeEach(() => {
  dispatchInboundMessage.mockClear();
  recordInboundSession.mockClear();
});

function getLastDispatchCtx() {
  const callArgs = dispatchInboundMessage.mock.calls.at(-1) as unknown[] | undefined;
  const params = callArgs?.[0] as
    | {
        ctx?: {
          SessionKey?: string;
          ParentSessionKey?: string;
          SkipParentSessionFork?: boolean;
          MessageThreadId?: string | number;
        };
      }
    | undefined;
  return params?.ctx;
}

describe("processDiscordMessage auto-thread inheritance", () => {
  it("marks auto-created thread sessions to skip parent fork in fresh mode", async () => {
    const ctx = await createBaseDiscordMessageContext({
      discordConfig: { threadContext: { parentInheritance: "fresh" } },
      threadChannel: null,
      threadParentId: undefined,
      threadParentName: undefined,
      messageChannelId: "c1",
      route: {
        agentId: "main",
        channel: "discord",
        accountId: "default",
        sessionKey: "agent:main:discord:channel:c1",
        mainSessionKey: "agent:main:main",
      },
      baseSessionKey: "agent:main:discord:channel:c1",
    });

    await processDiscordMessage(ctx as never);

    expect(getLastDispatchCtx()).toMatchObject({
      SessionKey: "agent:main:discord:channel:thread-99",
      ParentSessionKey: "agent:main:discord:channel:c1",
      SkipParentSessionFork: true,
      MessageThreadId: "thread-99",
    });
  });
});
