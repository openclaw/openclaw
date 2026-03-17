import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedSlackAccount } from "../../../../extensions/slack/src/accounts.js";
import { prepareSlackMessage } from "../../../../extensions/slack/src/monitor/message-handler/prepare.js";
import { createInboundSlackTestContext } from "../../../../extensions/slack/src/monitor/message-handler/prepare.test-helpers.js";
import type { SlackMessageEvent } from "../../../../extensions/slack/src/types.js";
import type { MsgContext } from "../../../auto-reply/templating.js";
import type { OpenClawConfig } from "../../../config/config.js";
import { inboundCtxCapture } from "./inbound-contract-dispatch-mock.js";
import { expectChannelInboundContextContract } from "./suites.js";

const signalCapture = vi.hoisted(() => ({ ctx: undefined as MsgContext | undefined }));
const bufferedReplyCapture = vi.hoisted(() => ({
  ctx: undefined as MsgContext | undefined,
}));
const dispatchInboundMessageMock = vi.hoisted(() =>
  vi.fn(
    async (params: {
      ctx: MsgContext;
      replyOptions?: { onReplyStart?: () => void | Promise<void> };
    }) => {
      signalCapture.ctx = params.ctx;
      await Promise.resolve(params.replyOptions?.onReplyStart?.());
      return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
    },
  ),
);

vi.mock("../../../auto-reply/dispatch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../auto-reply/dispatch.js")>();
  return {
    ...actual,
    dispatchInboundMessage: dispatchInboundMessageMock,
    dispatchInboundMessageWithDispatcher: dispatchInboundMessageMock,
    dispatchInboundMessageWithBufferedDispatcher: dispatchInboundMessageMock,
  };
});

vi.mock("../../../auto-reply/reply/provider-dispatcher.js", () => ({
  dispatchReplyWithBufferedBlockDispatcher: vi.fn(async (params: { ctx: MsgContext }) => {
    bufferedReplyCapture.ctx = params.ctx;
    return { queuedFinal: false };
  }),
}));

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

const { processDiscordMessage } =
  await import("../../../../extensions/discord/src/monitor/message-handler.process.js");
const { createBaseDiscordMessageContext, createDiscordDirectMessageContextOverrides } =
  await import("../../../../extensions/discord/src/monitor/message-handler.test-harness.js");
const { createSignalEventHandler } =
  await import("../../../../extensions/signal/src/monitor/event-handler.js");
const { createBaseSignalEventHandlerDeps, createSignalReceiveEvent } =
  await import("../../../../extensions/signal/src/monitor/event-handler.test-harness.js");
const { processMessage } =
  await import("../../../../extensions/whatsapp/src/auto-reply/monitor/process-message.js");

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

function makeWhatsAppProcessArgs(sessionStorePath: string) {
  return {
    // oxlint-disable-next-line typescript/no-explicit-any
    cfg: { messages: {}, session: { store: sessionStorePath } } as any,
    // oxlint-disable-next-line typescript/no-explicit-any
    msg: {
      id: "msg1",
      from: "123@g.us",
      to: "+15550001111",
      chatType: "group",
      body: "hi",
      senderName: "Alice",
      senderJid: "alice@s.whatsapp.net",
      senderE164: "+15550002222",
      groupSubject: "Test Group",
      groupParticipants: [],
    } as unknown as Record<string, unknown>,
    route: {
      agentId: "main",
      accountId: "default",
      sessionKey: "agent:main:whatsapp:group:123",
      // oxlint-disable-next-line typescript/no-explicit-any
    } as any,
    groupHistoryKey: "123@g.us",
    groupHistories: new Map(),
    groupMemberNames: new Map(),
    connectionId: "conn",
    verbose: false,
    maxMediaBytes: 1,
    // oxlint-disable-next-line typescript/no-explicit-any
    replyResolver: (async () => undefined) as any,
    // oxlint-disable-next-line typescript/no-explicit-any
    replyLogger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any,
    backgroundTasks: new Set<Promise<unknown>>(),
    rememberSentText: () => {},
    echoHas: () => false,
    echoForget: () => {},
    buildCombinedEchoKey: () => "echo",
    groupHistory: [],
    // oxlint-disable-next-line typescript/no-explicit-any
  } as any;
}

async function removeDirEventually(dir: string) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY" || attempt === 2) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

describe("channel inbound contract", () => {
  let whatsappSessionDir = "";

  beforeEach(() => {
    inboundCtxCapture.ctx = undefined;
    signalCapture.ctx = undefined;
    bufferedReplyCapture.ctx = undefined;
    dispatchInboundMessageMock.mockClear();
  });

  afterEach(async () => {
    if (whatsappSessionDir) {
      await removeDirEventually(whatsappSessionDir);
      whatsappSessionDir = "";
    }
  });

  it("keeps Discord inbound context finalized", async () => {
    const messageCtx = await createBaseDiscordMessageContext({
      cfg: { messages: {} },
      ackReactionScope: "direct",
      ...createDiscordDirectMessageContextOverrides(),
    });

    await processDiscordMessage(messageCtx);

    expect(inboundCtxCapture.ctx).toBeTruthy();
    expectChannelInboundContextContract(inboundCtxCapture.ctx!);
  });

  it("keeps Signal inbound context finalized", async () => {
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        // oxlint-disable-next-line typescript/no-explicit-any
        cfg: { messages: { inbound: { debounceMs: 0 } } } as any,
        historyLimit: 0,
      }),
    );

    await handler(
      createSignalReceiveEvent({
        dataMessage: {
          message: "hi",
          attachments: [],
          groupInfo: { groupId: "g1", groupName: "Test Group" },
        },
      }),
    );

    expect(signalCapture.ctx).toBeTruthy();
    expectChannelInboundContextContract(signalCapture.ctx!);
  });

  it("keeps Slack inbound context finalized", async () => {
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

  it("keeps Telegram inbound context finalized", async () => {
    const { getLoadConfigMock, getOnHandler, onSpy, sendMessageSpy } =
      await import("../../../../extensions/telegram/src/bot.create-telegram-bot.test-harness.js");
    const { resetInboundDedupe } = await import("../../../auto-reply/reply/inbound-dedupe.js");

    resetInboundDedupe();
    onSpy.mockReset();
    sendMessageSpy.mockReset();
    sendMessageSpy.mockResolvedValue({ message_id: 77 });
    getLoadConfigMock().mockReset();
    getLoadConfigMock().mockReturnValue({
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
    } satisfies OpenClawConfig);

    const { createTelegramBot } = await import("../../../../extensions/telegram/src/bot.js");

    createTelegramBot({ token: "tok" });
    const handler = getOnHandler("message") as (ctx: Record<string, unknown>) => Promise<void>;

    await handler({
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
      me: { username: "openclaw_bot" },
      getFile: async () => ({ download: async () => new Uint8Array() }),
    });

    const payload = bufferedReplyCapture.ctx;
    expect(payload).toBeTruthy();
    expectChannelInboundContextContract(payload!);
  });

  it("keeps WhatsApp inbound context finalized", async () => {
    whatsappSessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-whatsapp-contract-"));
    const sessionStorePath = path.join(whatsappSessionDir, "sessions.json");

    await processMessage(makeWhatsAppProcessArgs(sessionStorePath));

    expect(bufferedReplyCapture.ctx).toBeTruthy();
    expectChannelInboundContextContract(bufferedReplyCapture.ctx!);
  });
});
