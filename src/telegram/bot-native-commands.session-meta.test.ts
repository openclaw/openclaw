import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { TelegramAccountConfig } from "../config/types.js";
import type { RuntimeEnv } from "../runtime.js";
import { registerTelegramNativeCommands } from "./bot-native-commands.js";

// All mocks scoped to this file only — does not affect bot-native-commands.test.ts

const sessionMocks = vi.hoisted(() => ({
  recordSessionMetaFromInbound: vi.fn(),
  resolveStorePath: vi.fn(),
}));
const replyMocks = vi.hoisted(() => ({
  dispatchReplyWithBufferedBlockDispatcher: vi.fn(async () => undefined),
}));

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

const buildParams = (cfg: OpenClawConfig, accountId = "default") => ({
  bot: {
    api: {
      setMyCommands: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn().mockResolvedValue(undefined),
    },
    command: vi.fn(),
  } as unknown as Parameters<typeof registerTelegramNativeCommands>[0]["bot"],
  cfg,
  runtime: {} as unknown as RuntimeEnv,
  accountId,
  telegramCfg: {} as TelegramAccountConfig,
  allowFrom: [],
  groupAllowFrom: [],
  replyToMode: "off" as const,
  textLimit: 4096,
  useAccessGroups: false,
  nativeEnabled: true,
  nativeSkillsEnabled: true,
  nativeDisabledExplicit: false,
  resolveGroupPolicy: () => ({ allowlistEnabled: false, allowed: true }),
  resolveTelegramGroupConfig: () => ({
    groupConfig: undefined,
    topicConfig: undefined,
  }),
  shouldSkipUpdate: () => false,
  opts: { token: "token" },
});

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("registerTelegramNativeCommands — session metadata", () => {
  it("calls recordSessionMetaFromInbound after a native slash command", async () => {
    sessionMocks.recordSessionMetaFromInbound.mockReset().mockResolvedValue(undefined);
    sessionMocks.resolveStorePath.mockReset().mockReturnValue("/tmp/openclaw-sessions.json");

    const commandHandlers = new Map<string, (ctx: unknown) => Promise<void>>();
    const cfg: OpenClawConfig = {};

    registerTelegramNativeCommands({
      ...buildParams(cfg),
      allowFrom: ["*"],
      bot: {
        api: {
          setMyCommands: vi.fn().mockResolvedValue(undefined),
          sendMessage: vi.fn().mockResolvedValue(undefined),
        },
        command: vi.fn((name: string, cb: (ctx: unknown) => Promise<void>) => {
          commandHandlers.set(name, cb);
        }),
      } as unknown as Parameters<typeof registerTelegramNativeCommands>[0]["bot"],
    });

    const handler = commandHandlers.get("status");
    expect(handler).toBeTruthy();
    await handler?.({
      match: "",
      message: {
        message_id: 1,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 100, type: "private" },
        from: { id: 200, username: "bob" },
      },
    });

    expect(sessionMocks.recordSessionMetaFromInbound).toHaveBeenCalledTimes(1);
    const call = (
      sessionMocks.recordSessionMetaFromInbound.mock.calls as unknown as Array<
        [{ sessionKey?: string; ctx?: { OriginatingChannel?: string } }]
      >
    )[0]?.[0];
    expect(call?.ctx?.OriginatingChannel).toBe("telegram");
    expect(call?.sessionKey).toBeDefined();
  });

  it("awaits session metadata persistence before dispatch", async () => {
    const deferred = createDeferred<void>();
    sessionMocks.recordSessionMetaFromInbound.mockReset().mockReturnValue(deferred.promise);
    sessionMocks.resolveStorePath.mockReset().mockReturnValue("/tmp/openclaw-sessions.json");
    replyMocks.dispatchReplyWithBufferedBlockDispatcher.mockReset().mockResolvedValue(undefined);

    const commandHandlers = new Map<string, (ctx: unknown) => Promise<void>>();
    const cfg: OpenClawConfig = {};

    registerTelegramNativeCommands({
      ...buildParams(cfg),
      allowFrom: ["*"],
      bot: {
        api: {
          setMyCommands: vi.fn().mockResolvedValue(undefined),
          sendMessage: vi.fn().mockResolvedValue(undefined),
        },
        command: vi.fn((name: string, cb: (ctx: unknown) => Promise<void>) => {
          commandHandlers.set(name, cb);
        }),
      } as unknown as Parameters<typeof registerTelegramNativeCommands>[0]["bot"],
    });

    const handler = commandHandlers.get("status");
    expect(handler).toBeTruthy();

    const runPromise = handler?.({
      match: "",
      message: {
        message_id: 1,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 100, type: "private" },
        from: { id: 200, username: "bob" },
      },
    });

    await vi.waitFor(() => {
      expect(sessionMocks.recordSessionMetaFromInbound).toHaveBeenCalledTimes(1);
    });
    expect(replyMocks.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();

    deferred.resolve();
    await runPromise;

    expect(replyMocks.dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalledTimes(1);
  });
});
