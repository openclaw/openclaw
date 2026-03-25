import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setDefaultChannelPluginRegistryForTests } from "./channel-test-helpers.js";
import { configMocks, offsetMocks } from "./channels.mock-harness.js";
import { baseConfigSnapshot, createTestRuntime } from "./test-runtime-config-helpers.js";

const authMocks = vi.hoisted(() => ({
  loadAuthProfileStore: vi.fn(),
}));

vi.mock("../agents/auth-profiles.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agents/auth-profiles.js")>();
  return {
    ...actual,
    loadAuthProfileStore: authMocks.loadAuthProfileStore,
  };
});

import {
  channelsAddCommand,
  channelsListCommand,
  channelsRemoveCommand,
  formatGatewayChannelsStatusLines,
} from "./channels.js";

const runtime = createTestRuntime();
let clackPrompterModule: typeof import("../wizard/clack-prompter.js");

function formatChannelStatusJoined(channelAccounts: Record<string, unknown>) {
  return formatGatewayChannelsStatusLines({ channelAccounts }).join("\n");
}

describe("channels command", () => {
  beforeAll(async () => {
    clackPrompterModule = await import("../wizard/clack-prompter.js");
  });

  beforeEach(() => {
    configMocks.readConfigFileSnapshot.mockClear();
    configMocks.writeConfigFile.mockClear();
    authMocks.loadAuthProfileStore.mockClear();
    offsetMocks.deleteTelegramUpdateOffset.mockClear();
    runtime.log.mockClear();
    runtime.error.mockClear();
    runtime.exit.mockClear();
    authMocks.loadAuthProfileStore.mockReturnValue({
      version: 1,
      profiles: {},
    });
    setDefaultChannelPluginRegistryForTests();
  });

  function getWrittenConfig<T>(): T {
    expect(configMocks.writeConfigFile).toHaveBeenCalledTimes(1);
    return configMocks.writeConfigFile.mock.calls[0]?.[0] as T;
  }

  async function runRemoveWithConfirm(
    args: Parameters<typeof channelsRemoveCommand>[0],
  ): Promise<void> {
    const prompt = { confirm: vi.fn().mockResolvedValue(true) };
    const promptSpy = vi
      .spyOn(clackPrompterModule, "createClackPrompter")
      .mockReturnValue(prompt as never);
    try {
      await channelsRemoveCommand(args, runtime, { hasFlags: true });
    } finally {
      promptSpy.mockRestore();
    }
  }

  async function addTelegramAccount(account: string, token: string): Promise<void> {
    await channelsAddCommand({ channel: "telegram", account, token }, runtime, {
      hasFlags: true,
    });
  }

  async function addAlertsTelegramAccount(token: string): Promise<{
    channels?: {
      telegram?: {
        enabled?: boolean;
        accounts?: Record<string, { botToken?: string }>;
      };
    };
  }> {
    await addTelegramAccount("alerts", token);
    return getWrittenConfig<{
      channels?: {
        telegram?: {
          enabled?: boolean;
          accounts?: Record<string, { botToken?: string }>;
        };
      };
    }>();
  }

  it("adds a non-default telegram account", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({ ...baseConfigSnapshot });
    const next = await addAlertsTelegramAccount("123:abc");
    expect(next.channels?.telegram?.enabled).toBe(true);
    expect(next.channels?.telegram?.accounts?.alerts?.botToken).toBe("123:abc");
  });

  it("moves single-account telegram config into accounts.default when adding non-default", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {
        channels: {
          telegram: {
            enabled: true,
            botToken: "legacy-token",
            dmPolicy: "allowlist",
            allowFrom: ["111"],
            groupPolicy: "allowlist",
            streaming: "partial",
          },
        },
      },
    });

    await addTelegramAccount("alerts", "alerts-token");

    const next = getWrittenConfig<{
      channels?: {
        telegram?: {
          botToken?: string;
          dmPolicy?: string;
          allowFrom?: string[];
          groupPolicy?: string;
          streaming?: string;
          accounts?: Record<
            string,
            {
              botToken?: string;
              dmPolicy?: string;
              allowFrom?: string[];
              groupPolicy?: string;
              streaming?: string;
            }
          >;
        };
      };
    }>();
    expect(next.channels?.telegram?.accounts?.default).toEqual({
      botToken: "legacy-token",
      dmPolicy: "allowlist",
      allowFrom: ["111"],
      groupPolicy: "allowlist",
      streaming: "partial",
    });
    expect(next.channels?.telegram?.botToken).toBeUndefined();
    expect(next.channels?.telegram?.dmPolicy).toBeUndefined();
    expect(next.channels?.telegram?.allowFrom).toBeUndefined();
    expect(next.channels?.telegram?.groupPolicy).toBeUndefined();
    expect(next.channels?.telegram?.streaming).toBeUndefined();
    expect(next.channels?.telegram?.accounts?.alerts?.botToken).toBe("alerts-token");
  });

  it("seeds accounts.default for env-only single-account telegram config when adding non-default", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {
        channels: {
          telegram: {
            enabled: true,
          },
        },
      },
    });

    const next = await addAlertsTelegramAccount("alerts-token");
    expect(next.channels?.telegram?.enabled).toBe(true);
    expect(next.channels?.telegram?.accounts?.default).toEqual({});
    expect(next.channels?.telegram?.accounts?.alerts?.botToken).toBe("alerts-token");
  });

  it("adds a default slack account with tokens", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({ ...baseConfigSnapshot });
    await channelsAddCommand(
      {
        channel: "slack",
        account: "default",
        botToken: "xoxb-1",
        appToken: "xapp-1",
      },
      runtime,
      { hasFlags: true },
    );

    const next = getWrittenConfig<{
      channels?: {
        slack?: { enabled?: boolean; botToken?: string; appToken?: string };
      };
    }>();
    expect(next.channels?.slack?.enabled).toBe(true);
    expect(next.channels?.slack?.botToken).toBe("xoxb-1");
    expect(next.channels?.slack?.appToken).toBe("xapp-1");
  });

  it("deletes a non-default discord account", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {
        channels: {
          discord: {
            accounts: {
              default: { token: "d0" },
              work: { token: "d1" },
            },
          },
        },
      },
    });

    await channelsRemoveCommand({ channel: "discord", account: "work", delete: true }, runtime, {
      hasFlags: true,
    });

    const next = getWrittenConfig<{
      channels?: {
        discord?: { accounts?: Record<string, { token?: string }> };
      };
    }>();
    expect(next.channels?.discord?.accounts?.work).toBeUndefined();
    expect(next.channels?.discord?.accounts?.default?.token).toBe("d0");
  });

  it("adds a named WhatsApp account", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({ ...baseConfigSnapshot });
    await channelsAddCommand(
      { channel: "whatsapp", account: "family", name: "Family Phone" },
      runtime,
      { hasFlags: true },
    );

    const next = getWrittenConfig<{
      channels?: {
        whatsapp?: { accounts?: Record<string, { name?: string }> };
      };
    }>();
    expect(next.channels?.whatsapp?.accounts?.family?.name).toBe("Family Phone");
  });

  it("adds a second signal account with a distinct name", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {
        channels: {
          signal: {
            accounts: {
              default: { account: "+15555550111", name: "Primary" },
            },
          },
        },
      },
    });

    await channelsAddCommand(
      {
        channel: "signal",
        account: "lab",
        name: "Lab",
        signalNumber: "+15555550123",
      },
      runtime,
      { hasFlags: true },
    );

    const next = getWrittenConfig<{
      channels?: {
        signal?: {
          accounts?: Record<string, { account?: string; name?: string }>;
        };
      };
    }>();
    expect(next.channels?.signal?.accounts?.lab?.account).toBe("+15555550123");
    expect(next.channels?.signal?.accounts?.lab?.name).toBe("Lab");
    expect(next.channels?.signal?.accounts?.default?.name).toBe("Primary");
  });

  it("disables a default provider account when remove has no delete flag", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {
        channels: { discord: { token: "d0", enabled: true } },
      },
    });

    await runRemoveWithConfirm({ channel: "discord", account: "default" });

    const next = getWrittenConfig<{
      channels?: { discord?: { enabled?: boolean } };
    }>();
    expect(next.channels?.discord?.enabled).toBe(false);
  });

  it("includes external auth profiles in JSON output", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {},
    });
    authMocks.loadAuthProfileStore.mockReturnValue({
      version: 1,
      profiles: {
        "anthropic:default": {
          type: "oauth",
          provider: "anthropic",
          access: "token",
          refresh: "refresh",
          expires: 0,
          created: 0,
        },
        "openai-codex:default": {
          type: "oauth",
          provider: "openai",
          access: "token",
          refresh: "refresh",
          expires: 0,
          created: 0,
        },
      },
    });

    await channelsListCommand({ json: true, usage: false }, runtime);
    const payload = JSON.parse(runtime.log.mock.calls[0]?.[0] as string) as {
      auth?: Array<{ id: string }>;
    };
    const ids = payload.auth?.map((entry) => entry.id) ?? [];
    expect(ids).toContain("anthropic:default");
    expect(ids).toContain("openai-codex:default");
  });

  it("stores default account names in accounts when multiple accounts exist", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {
        channels: {
          telegram: {
            name: "Legacy Name",
            accounts: {
              work: { botToken: "t0" },
            },
          },
        },
      },
    });

    await channelsAddCommand(
      {
        channel: "telegram",
        account: "default",
        token: "123:abc",
        name: "Primary Bot",
      },
      runtime,
      { hasFlags: true },
    );

    const next = getWrittenConfig<{
      channels?: {
        telegram?: {
          name?: string;
          accounts?: Record<string, { botToken?: string; name?: string }>;
        };
      };
    }>();
    expect(next.channels?.telegram?.name).toBeUndefined();
    expect(next.channels?.telegram?.accounts?.default?.name).toBe("Primary Bot");
  });

  it("migrates base names when adding non-default accounts", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {
        channels: {
          discord: {
            name: "Primary Bot",
            token: "d0",
          },
        },
      },
    });

    await channelsAddCommand({ channel: "discord", account: "work", token: "d1" }, runtime, {
      hasFlags: true,
    });

    const next = getWrittenConfig<{
      channels?: {
        discord?: {
          name?: string;
          accounts?: Record<string, { name?: string; token?: string }>;
        };
      };
    }>();
    expect(next.channels?.discord?.name).toBeUndefined();
    expect(next.channels?.discord?.accounts?.default?.name).toBe("Primary Bot");
    expect(next.channels?.discord?.accounts?.work?.token).toBe("d1");
  });

  it("formats gateway channel status lines in registry order", () => {
    const lines = formatGatewayChannelsStatusLines({
      channelAccounts: {
        telegram: [{ accountId: "default", configured: true }],
        whatsapp: [{ accountId: "default", linked: true }],
      },
    });

    const telegramIndex = lines.findIndex((line) => line.includes("Telegram default"));
    const whatsappIndex = lines.findIndex((line) => line.includes("WhatsApp default"));
    expect(telegramIndex).toBeGreaterThan(-1);
    expect(whatsappIndex).toBeGreaterThan(-1);
    expect(telegramIndex).toBeLessThan(whatsappIndex);
  });

  it.each([
    {
      name: "surfaces Discord privileged intent issues in channels status output",
      channelAccounts: {
        discord: [
          {
            accountId: "default",
            enabled: true,
            configured: true,
            application: { intents: { messageContent: "disabled" } },
          },
        ],
      },
      patterns: [
        /Warnings:/,
        /Message Content Intent is disabled/i,
        /Run: (?:openclaw|openclaw)( --profile isolated)? doctor/,
      ],
    },
    {
      name: "surfaces Discord permission audit issues in channels status output",
      channelAccounts: {
        discord: [
          {
            accountId: "default",
            enabled: true,
            configured: true,
            audit: {
              unresolvedChannels: 1,
              channels: [
                {
                  channelId: "111",
                  ok: false,
                  missing: ["ViewChannel", "SendMessages"],
                },
              ],
            },
          },
        ],
      },
      patterns: [/Warnings:/, /permission audit/i, /Channel 111/i],
    },
    {
      name: "surfaces Telegram privacy-mode hints when allowUnmentionedGroups is enabled",
      channelAccounts: {
        telegram: [
          {
            accountId: "default",
            enabled: true,
            configured: true,
            allowUnmentionedGroups: true,
          },
        ],
      },
      patterns: [/Warnings:/, /Telegram Bot API privacy mode/i],
    },
  ])("$name", ({ channelAccounts, patterns }) => {
    const joined = formatChannelStatusJoined(channelAccounts);
    for (const pattern of patterns) {
      expect(joined).toMatch(pattern);
    }
  });

  it("includes Telegram bot username from probe data", () => {
    const joined = formatChannelStatusJoined({
      telegram: [
        {
          accountId: "default",
          enabled: true,
          configured: true,
          probe: { ok: true, bot: { username: "openclaw_bot" } },
        },
      ],
    });
    expect(joined).toMatch(/bot:@openclaw_bot/);
  });

  it("surfaces Telegram group membership audit issues in channels status output", () => {
    const joined = formatChannelStatusJoined({
      telegram: [
        {
          accountId: "default",
          enabled: true,
          configured: true,
          audit: {
            hasWildcardUnmentionedGroups: true,
            unresolvedGroups: 1,
            groups: [
              {
                chatId: "-1001",
                ok: false,
                status: "left",
                error: "not in group",
              },
            ],
          },
        },
      ],
    });
    expect(joined).toMatch(/Warnings:/);
    expect(joined).toMatch(/membership probing is not possible/i);
    expect(joined).toMatch(/Group -1001/i);
  });

  it("surfaces WhatsApp auth/runtime hints when unlinked or disconnected", () => {
    const unlinked = formatGatewayChannelsStatusLines({
      channelAccounts: {
        whatsapp: [{ accountId: "default", enabled: true, linked: false }],
      },
    });
    expect(unlinked.join("\n")).toMatch(/WhatsApp/i);
    expect(unlinked.join("\n")).toMatch(/Not linked/i);

    const disconnected = formatGatewayChannelsStatusLines({
      channelAccounts: {
        whatsapp: [
          {
            accountId: "default",
            enabled: true,
            linked: true,
            running: true,
            connected: false,
            reconnectAttempts: 5,
            lastError: "connection closed",
          },
        ],
      },
    });
    expect(disconnected.join("\n")).toMatch(/disconnected/i);
  });

  it("cleans up telegram update offset when deleting a telegram account", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {
        channels: {
          telegram: { botToken: "123:abc", enabled: true },
        },
      },
    });

    await channelsRemoveCommand(
      { channel: "telegram", account: "default", delete: true },
      runtime,
      {
        hasFlags: true,
      },
    );

    expect(offsetMocks.deleteTelegramUpdateOffset).toHaveBeenCalledWith({ accountId: "default" });
  });

  it("does not clean up offset when deleting a non-telegram channel", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {
        channels: {
          discord: {
            accounts: {
              default: { token: "d0" },
            },
          },
        },
      },
    });

    await channelsRemoveCommand({ channel: "discord", account: "default", delete: true }, runtime, {
      hasFlags: true,
    });

    expect(offsetMocks.deleteTelegramUpdateOffset).not.toHaveBeenCalled();
  });

  it("does not clean up offset when disabling (not deleting) a telegram account", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {
        channels: {
          telegram: { botToken: "123:abc", enabled: true },
        },
      },
    });

    await runRemoveWithConfirm({ channel: "telegram", account: "default" });

    expect(offsetMocks.deleteTelegramUpdateOffset).not.toHaveBeenCalled();
  });
});
