import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  registerTelegramNativeCommands,
  type RegisterTelegramHandlerParams,
} from "./bot-native-commands.js";
import { createNativeCommandTestParams } from "./bot-native-commands.test-helpers.js";

// All mocks scoped to this file only — does not affect bot-native-commands.test.ts

type ResolveConfiguredAcpBindingRecordFn =
  typeof import("../acp/persistent-bindings.js").resolveConfiguredAcpBindingRecord;
type EnsureConfiguredAcpBindingSessionFn =
  typeof import("../acp/persistent-bindings.js").ensureConfiguredAcpBindingSession;
type DispatchReplyWithBufferedBlockDispatcherFn =
  typeof import("../auto-reply/reply/provider-dispatcher.js").dispatchReplyWithBufferedBlockDispatcher;
type DispatchReplyWithBufferedBlockDispatcherParams =
  Parameters<DispatchReplyWithBufferedBlockDispatcherFn>[0];
type DispatchReplyWithBufferedBlockDispatcherResult = Awaited<
  ReturnType<DispatchReplyWithBufferedBlockDispatcherFn>
>;
type DeliverRepliesFn = typeof import("./bot/delivery.js").deliverReplies;
type DeliverRepliesParams = Parameters<DeliverRepliesFn>[0];

const dispatchReplyResult: DispatchReplyWithBufferedBlockDispatcherResult = {
  queuedFinal: false,
  counts: {} as DispatchReplyWithBufferedBlockDispatcherResult["counts"],
};

const persistentBindingMocks = vi.hoisted(() => ({
  resolveConfiguredAcpBindingRecord: vi.fn<ResolveConfiguredAcpBindingRecordFn>(() => null),
  ensureConfiguredAcpBindingSession: vi.fn<EnsureConfiguredAcpBindingSessionFn>(async () => ({
    ok: true,
    sessionKey: "agent:codex:acp:binding:telegram:default:seed",
  })),
}));
const sessionMocks = vi.hoisted(() => ({
  recordSessionMetaFromInbound: vi.fn(),
  resolveStorePath: vi.fn(),
}));
const replyMocks = vi.hoisted(() => ({
  dispatchReplyWithBufferedBlockDispatcher: vi.fn<DispatchReplyWithBufferedBlockDispatcherFn>(
    async () => dispatchReplyResult,
  ),
}));
const deliveryMocks = vi.hoisted(() => ({
  deliverReplies: vi.fn<DeliverRepliesFn>(async () => ({ delivered: true })),
}));
const sessionBindingMocks = vi.hoisted(() => ({
  resolveByConversation: vi.fn<
    (ref: unknown) => { bindingId: string; targetSessionKey: string } | null
  >(() => null),
  touch: vi.fn(),
}));
const typingMocks = vi.hoisted(() => ({
  sendChatAction: vi.fn(async () => undefined),
}));

vi.mock("../acp/persistent-bindings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../acp/persistent-bindings.js")>();
  return {
    ...actual,
    resolveConfiguredAcpBindingRecord: persistentBindingMocks.resolveConfiguredAcpBindingRecord,
    ensureConfiguredAcpBindingSession: persistentBindingMocks.ensureConfiguredAcpBindingSession,
  };
});
vi.mock("../config/sessions.js", () => ({
  recordSessionMetaFromInbound: sessionMocks.recordSessionMetaFromInbound,
  resolveStorePath: sessionMocks.resolveStorePath,
}));
vi.mock("../pairing/pairing-store.js", () => ({
  readChannelAllowFromStore: vi.fn(async () => []),
}));
vi.mock("../auto-reply/reply/inbound-context.js", () => ({
  finalizeInboundContext: vi.fn((ctx: unknown) => ctx),
}));
vi.mock("../auto-reply/reply/provider-dispatcher.js", () => ({
  dispatchReplyWithBufferedBlockDispatcher: replyMocks.dispatchReplyWithBufferedBlockDispatcher,
}));
vi.mock("../channels/reply-prefix.js", () => ({
  createReplyPrefixOptions: vi.fn(() => ({ onModelSelected: () => {} })),
}));
vi.mock("../infra/outbound/session-binding-service.js", () => ({
  getSessionBindingService: () => ({
    bind: vi.fn(),
    getCapabilities: vi.fn(),
    listBySession: vi.fn(),
    resolveByConversation: (ref: unknown) => sessionBindingMocks.resolveByConversation(ref),
    touch: (bindingId: string, at?: number) => sessionBindingMocks.touch(bindingId, at),
    unbind: vi.fn(),
  }),
}));
vi.mock("../auto-reply/skill-commands.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auto-reply/skill-commands.js")>();
  return { ...actual, listSkillCommandsForAgents: vi.fn(() => []) };
});
vi.mock("../plugins/commands.js", () => ({
  getPluginCommandSpecs: vi.fn(() => []),
  matchPluginCommand: vi.fn(() => null),
  executePluginCommand: vi.fn(async () => ({ text: "ok" })),
}));
vi.mock("./bot/delivery.js", () => ({
  deliverReplies: deliveryMocks.deliverReplies,
}));

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

