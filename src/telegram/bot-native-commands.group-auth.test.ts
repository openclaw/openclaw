import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { ChannelGroupPolicy } from "../config/group-policy.js";
import type { TelegramAccountConfig } from "../config/types.js";
import type { RuntimeEnv } from "../runtime.js";
import { registerTelegramNativeCommands } from "./bot-native-commands.js";

const getPluginCommandSpecs = vi.hoisted(() => vi.fn(() => []));
const matchPluginCommand = vi.hoisted(() => vi.fn(() => null));
const executePluginCommand = vi.hoisted(() => vi.fn(async () => ({ text: "ok" })));

vi.mock("../plugins/commands.js", () => ({
  getPluginCommandSpecs,
  matchPluginCommand,
  executePluginCommand,
}));

const deliverReplies = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("./bot/delivery.js", () => ({ deliverReplies }));

vi.mock("../pairing/pairing-store.js", () => ({
  readChannelAllowFromStore: vi.fn(async () => []),
}));

describe("native command auth in groups", () => {
  function setup(params: {
    cfg?: OpenClawConfig;
    telegramCfg?: TelegramAccountConfig;
    allowFrom?: string[];
    groupAllowFrom?: string[];
    useAccessGroups?: boolean;
    groupConfig?: Record<string, unknown>;
    resolveGroupPolicy?: () => ChannelGroupPolicy;
  }) {
    const handlers: Record<string, (ctx: unknown) => Promise<void>> = {};
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const bot = {
      api: {
        setMyCommands: vi.fn().mockResolvedValue(undefined),
        sendMessage,
      },
      command: (name: string, handler: (ctx: unknown) => Promise<void>) => {
        handlers[name] = handler;
      },
    } as const;

    registerTelegramNativeCommands({
      bot: bot as unknown as Parameters<typeof registerTelegramNativeCommands>[0]["bot"],
      cfg: params.cfg ?? ({} as OpenClawConfig),
      runtime: {} as unknown as RuntimeEnv,
      accountId: "default",
      telegramCfg: params.telegramCfg ?? ({} as TelegramAccountConfig),
      allowFrom: params.allowFrom ?? [],
      groupAllowFrom: params.groupAllowFrom ?? [],
      replyToMode: "off",
      textLimit: 4000,
      useAccessGroups: params.useAccessGroups ?? false,
      nativeEnabled: true,
      nativeSkillsEnabled: false,
      nativeDisabledExplicit: false,
      resolveGroupPolicy:
        params.resolveGroupPolicy ??
        (() =>
          ({
            allowlistEnabled: false,
            allowed: true,
          }) as ChannelGroupPolicy),
      resolveTelegramGroupConfig: () => ({
        groupConfig: params.groupConfig as undefined,
        topicConfig: undefined,
      }),
      shouldSkipUpdate: () => false,
      opts: { token: "token" },
    });

    return { handlers, sendMessage };
  }

  it("authorizes native commands in groups when sender is in groupAllowFrom", async () => {
    const { handlers, sendMessage } = setup({
      groupAllowFrom: ["12345"],
      useAccessGroups: true,
      // no allowFrom — sender is NOT in DM allowlist
    });

    const ctx = {
      message: {
        chat: { id: -100999, type: "supergroup", is_forum: true },
        from: { id: 12345, username: "testuser" },
        message_thread_id: 42,
        message_id: 1,
        date: 1700000000,
      },
      match: "",
    };

    await handlers.status?.(ctx);

    // should NOT send "not authorized" rejection
    const notAuthCalls = sendMessage.mock.calls.filter(
      (call) => typeof call[1] === "string" && call[1].includes("not authorized"),
    );
    expect(notAuthCalls).toHaveLength(0);
  });

  it("authorizes native commands in groups from commands.allowFrom.telegram", async () => {
    const { handlers, sendMessage } = setup({
      cfg: {
        commands: {
          allowFrom: {
            telegram: ["12345"],
          },
        },
      } as OpenClawConfig,
      allowFrom: ["99999"],
      groupAllowFrom: ["99999"],
      useAccessGroups: true,
    });

    const ctx = {
      message: {
        chat: { id: -100999, type: "supergroup", is_forum: true },
        from: { id: 12345, username: "testuser" },
        message_thread_id: 42,
        message_id: 1,
        date: 1700000000,
      },
      match: "",
    };

    await handlers.status?.(ctx);

    const notAuthCalls = sendMessage.mock.calls.filter(
      (call) => typeof call[1] === "string" && call[1].includes("not authorized"),
    );
    expect(notAuthCalls).toHaveLength(0);
  });

  it("uses commands.allowFrom.telegram as the sole auth source when configured", async () => {
    const { handlers, sendMessage } = setup({
      cfg: {
        commands: {
          allowFrom: {
            telegram: ["99999"],
          },
        },
      } as OpenClawConfig,
      groupAllowFrom: ["12345"],
      useAccessGroups: true,
    });

    const ctx = {
      message: {
        chat: { id: -100999, type: "supergroup", is_forum: true },
        from: { id: 12345, username: "testuser" },
        message_thread_id: 42,
        message_id: 1,
        date: 1700000000,
      },
      match: "",
    };

    await handlers.status?.(ctx);

    expect(sendMessage).toHaveBeenCalledWith(
      -100999,
      "You are not authorized to use this command.",
      expect.objectContaining({ message_thread_id: 42 }),
    );
  });

  it("keeps groupPolicy disabled enforced when commands.allowFrom is configured", async () => {
    const { handlers, sendMessage } = setup({
      cfg: {
        commands: {
          allowFrom: {
            telegram: ["12345"],
          },
        },
      } as OpenClawConfig,
      telegramCfg: {
        groupPolicy: "disabled",
      } as TelegramAccountConfig,
      useAccessGroups: true,
      resolveGroupPolicy: () =>
        ({
          allowlistEnabled: false,
          allowed: false,
        }) as ChannelGroupPolicy,
    });

    const ctx = {
      message: {
        chat: { id: -100999, type: "supergroup", is_forum: true },
        from: { id: 12345, username: "testuser" },
        message_thread_id: 42,
        message_id: 1,
        date: 1700000000,
      },
      match: "",
    };

    await handlers.status?.(ctx);

    expect(sendMessage).toHaveBeenCalledWith(
      -100999,
      "Telegram group commands are disabled.",
      expect.objectContaining({ message_thread_id: 42 }),
    );
  });

  it("keeps group chat allowlists enforced when commands.allowFrom is configured", async () => {
    const { handlers, sendMessage } = setup({
      cfg: {
        commands: {
          allowFrom: {
            telegram: ["12345"],
          },
        },
      } as OpenClawConfig,
      useAccessGroups: true,
      resolveGroupPolicy: () =>
        ({
          allowlistEnabled: true,
          allowed: false,
        }) as ChannelGroupPolicy,
    });

    const ctx = {
      message: {
        chat: { id: -100999, type: "supergroup", is_forum: true },
        from: { id: 12345, username: "testuser" },
        message_thread_id: 42,
        message_id: 1,
        date: 1700000000,
      },
      match: "",
    };

    await handlers.status?.(ctx);

    expect(sendMessage).toHaveBeenCalledWith(
      -100999,
      "This group is not allowed.",
      expect.objectContaining({ message_thread_id: 42 }),
    );
  });

  it("rejects native commands in groups when sender is in neither allowlist", async () => {
    const { handlers, sendMessage } = setup({
      allowFrom: ["99999"],
      groupAllowFrom: ["99999"],
      useAccessGroups: true,
    });

    const ctx = {
      message: {
        chat: { id: -100999, type: "supergroup", is_forum: true },
        from: { id: 12345, username: "intruder" },
        message_thread_id: 42,
        message_id: 1,
        date: 1700000000,
      },
      match: "",
    };

    await handlers.status?.(ctx);

    const notAuthCalls = sendMessage.mock.calls.filter(
      (call) => typeof call[1] === "string" && call[1].includes("not authorized"),
    );
    expect(notAuthCalls.length).toBeGreaterThan(0);
  });

  it("replies in the originating forum topic when auth is rejected", async () => {
    const { handlers, sendMessage } = setup({
      allowFrom: ["99999"],
      groupAllowFrom: ["99999"],
      useAccessGroups: true,
    });

    const ctx = {
      message: {
        chat: { id: -100999, type: "supergroup", is_forum: true },
        from: { id: 12345, username: "intruder" },
        message_thread_id: 42,
        message_id: 1,
        date: 1700000000,
      },
      match: "",
    };

    await handlers.status?.(ctx);

    expect(sendMessage).toHaveBeenCalledWith(
      -100999,
      "You are not authorized to use this command.",
      expect.objectContaining({ message_thread_id: 42 }),
    );
  });
});
