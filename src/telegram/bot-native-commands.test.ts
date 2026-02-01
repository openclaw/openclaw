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

  const buildParams = (cfg: OpenClawConfig, accountId = "default") => ({
    bot: {
      api: {
        setMyCommands: vi.fn().mockResolvedValue(undefined),
        sendMessage: vi.fn().mockResolvedValue(undefined),
      },
      command: vi.fn(),
    } as unknown as Parameters<typeof registerTelegramNativeCommands>[0]["bot"],
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
  });

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
});