type TelegramCommandHandler = (ctx: unknown) => Promise<void>;

function buildStatusCommandContext() {
  return {
    match: "",
    message: {
      message_id: 1,
      date: Math.floor(Date.now() / 1000),
      chat: { id: 100, type: "private" as const },
      from: { id: 200, username: "bob" },
    },
  };
}

function buildStatusTopicCommandContext() {
  return {
    match: "",
    message: {
      message_id: 2,
      date: Math.floor(Date.now() / 1000),
      chat: {
        id: -1001234567890,
        type: "supergroup" as const,
        title: "OpenClaw",
        is_forum: true,
      },
      message_thread_id: 42,
      from: { id: 200, username: "bob" },
    },
  };
}

function registerAndResolveStatusHandler(params: {
  cfg: OpenClawConfig;
  allowFrom?: string[];
  groupAllowFrom?: string[];
  resolveTelegramGroupConfig?: RegisterTelegramHandlerParams["resolveTelegramGroupConfig"];
}): {
  handler: TelegramCommandHandler;
  sendMessage: ReturnType<typeof vi.fn>;
} {
  const { cfg, allowFrom, groupAllowFrom, resolveTelegramGroupConfig } = params;
  return registerAndResolveCommandHandlerBase({
    commandName: "status",
    cfg,
    allowFrom: allowFrom ?? ["*"],
    groupAllowFrom: groupAllowFrom ?? [],
    useAccessGroups: true,
    resolveTelegramGroupConfig,
  });
}

function registerAndResolveCommandHandlerBase(params: {
  commandName: string;
  cfg: OpenClawConfig;
  allowFrom: string[];
  groupAllowFrom: string[];
  useAccessGroups: boolean;
  resolveTelegramGroupConfig?: RegisterTelegramHandlerParams["resolveTelegramGroupConfig"];
}): {
  handler: TelegramCommandHandler;
  sendMessage: ReturnType<typeof vi.fn>;
} {
  const {
    commandName,
    cfg,
    allowFrom,
    groupAllowFrom,
    useAccessGroups,
    resolveTelegramGroupConfig,
  } = params;
  const commandHandlers = new Map<string, TelegramCommandHandler>();
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  registerTelegramNativeCommands({
    ...createNativeCommandTestParams({
      bot: {
        api: {
          setMyCommands: vi.fn().mockResolvedValue(undefined),
          sendMessage,
        },
        command: vi.fn((name: string, cb: TelegramCommandHandler) => {
          commandHandlers.set(name, cb);
        }),
      } as unknown as Parameters<typeof registerTelegramNativeCommands>[0]["bot"],
      cfg,
      allowFrom: ["*"],
      sendChatActionHandler: {
        sendChatAction: typingMocks.sendChatAction,
        isSuspended: () => false,
        reset: () => {},
      },
    }),
  });

  const handler = commandHandlers.get(commandName);
  expect(handler).toBeTruthy();
  return { handler: handler as TelegramCommandHandler, sendMessage };
}

function registerAndResolveCommandHandler(params: {
  commandName: string;
  cfg: OpenClawConfig;
  allowFrom?: string[];
  groupAllowFrom?: string[];
  useAccessGroups?: boolean;
  resolveTelegramGroupConfig?: RegisterTelegramHandlerParams["resolveTelegramGroupConfig"];
}): {
  handler: TelegramCommandHandler;
  sendMessage: ReturnType<typeof vi.fn>;
} {
  const {
    commandName,
    cfg,
    allowFrom,
    groupAllowFrom,
    useAccessGroups,
    resolveTelegramGroupConfig,
  } = params;
  return registerAndResolveCommandHandlerBase({
    commandName,
    cfg,
    allowFrom: allowFrom ?? [],
    groupAllowFrom: groupAllowFrom ?? [],
    useAccessGroups: useAccessGroups ?? true,
    resolveTelegramGroupConfig,
  });
}

