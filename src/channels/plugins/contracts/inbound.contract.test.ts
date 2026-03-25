import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDiscordInboundAccessContext } from "../../../../extensions/discord/src/monitor/inbound-context.js";
import type { ResolvedSlackAccount } from "../../../../extensions/slack/src/accounts.js";
import type { SlackMessageEvent } from "../../../../extensions/slack/src/types.js";
import { withTempHome } from "../../../../test/helpers/temp-home.js";
import type { MsgContext } from "../../../auto-reply/templating.js";
import type { OpenClawConfig } from "../../../config/config.js";
import { inboundCtxCapture } from "./inbound-testkit.js";
import { expectChannelInboundContextContract } from "./suites.js";

const dispatchInboundMessageMock = vi.hoisted(() =>
  vi.fn(
    async (params: {
      ctx: MsgContext;
      replyOptions?: { onReplyStart?: () => void | Promise<void> };
    }) => {
      await Promise.resolve(params.replyOptions?.onReplyStart?.());
      return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
    },
  ),
);

vi.mock("openclaw/plugin-sdk/reply-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/reply-runtime")>();
  return {
    ...actual,
    dispatchInboundMessage: vi.fn(async (params: { ctx: MsgContext }) => {
      inboundCtxCapture.ctx = params.ctx;
      return await dispatchInboundMessageMock(params);
    }),
    dispatchInboundMessageWithDispatcher: vi.fn(async (params: { ctx: MsgContext }) => {
      inboundCtxCapture.ctx = params.ctx;
      return await dispatchInboundMessageMock(params);
    }),
    dispatchInboundMessageWithBufferedDispatcher: vi.fn(async (params: { ctx: MsgContext }) => {
      inboundCtxCapture.ctx = params.ctx;
      return await dispatchInboundMessageMock(params);
    }),
  };
});

vi.mock("openclaw/plugin-sdk/conversation-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/conversation-runtime")>();
  return {
    ...actual,
    recordInboundSession: vi.fn(async (params: { ctx: MsgContext }) => {
      inboundCtxCapture.ctx = params.ctx;
    }),
  };
});

vi.mock("../../../../extensions/signal/src/send.js", () => ({
  sendMessageSignal: vi.fn(),
  sendTypingSignal: vi.fn(async () => true),
  sendReadReceiptSignal: vi.fn(async () => true),
}));

vi.mock("../../../pairing/pairing-store.js", () => ({
  readChannelAllowFromStore: vi.fn().mockResolvedValue([]),
  upsertChannelPairingRequest: vi.fn(),
}));

vi.mock("../../../../extensions/whatsapp/src/auto-reply/monitor/last-route.js", () => ({
  trackBackgroundTask: (tasks: Set<Promise<unknown>>, task: Promise<unknown>) => {
    tasks.add(task);
    void task.finally(() => {
      tasks.delete(task);
    });
  },
  updateLastRouteInBackground: vi.fn(),
}));

vi.mock("../../../../extensions/whatsapp/src/auto-reply/deliver-reply.js", () => ({
  deliverWebReply: vi.fn(async () => {}),
}));

const { finalizeInboundContext } = await import("../../../auto-reply/reply/inbound-context.js");
const { prepareSlackMessage } =
  await import("../../../../extensions/slack/src/monitor/message-handler/prepare.js");
const { createInboundSlackTestContext } =
  await import("../../../../extensions/slack/src/monitor/message-handler/prepare.test-helpers.js");
const { buildTelegramMessageContextForTest } =
  await import("../../../../extensions/telegram/src/bot-message-context.test-harness.js");

function createSlackAccount(config: ResolvedSlackAccount["config"] = {}): ResolvedSlackAccount {
  return {
    accountId: "default",
    enabled: true,
    botTokenSource: "config",
    appTokenSource: "config",
    userTokenSource: "none",
    config,
    replyToMode: config.replyToMode,
    replyToModeByChatType: config.replyToModeByChatType,
    dm: config.dm,
  };
}

function createSlackMessage(overrides: Partial<SlackMessageEvent>): SlackMessageEvent {
  return {
    channel: "D123",
    channel_type: "im",
    user: "U1",
    text: "hi",
    ts: "1.000",
    ...overrides,
  } as SlackMessageEvent;
}

