import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { registerTelegramNativeCommands } from "./bot-native-commands.js";
import { createNativeCommandTestParams } from "./bot-native-commands.test-helpers.js";

// All mocks scoped to this file only — does not affect bot-native-commands.test.ts

type ResolveConfiguredAcpBindingRecordFn =
  typeof import("../acp/persistent-bindings.js").resolveConfiguredAcpBindingRecord;
type EnsureConfiguredAcpBindingSessionFn =
  typeof import("../acp/persistent-bindings.js").ensureConfiguredAcpBindingSession;

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
  dispatchReplyWithBufferedBlockDispatcher: vi.fn(async () => undefined),
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
  deliverReplies: vi.fn(async () => ({ delivered: true })),
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
}): {
  handler: TelegramCommandHandler;
  sendMessage: ReturnType<typeof vi.fn>;
} {
  const { cfg, allowFrom, groupAllowFrom } = params;
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
      allowFrom: allowFrom ?? ["*"],
      groupAllowFrom: groupAllowFrom ?? [],
    }),
  });

  const handler = commandHandlers.get("status");
  expect(handler).toBeTruthy();
  return { handler: handler as TelegramCommandHandler, sendMessage };
}

function registerAndResolveCommandHandler(params: {
  commandName: string;
  cfg: OpenClawConfig;
  allowFrom?: string[];
  groupAllowFrom?: string[];
  useAccessGroups?: boolean;
}): {
  handler: TelegramCommandHandler;
  sendMessage: ReturnType<typeof vi.fn>;
} {
  const { commandName, cfg, allowFrom, groupAllowFrom, useAccessGroups } = params;
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
      allowFrom: allowFrom ?? [],
      groupAllowFrom: groupAllowFrom ?? [],
      useAccessGroups: useAccessGroups ?? true,
    }),
  });

  const handler = commandHandlers.get(commandName);
  expect(handler).toBeTruthy();
  return { handler: handler as TelegramCommandHandler, sendMessage };
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
    expect(call?.sessionKey).toBeDefined();
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

  it("routes Telegram native commands through configured ACP topic bindings", async () => {
    const boundSessionKey = "agent:codex:acp:binding:telegram:default:feedface";
    persistentBindingMocks.resolveConfiguredAcpBindingRecord.mockReturnValue({
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
    });
    persistentBindingMocks.ensureConfiguredAcpBindingSession.mockResolvedValue({
      ok: true,
      sessionKey: boundSessionKey,
    });

    const { handler } = registerAndResolveStatusHandler({
      cfg: {},
      allowFrom: ["200"],
      groupAllowFrom: ["200"],
    });
    await handler(buildStatusTopicCommandContext());

    expect(persistentBindingMocks.resolveConfiguredAcpBindingRecord).toHaveBeenCalledTimes(1);
    expect(persistentBindingMocks.ensureConfiguredAcpBindingSession).toHaveBeenCalledTimes(1);
    const dispatchCall = (
      replyMocks.dispatchReplyWithBufferedBlockDispatcher.mock.calls as unknown as Array<
        [{ ctx?: { CommandTargetSessionKey?: string } }]
      >
    )[0]?.[0];
    expect(dispatchCall?.ctx?.CommandTargetSessionKey).toBe(boundSessionKey);
  });

  it("falls back to default routing when configured ACP topic binding cannot initialize", async () => {
    const boundSessionKey = "agent:codex:acp:binding:telegram:default:feedface";
    persistentBindingMocks.resolveConfiguredAcpBindingRecord.mockReturnValue({
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
    });
    persistentBindingMocks.ensureConfiguredAcpBindingSession.mockResolvedValue({
      ok: false,
      sessionKey: boundSessionKey,
      error: "gateway unavailable",
    });

    const { handler, sendMessage } = registerAndResolveStatusHandler({
      cfg: {},
      allowFrom: ["200"],
      groupAllowFrom: ["200"],
    });
    await handler(buildStatusTopicCommandContext());

    expect(replyMocks.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
    const dispatchCall = (
      replyMocks.dispatchReplyWithBufferedBlockDispatcher.mock.calls as unknown as Array<
        [{ ctx?: { CommandTargetSessionKey?: string } }]
      >
    )[0]?.[0];
    expect(dispatchCall?.ctx?.CommandTargetSessionKey).toBeTruthy();
    expect(dispatchCall?.ctx?.CommandTargetSessionKey).not.toBe(boundSessionKey);
    expect(sendMessage).not.toHaveBeenCalledWith(
      -1001234567890,
      "Configured ACP binding is unavailable right now. Please try again.",
      expect.anything(),
    );
  });

  it("keeps /new blocked in ACP-bound Telegram topics when sender is unauthorized", async () => {
    const boundSessionKey = "agent:codex:acp:binding:telegram:default:feedface";
    persistentBindingMocks.resolveConfiguredAcpBindingRecord.mockReturnValue({
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
    });
    persistentBindingMocks.ensureConfiguredAcpBindingSession.mockResolvedValue({
      ok: true,
      sessionKey: boundSessionKey,
    });

    const { handler, sendMessage } = registerAndResolveCommandHandler({
      commandName: "new",
      cfg: {},
      allowFrom: [],
      groupAllowFrom: [],
      useAccessGroups: true,
    });
    await handler(buildStatusTopicCommandContext());

    expect(replyMocks.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      -1001234567890,
      "You are not authorized to use this command.",
      expect.objectContaining({ message_thread_id: 42 }),
    );
  });

  it("keeps /new blocked for unbound Telegram topics when sender is unauthorized", async () => {
    persistentBindingMocks.resolveConfiguredAcpBindingRecord.mockReturnValue(null);

    const { handler, sendMessage } = registerAndResolveCommandHandler({
      commandName: "new",
      cfg: {},
      allowFrom: [],
      groupAllowFrom: [],
      useAccessGroups: true,
    });
    await handler(buildStatusTopicCommandContext());

    expect(replyMocks.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      -1001234567890,
      "You are not authorized to use this command.",
      expect.objectContaining({ message_thread_id: 42 }),
    );
  });
});
