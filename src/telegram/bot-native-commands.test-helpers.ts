import { vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { ChannelGroupPolicy } from "../config/group-policy.js";
import type { TelegramAccountConfig } from "../config/types.js";
import type { RuntimeEnv } from "../runtime.js";
import { registerTelegramNativeCommands } from "./bot-native-commands.js";

const pluginCommandMocks = vi.hoisted(() => ({
  getPluginCommandSpecs: vi.fn(() => []),
  matchPluginCommand: vi.fn(() => null),
  executePluginCommand: vi.fn(async () => ({ text: "ok" })),
}));
export const getPluginCommandSpecs = pluginCommandMocks.getPluginCommandSpecs;
export const matchPluginCommand = pluginCommandMocks.matchPluginCommand;
export const executePluginCommand = pluginCommandMocks.executePluginCommand;

vi.mock("../plugins/commands.js", () => ({
  getPluginCommandSpecs: pluginCommandMocks.getPluginCommandSpecs,
  matchPluginCommand: pluginCommandMocks.matchPluginCommand,
  executePluginCommand: pluginCommandMocks.executePluginCommand,
}));

const deliveryMocks = vi.hoisted(() => ({
  deliverReplies: vi.fn(async () => {}),
}));
export const deliverReplies = deliveryMocks.deliverReplies;
vi.mock("./bot/delivery.js", () => ({ deliverReplies: deliveryMocks.deliverReplies }));
vi.mock("../pairing/pairing-store.js", () => ({
  readChannelAllowFromStore: vi.fn(async () => []),
}));

export function createNativeCommandsHarness(params?: {
  cfg?: OpenClawConfig;
  runtime?: RuntimeEnv;
  telegramCfg?: TelegramAccountConfig;
  allowFrom?: string[];
  groupAllowFrom?: string[];
  useAccessGroups?: boolean;
  nativeEnabled?: boolean;
  groupConfig?: Record<string, unknown>;
  resolveGroupPolicy?: () => ChannelGroupPolicy;
}) {
  const handlers: Record<string, (ctx: unknown) => Promise<void>> = {};
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  const setMyCommands = vi.fn().mockResolvedValue(undefined);
  const log = vi.fn();
  const bot = {
    api: {
      setMyCommands,
      sendMessage,
    },
    command: (name: string, handler: (ctx: unknown) => Promise<void>) => {
      handlers[name] = handler;
    },
  } as const;

  registerTelegramNativeCommands({
    bot: bot as unknown as Parameters<typeof registerTelegramNativeCommands>[0]["bot"],
    cfg: params?.cfg ?? ({} as OpenClawConfig),
    runtime: params?.runtime ?? ({ log } as unknown as RuntimeEnv),
    accountId: "default",
    telegramCfg: params?.telegramCfg ?? ({} as TelegramAccountConfig),
    allowFrom: params?.allowFrom ?? [],
    groupAllowFrom: params?.groupAllowFrom ?? [],
    replyToMode: "off",
    textLimit: 4000,
    useAccessGroups: params?.useAccessGroups ?? false,
    nativeEnabled: params?.nativeEnabled ?? true,
    nativeSkillsEnabled: false,
    nativeDisabledExplicit: false,
    resolveGroupPolicy:
      params?.resolveGroupPolicy ??
      (() =>
        ({
          allowlistEnabled: false,
          allowed: true,
        }) as ChannelGroupPolicy),
    resolveTelegramGroupConfig: () => ({
      groupConfig: params?.groupConfig as undefined,
      topicConfig: undefined,
    }),
    shouldSkipUpdate: () => false,
    opts: { token: "token" },
  });

  return { handlers, sendMessage, setMyCommands, log, bot };
}

export function createTelegramGroupCommandContext(params?: {
  senderId?: number;
  username?: string;
  threadId?: number;
}) {
  return {
    message: {
      chat: { id: -100999, type: "supergroup", is_forum: true },
      from: {
        id: params?.senderId ?? 12345,
        username: params?.username ?? "testuser",
      },
      message_thread_id: params?.threadId ?? 42,
      message_id: 1,
      date: 1700000000,
    },
    match: "",
  };
}

export function findNotAuthorizedCalls(sendMessage: ReturnType<typeof vi.fn>) {
  return sendMessage.mock.calls.filter(
    (call) => typeof call[1] === "string" && call[1].includes("not authorized"),
  );
}