describe("channel inbound contract", () => {
  beforeEach(() => {
    inboundCtxCapture.ctx = undefined;
    dispatchInboundMessageMock.mockClear();
  });

  it("keeps Discord inbound context finalized", () => {
    const { groupSystemPrompt, ownerAllowFrom, untrustedContext } =
      buildDiscordInboundAccessContext({
        channelConfig: null,
        guildInfo: null,
        sender: { id: "U1", name: "Alice", tag: "alice" },
        isGuild: false,
      });

    const ctx = finalizeInboundContext({
      Body: "hi",
      BodyForAgent: "hi",
      RawBody: "hi",
      CommandBody: "hi",
      From: "discord:U1",
      To: "user:U1",
      SessionKey: "agent:main:discord:direct:u1",
      AccountId: "default",
      ChatType: "direct",
      ConversationLabel: "Alice",
      SenderName: "Alice",
      SenderId: "U1",
      SenderUsername: "alice",
      GroupSystemPrompt: groupSystemPrompt,
      OwnerAllowFrom: ownerAllowFrom,
      UntrustedContext: untrustedContext,
      Provider: "discord",
      Surface: "discord",
      WasMentioned: false,
      MessageSid: "m1",
      CommandAuthorized: true,
      OriginatingChannel: "discord",
      OriginatingTo: "user:U1",
    });

    expectChannelInboundContextContract(ctx);
  });

  it("keeps Signal inbound context finalized", async () => {
    const ctx = finalizeInboundContext({
      Body: "Alice: hi",
      BodyForAgent: "hi",
      RawBody: "hi",
      CommandBody: "hi",
      BodyForCommands: "hi",
      From: "group:g1",
      To: "group:g1",
      SessionKey: "agent:main:signal:group:g1",
      AccountId: "default",
      ChatType: "group",
      ConversationLabel: "Alice",
      GroupSubject: "Test Group",
      SenderName: "Alice",
      SenderId: "+15550001111",
      Provider: "signal",
      Surface: "signal",
      MessageSid: "1700000000000",
      OriginatingChannel: "signal",
      OriginatingTo: "group:g1",
      CommandAuthorized: true,
    });

    expectChannelInboundContextContract(ctx);
  });

  it("keeps Slack inbound context finalized", async () => {
    await withTempHome(async () => {
      const ctx = createInboundSlackTestContext({
        cfg: {
          channels: { slack: { enabled: true } },
        } as OpenClawConfig,
      });
      // oxlint-disable-next-line typescript/no-explicit-any
      ctx.resolveUserName = async () => ({ name: "Alice" }) as any;

      const prepared = await prepareSlackMessage({
        ctx,
        account: createSlackAccount(),
        message: createSlackMessage({}),
        opts: { source: "message" },
      });

      expect(prepared).toBeTruthy();
      expectChannelInboundContextContract(prepared!.ctxPayload);
    });
  });

  it("keeps Telegram inbound context finalized", async () => {
    const context = await buildTelegramMessageContextForTest({
      cfg: {
        agents: {
          defaults: {
            envelopeTimezone: "utc",
          },
        },
        channels: {
          telegram: {
            groupPolicy: "open",
            groups: { "*": { requireMention: false } },
          },
        },
      } satisfies OpenClawConfig,
      message: {
        chat: { id: 42, type: "group", title: "Ops" },
        text: "hello",
        date: 1736380800,
        message_id: 2,
        from: {
          id: 99,
          first_name: "Ada",
          last_name: "Lovelace",
          username: "ada",
        },
      },
    });

    const payload = context?.ctxPayload;
    expect(payload).toBeTruthy();
    expectChannelInboundContextContract(payload!);
  });

  it("keeps WhatsApp inbound context finalized", async () => {
    const ctx = finalizeInboundContext({
      Body: "Alice: hi",
      BodyForAgent: "hi",
      RawBody: "hi",
      CommandBody: "hi",
      BodyForCommands: "hi",
      From: "123@g.us",
      To: "+15550001111",
      SessionKey: "agent:main:whatsapp:group:123",
      AccountId: "default",
      ChatType: "group",
      ConversationLabel: "123@g.us",
      GroupSubject: "Test Group",
      SenderName: "Alice",
      SenderId: "alice@s.whatsapp.net",
      SenderE164: "+15550002222",
      Provider: "whatsapp",
      Surface: "whatsapp",
      MessageSid: "msg1",
      OriginatingChannel: "whatsapp",
      OriginatingTo: "123@g.us",
      CommandAuthorized: true,
    });

    expectChannelInboundContextContract(ctx);
  });
});
