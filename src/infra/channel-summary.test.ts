import { describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import { inspectTelegramAccount } from "../telegram/account-inspect.js";
import { listTelegramAccountIds, resolveDefaultTelegramAccountId } from "../telegram/accounts.js";
import { makeDirectPlugin } from "../test-utils/channel-plugin-test-fixtures.js";

vi.mock("../channels/plugins/index.js", () => ({
  listChannelPlugins: vi.fn(),
}));

const { buildChannelSummary } = await import("./channel-summary.js");
const { listChannelPlugins } = await import("../channels/plugins/index.js");

function makeSlackHttpSummaryPlugin(): ChannelPlugin {
  return {
    id: "slack",
    meta: {
      id: "slack",
      label: "Slack",
      selectionLabel: "Slack",
      docsPath: "/channels/slack",
      blurb: "test",
    },
    capabilities: { chatTypes: ["direct"] },
    config: {
      listAccountIds: () => ["primary"],
      defaultAccountId: () => "primary",
      inspectAccount: (cfg) =>
        (cfg as { marker?: string }).marker === "source"
          ? {
              accountId: "primary",
              name: "Primary",
              enabled: true,
              configured: true,
              mode: "http",
              botToken: "xoxb-http",
              signingSecret: "",
              botTokenSource: "config",
              signingSecretSource: "config", // pragma: allowlist secret
              botTokenStatus: "available",
              signingSecretStatus: "configured_unavailable", // pragma: allowlist secret
            }
          : {
              accountId: "primary",
              name: "Primary",
              enabled: true,
              configured: false,
              mode: "http",
              botToken: "xoxb-http",
              botTokenSource: "config",
              botTokenStatus: "available",
            },
      resolveAccount: () => ({
        accountId: "primary",
        name: "Primary",
        enabled: true,
        configured: false,
        mode: "http",
        botToken: "xoxb-http",
        botTokenSource: "config",
        botTokenStatus: "available",
      }),
      isConfigured: (account) => Boolean((account as { configured?: boolean }).configured),
      isEnabled: () => true,
    },
    actions: {
      listActions: () => ["send"],
    },
  };
}

describe("buildChannelSummary", () => {
  it("preserves Slack HTTP signing-secret unavailable state from source config", async () => {
    vi.mocked(listChannelPlugins).mockReturnValue([makeSlackHttpSummaryPlugin()]);

    const lines = await buildChannelSummary({ marker: "resolved", channels: {} } as never, {
      colorize: false,
      includeAllowFrom: false,
      sourceConfig: { marker: "source", channels: {} } as never,
    });

    expect(lines).toContain("Slack: configured");
    expect(lines).toContain(
      "  - primary (Primary) (bot:config, signing:config, secret unavailable in this command path)",
    );
  });

  it("treats multi-account Telegram tokenFile setups as configured", async () => {
    vi.mocked(listChannelPlugins).mockReturnValue([
      makeDirectPlugin({
        id: "telegram",
        label: "Telegram",
        docsPath: "/channels/telegram",
        config: {
          listAccountIds: listTelegramAccountIds,
          defaultAccountId: resolveDefaultTelegramAccountId,
          inspectAccount: (cfg, accountId) => inspectTelegramAccount({ cfg, accountId }),
          resolveAccount: (cfg, accountId) => inspectTelegramAccount({ cfg, accountId }),
          isConfigured: (account) => Boolean((account as { configured?: boolean }).configured),
          isEnabled: (account) => (account as { enabled?: boolean }).enabled !== false,
        },
      }),
    ]);

    const cfg = {
      channels: {
        telegram: {
          enabled: true,
          defaultAccount: "nimbus",
          accounts: {
            default: {
              tokenFile: "/tmp/openclaw-telegram-default-token",
            },
            nimbus: {
              tokenFile: "/tmp/openclaw-telegram-default-token",
            },
            flint: {
              tokenFile: "/tmp/openclaw-telegram-flint-token",
            },
          },
        },
      },
    } as never;

    const lines = await buildChannelSummary(cfg, {
      colorize: false,
      includeAllowFrom: false,
    });

    expect(lines).toContain("Telegram: configured");
    expect(lines).toContain(
      "  - default (token:tokenFile, secret unavailable in this command path)",
    );
    expect(lines).toContain("  - flint (token:tokenFile, secret unavailable in this command path)");
    expect(lines).toContain(
      "  - nimbus (token:tokenFile, secret unavailable in this command path)",
    );
  });
});