function createConfiguredAcpTopicBinding(boundSessionKey: string) {
  return {
    spec: {
      channel: "telegram",
      accountId: "default",
      conversationId: "-1001234567890:topic:42",
      parentConversationId: "-1001234567890",
      agentId: "codex",
      mode: "persistent",
    },
    record: {
      bindingId: "config:acp:telegram:default:-1001234567890:topic:42",
      targetSessionKey: boundSessionKey,
      targetKind: "session",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "-1001234567890:topic:42",
        parentConversationId: "-1001234567890",
      },
      status: "active",
      boundAt: 0,
    },
  } satisfies import("../acp/persistent-bindings.js").ResolvedConfiguredAcpBinding;
}

function expectUnauthorizedNewCommandBlocked(sendMessage: ReturnType<typeof vi.fn>) {
  expect(replyMocks.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
  expect(persistentBindingMocks.resolveConfiguredAcpBindingRecord).not.toHaveBeenCalled();
  expect(persistentBindingMocks.ensureConfiguredAcpBindingSession).not.toHaveBeenCalled();
  expect(sendMessage).toHaveBeenCalledWith(
    -1001234567890,
    "You are not authorized to use this command.",
    expect.objectContaining({ message_thread_id: 42 }),
  );
}

describe("registerTelegramNativeCommands — session metadata", () => {
  beforeEach(() => {
    persistentBindingMocks.resolveConfiguredAcpBindingRecord.mockClear();
    persistentBindingMocks.resolveConfiguredAcpBindingRecord.mockReturnValue(null);
    persistentBindingMocks.ensureConfiguredAcpBindingSession.mockClear();
    persistentBindingMocks.ensureConfiguredAcpBindingSession.mockResolvedValue({
      ok: true,
      sessionKey: "agent:codex:acp:binding:telegram:default:seed",
    });
    sessionMocks.recordSessionMetaFromInbound.mockClear().mockResolvedValue(undefined);
    sessionMocks.resolveStorePath.mockClear().mockReturnValue("/tmp/openclaw-sessions.json");
    replyMocks.dispatchReplyWithBufferedBlockDispatcher.mockClear().mockResolvedValue(undefined);
    typingMocks.sendChatAction.mockClear().mockResolvedValue(undefined);
  });

  it("calls recordSessionMetaFromInbound after a native slash command", async () => {
    const cfg: OpenClawConfig = {};
    const { handler } = registerAndResolveStatusHandler({ cfg });
    await handler(buildStatusCommandContext());

    expect(sessionMocks.recordSessionMetaFromInbound).toHaveBeenCalledTimes(1);
    const call = (
      sessionMocks.recordSessionMetaFromInbound.mock.calls as unknown as Array<
        [{ sessionKey?: string; ctx?: { OriginatingChannel?: string; Provider?: string } }]
      >
    )[0]?.[0];
    expect(call?.ctx?.OriginatingChannel).toBe("telegram");
    expect(call?.ctx?.Provider).toBe("telegram");
    expect(call?.sessionKey).toBe("agent:main:telegram:slash:200");
  });

  it("awaits session metadata persistence before dispatch", async () => {
    const deferred = createDeferred<void>();
    sessionMocks.recordSessionMetaFromInbound.mockReturnValue(deferred.promise);

    const cfg: OpenClawConfig = {};
    const { handler } = registerAndResolveStatusHandler({ cfg });
    const runPromise = handler(buildStatusCommandContext());

    await vi.waitFor(() => {
      expect(sessionMocks.recordSessionMetaFromInbound).toHaveBeenCalledTimes(1);
    });
    expect(replyMocks.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();

    deferred.resolve();
    await runPromise;

    expect(replyMocks.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
  });

  it("wires typing callbacks into native slash command replies", async () => {
    replyMocks.dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({
        dispatcherOptions,
      }: {
        dispatcherOptions?: { typingCallbacks?: { onReplyStart?: () => Promise<void> } };
      }) => {
        await dispatcherOptions?.typingCallbacks?.onReplyStart?.();
        return undefined;
      },
    );

    const handler = registerAndResolveStatusHandler({});
    await handler(buildStatusCommandContext());

    expect(replyMocks.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        dispatcherOptions: expect.objectContaining({
          typingCallbacks: expect.any(Object),
        }),
      }),
    );
    expect(typingMocks.sendChatAction).toHaveBeenCalledWith(100, "typing", undefined);
  });
});
