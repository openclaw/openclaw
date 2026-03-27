import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import type { TelegramNetworkConfig } from "../../../config/types.telegram.js";

const resolveCommandSecretRefsViaGatewayMock = vi.hoisted(() => vi.fn());
const listTelegramAccountIdsMock = vi.hoisted(() => vi.fn());
const inspectTelegramAccountMock = vi.hoisted(() => vi.fn());
const lookupTelegramChatIdMock = vi.hoisted(() => vi.fn());
const resolveTelegramAccountMock = vi.hoisted(() => vi.fn());

vi.mock("../../../cli/command-secret-gateway.js", () => ({
  resolveCommandSecretRefsViaGateway: resolveCommandSecretRefsViaGatewayMock,
}));

vi.mock("../../../plugin-sdk/telegram.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../plugin-sdk/telegram.js")>();
  return {
    ...actual,
    listTelegramAccountIds: listTelegramAccountIdsMock,
    inspectTelegramAccount: inspectTelegramAccountMock,
    lookupTelegramChatId: lookupTelegramChatIdMock,
  };
});

vi.mock("../../../plugin-sdk/account-resolution.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../plugin-sdk/account-resolution.js")>();
  return {
    ...actual,
    resolveTelegramAccount: resolveTelegramAccountMock,
  };
});

import {
  collectTelegramAllowFromUsernameWarnings,
  collectTelegramEmptyAllowlistExtraWarnings,
  collectTelegramGroupPolicyWarnings,
  maybeRepairTelegramAllowFromUsernames,
  scanTelegramAllowFromUsernameEntries,
} from "./telegram.js";

