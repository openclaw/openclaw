import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { TelegramAccountConfig } from "../config/types.js";
import type { RuntimeEnv } from "../runtime.js";
import { registerTelegramNativeCommands } from "./bot-native-commands.js";

const { listSkillCommandsForAgents } = vi.hoisted(() => ({
  listSkillCommandsForAgents: vi.fn(() => []),
}));

vi.mock("../auto-reply/skill-commands.js", () => ({
  listSkillCommandsForAgents,
}));

describe("registerTelegramNativeCommands", () => {
  beforeEach(() => {
    listSkillCommandsForAgents.mockReset();
  });

  const buildParams = (cfg: OpenClawConfig, accountId = "default") => {
    const bot = {
      api: {
        setMyCommands: vi.fn().mockResolvedValue(undefined),
        sendMessage: vi.fn().mockResolvedValue(undefined),
      },
      command: vi.fn(),
    } as unknown as Parameters<typeof registerTelegramNativeCommands>[0]["bot"];

    return {
      bot,
      cfg,
      runtime: {} as RuntimeEnv,
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
    };
  };

  it("scopes skill commands when account binding exists", () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: "main", default: true }, { id: "butler" }],
      },
      bindings: [
        {
          agentId: "butler",
          match: { channel: "telegram", accountId: "bot-a" },
        },
      ],
    };

    registerTelegramNativeCommands(buildParams(cfg, "bot-a"));

    expect(listSkillCommandsForAgents).toHaveBeenCalledWith({
      cfg,
      agentIds: ["butler"],
    });
  });

  it("keeps skill commands unscoped without a matching binding", () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: "main", default: true }, { id: "butler" }],
      },
    };

    registerTelegramNativeCommands(buildParams(cfg, "bot-a"));

    expect(listSkillCommandsForAgents).toHaveBeenCalledWith({ cfg });
  });

  it("registers bot commands for all_group_chats scope as well as default", () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: "main", default: true }],
      },
    };

    const params = buildParams(cfg, "bot-a");
    registerTelegramNativeCommands(params);

    const setMyCommands = (params.bot as any).api.setMyCommands as ReturnType<typeof vi.fn>;
    // Called at least twice: default scope + all_group_chats scope.
    expect(setMyCommands).toHaveBeenCalled();
    expect(
      setMyCommands.mock.calls.some((call) => call[1]?.scope?.type === "all_group_chats"),
    ).toBe(true);
  });
});
