import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";

const resolveCommandSecretRefsViaGatewayMock = vi.hoisted(() => vi.fn());
const listTelegramAccountIdsMock = vi.hoisted(() => vi.fn());
const inspectTelegramAccountMock = vi.hoisted(() => vi.fn());
const telegramResolverMock = vi.hoisted(() => vi.fn());
const getChannelPluginMock = vi.hoisted(() => vi.fn());

vi.mock("../../../cli/command-secret-gateway.js", () => ({
  resolveCommandSecretRefsViaGateway: resolveCommandSecretRefsViaGatewayMock,
}));

vi.mock("../../../channels/read-only-account-inspect.telegram.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../channels/read-only-account-inspect.telegram.js")
    >();
  return {
    ...actual,
    listTelegramAccountIds: listTelegramAccountIdsMock,
    inspectTelegramAccount: inspectTelegramAccountMock,
  };
});

vi.mock("../../../channels/plugins/registry.js", () => ({
  getChannelPlugin: getChannelPluginMock,
}));

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
        token: "tok",
        tokenSource: "config",
        tokenStatus: "configured",
      }));
    telegramResolverMock.mockReset();
    getChannelPluginMock.mockReset().mockReturnValue({
      resolver: {
        resolveTargets: telegramResolverMock,
      },
    });
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
    telegramResolverMock.mockImplementation(async ({ inputs }: { inputs: string[] }) => {
      switch (inputs[0]?.toLowerCase()) {
        case "@testuser":
          return [{ input: inputs[0], resolved: true, id: "111" }];
        case "@groupuser":
          return [{ input: inputs[0], resolved: true, id: "222" }];
        case "@topicuser":
          return [{ input: inputs[0], resolved: true, id: "333" }];
        case "@accountuser":
          return [{ input: inputs[0], resolved: true, id: "444" }];
        default:
          return [{ input: inputs[0], resolved: false }];
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
    telegramResolverMock.mockImplementation(async ({ inputs }: { inputs: string[] }) => {
      if (inputs[0] === "@\u001b[31mtestuser") {
        return [{ input: inputs[0], resolved: true, id: "12345" }];
      }
      return [{ input: inputs[0], resolved: false }];
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
      token: "",
      tokenSource: "env",
      tokenStatus: "configured_unavailable",
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
    expect(telegramResolverMock).not.toHaveBeenCalled();
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
    telegramResolverMock.mockResolvedValue([{ input: "@testuser", resolved: true, id: "12345" }]);

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
    expect(telegramResolverMock).toHaveBeenCalledWith({
      cfg: expect.any(Object),
      accountId: "work",
      inputs: ["@testuser"],
      kind: "user",
      runtime: expect.any(Object),
    });
  });
});