describe("doctor telegram provider warnings", () => {
  beforeEach(() => {
    resolveCommandSecretRefsViaGatewayMock.mockReset().mockImplementation(async ({ config }) => ({
      resolvedConfig: config,
      diagnostics: [],
      targetStatesByPath: {},
      hadUnresolvedTargets: false,
    }));
    listTelegramAccountIdsMock.mockReset().mockImplementation((cfg: OpenClawConfig) => {
      const telegram = cfg.channels?.telegram;
      const accountIds = Object.keys(telegram?.accounts ?? {});
      return accountIds.length > 0 ? ["default", ...accountIds] : ["default"];
    });
    inspectTelegramAccountMock
      .mockReset()
      .mockImplementation((_params: { cfg: OpenClawConfig; accountId: string }) => ({
        enabled: true,
        tokenStatus: "configured",
      }));
    resolveTelegramAccountMock
      .mockReset()
      .mockImplementation((params: { cfg: OpenClawConfig; accountId?: string | null }) => {
        const accountId = params.accountId?.trim() || "default";
        const telegram = params.cfg.channels?.telegram ?? {};
        const account =
          accountId === "default"
            ? telegram
            : ((telegram.accounts?.[accountId] as Record<string, unknown> | undefined) ?? {});
        const token =
          typeof account.botToken === "string"
            ? account.botToken
            : typeof telegram.botToken === "string"
              ? telegram.botToken
              : "";
        return {
          accountId,
          token,
          tokenSource: token ? "config" : "none",
          config:
            account && typeof account === "object" && "network" in account
              ? { network: account.network as TelegramNetworkConfig | undefined }
              : {},
        };
      });
    lookupTelegramChatIdMock.mockReset();
  });

  it("shows first-run guidance when groups are not configured yet", () => {
    const warnings = collectTelegramGroupPolicyWarnings({
      account: {
        botToken: "123:abc",
        groupPolicy: "allowlist",
      },
      prefix: "channels.telegram",
      dmPolicy: "pairing",
    });

    expect(warnings).toEqual([
      expect.stringContaining("channels.telegram: Telegram is in first-time setup mode."),
    ]);
    expect(warnings[0]).toContain("DMs use pairing mode");
    expect(warnings[0]).toContain("channels.telegram.groups");
  });

  it("warns when configured groups still have no usable sender allowlist", () => {
    const warnings = collectTelegramGroupPolicyWarnings({
      account: {
        botToken: "123:abc",
        groupPolicy: "allowlist",
        groups: {
          ops: { allow: true },
        },
      },
      prefix: "channels.telegram",
    });

    expect(warnings).toEqual([
      expect.stringContaining(
        'channels.telegram.groupPolicy is "allowlist" but groupAllowFrom (and allowFrom) is empty',
      ),
    ]);
  });

  it("stays quiet when allowFrom can satisfy group allowlist mode", () => {
    const warnings = collectTelegramGroupPolicyWarnings({
      account: {
        botToken: "123:abc",
        groupPolicy: "allowlist",
        groups: {
          ops: { allow: true },
        },
      },
      prefix: "channels.telegram",
      effectiveAllowFrom: ["123456"],
    });

    expect(warnings).toEqual([]);
  });

  it("returns extra empty-allowlist warnings only for telegram allowlist groups", () => {
    const warnings = collectTelegramEmptyAllowlistExtraWarnings({
      account: {
        botToken: "123:abc",
        groupPolicy: "allowlist",
        groups: {
          ops: { allow: true },
        },
      },
      channelName: "telegram",
      prefix: "channels.telegram",
    });

    expect(warnings).toEqual([
      expect.stringContaining(
        'channels.telegram.groupPolicy is "allowlist" but groupAllowFrom (and allowFrom) is empty',
      ),
    ]);
    expect(
      collectTelegramEmptyAllowlistExtraWarnings({
        account: { groupPolicy: "allowlist" },
        channelName: "signal",
        prefix: "channels.signal",
      }),
    ).toEqual([]);
  });

  it("finds non-numeric telegram allowFrom username entries across account scopes", () => {
    const hits = scanTelegramAllowFromUsernameEntries({
      channels: {
        telegram: {
          allowFrom: ["@top"],
          groupAllowFrom: ["12345"],
          accounts: {
            work: {
              allowFrom: ["tg:@work"],
              groups: {
                "-100123": {
                  allowFrom: ["topic-user"],
                  topics: {
                    "99": {
                      allowFrom: ["777", "@topic-user"],
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    expect(hits).toEqual([
      { path: "channels.telegram.allowFrom", entry: "@top" },
      { path: "channels.telegram.accounts.work.allowFrom", entry: "tg:@work" },
      { path: "channels.telegram.accounts.work.groups.-100123.allowFrom", entry: "topic-user" },
      {
        path: "channels.telegram.accounts.work.groups.-100123.topics.99.allowFrom",
        entry: "@topic-user",
      },
    ]);
  });

  it("formats allowFrom username warnings", () => {
    const warnings = collectTelegramAllowFromUsernameWarnings({
      hits: [{ path: "channels.telegram.allowFrom", entry: "@top" }],
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(warnings).toEqual([
      expect.stringContaining("Telegram allowFrom contains 1 non-numeric entries"),
      expect.stringContaining('Run "openclaw doctor --fix"'),
    ]);
  });

  it("repairs Telegram @username allowFrom entries to numeric ids", async () => {
    lookupTelegramChatIdMock.mockImplementation(async ({ chatId }: { chatId: string }) => {
      switch (chatId.toLowerCase()) {
        case "@testuser":
          return "111";
        case "@groupuser":
          return "222";
        case "@topicuser":
          return "333";
        case "@accountuser":
          return "444";
        default:
          return null;
      }
    });

    const result = await maybeRepairTelegramAllowFromUsernames({
      channels: {
        telegram: {
          botToken: "123:abc",
          allowFrom: ["@testuser"],
          groupAllowFrom: ["groupUser"],
          groups: {
            "-100123": {
              allowFrom: ["tg:@topicUser"],
              topics: { "99": { allowFrom: ["@accountUser"] } },
            },
          },
          accounts: {
            alerts: { botToken: "456:def", allowFrom: ["@accountUser"] },
          },
        },
      },
    });

    const cfg = result.config as {
      channels: {
        telegram: {
          allowFrom?: string[];
          groupAllowFrom?: string[];
          groups: Record<
            string,
            { allowFrom: string[]; topics: Record<string, { allowFrom: string[] }> }
          >;
          accounts: Record<string, { allowFrom?: string[] }>;
        };
      };
    };
    expect(cfg.channels.telegram.allowFrom).toEqual(["111"]);
    expect(cfg.channels.telegram.groupAllowFrom).toEqual(["222"]);
    expect(cfg.channels.telegram.groups["-100123"].allowFrom).toEqual(["333"]);
    expect(cfg.channels.telegram.groups["-100123"].topics["99"].allowFrom).toEqual(["444"]);
    expect(cfg.channels.telegram.accounts.alerts.allowFrom).toEqual(["444"]);
  });

  it("sanitizes Telegram allowFrom repair change lines before logging", async () => {
    lookupTelegramChatIdMock.mockImplementation(async ({ chatId }: { chatId: string }) => {
      if (chatId === "@\u001b[31mtestuser") {
        return "12345";
      }
      return null;
    });

    const result = await maybeRepairTelegramAllowFromUsernames({
      channels: {
        telegram: {
          botToken: "123:abc",
          allowFrom: ["@\u001b[31mtestuser"],
        },
      },
    });

    expect(result.config.channels?.telegram?.allowFrom).toEqual(["12345"]);
    expect(result.changes.some((line) => line.includes("\u001b"))).toBe(false);
    expect(
      result.changes.some((line) =>
        line.includes("channels.telegram.allowFrom: resolved @testuser -> 12345"),
      ),
    ).toBe(true);
  });

  it("keeps Telegram allowFrom entries unchanged when configured credentials are unavailable", async () => {
    inspectTelegramAccountMock.mockImplementation(() => ({
      enabled: true,
      tokenStatus: "configured_unavailable",
    }));
    resolveTelegramAccountMock.mockImplementation(() => ({
      accountId: "default",
      token: "",
      tokenSource: "none",
      config: {},
    }));

    const result = await maybeRepairTelegramAllowFromUsernames({
      secrets: {
        providers: {
          default: { source: "env" },
        },
      },
      channels: {
        telegram: {
          botToken: { source: "env", provider: "default", id: "TELEGRAM_BOT_TOKEN" },
          allowFrom: ["@testuser"],
        },
      },
    } as unknown as OpenClawConfig);

    const cfg = result.config as {
      channels?: {
        telegram?: {
          allowFrom?: string[];
        };
      };
    };
    expect(cfg.channels?.telegram?.allowFrom).toEqual(["@testuser"]);
    expect(
      result.changes.some((line) =>
        line.includes("configured Telegram bot credentials are unavailable"),
      ),
    ).toBe(true);
    expect(lookupTelegramChatIdMock).not.toHaveBeenCalled();
  });

  it("uses network settings for Telegram allowFrom repair but ignores apiRoot and proxy", async () => {
    resolveCommandSecretRefsViaGatewayMock.mockResolvedValue({
      resolvedConfig: {
        channels: {
          telegram: {
            accounts: {
              work: {
                botToken: "tok",
                apiRoot: "https://custom.telegram.test/root/",
                proxy: "http://127.0.0.1:8888",
                network: { autoSelectFamily: false, dnsResultOrder: "ipv4first" },
                allowFrom: ["@testuser"],
              },
            },
          },
        },
      },
      diagnostics: [],
      targetStatesByPath: {},
      hadUnresolvedTargets: false,
    });
    listTelegramAccountIdsMock.mockImplementation(() => ["work"]);
    resolveTelegramAccountMock.mockImplementation(() => ({
      accountId: "work",
      token: "tok",
      tokenSource: "config",
      config: {
        network: { autoSelectFamily: false, dnsResultOrder: "ipv4first" },
      },
    }));
    lookupTelegramChatIdMock.mockResolvedValue("12345");

    const result = await maybeRepairTelegramAllowFromUsernames({
      channels: {
        telegram: {
          accounts: {
            work: {
              botToken: "tok",
              allowFrom: ["@testuser"],
            },
          },
        },
      },
    });

    const cfg = result.config as {
      channels?: {
        telegram?: {
          accounts?: Record<string, { allowFrom?: string[] }>;
        };
      };
    };
    expect(cfg.channels?.telegram?.accounts?.work?.allowFrom).toEqual(["12345"]);
    expect(lookupTelegramChatIdMock).toHaveBeenCalledWith({
      token: "tok",
      chatId: "@testuser",
      signal: expect.any(AbortSignal),
      network: { autoSelectFamily: false, dnsResultOrder: "ipv4first" },
    });
  });
});
