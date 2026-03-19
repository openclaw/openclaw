import { describe, expect, it, vi } from "vitest";
import { listChannelPlugins } from "../channels/plugins/index.js";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import { buildChannelSummary } from "./channel-summary.js";

vi.mock("../channels/plugins/index.js", () => ({
  listChannelPlugins: vi.fn(),
}));

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
      describeMessageTool: () => ({ actions: ["send"] }),
    },
  };
}

function makeTelegramSummaryPlugin(params: {
  enabled: boolean;
  configured: boolean;
  linked?: boolean;
  authAgeMs?: number;
  allowFrom?: string[];
}): ChannelPlugin {
  return {
    id: "telegram",
    meta: {
      id: "telegram",
      label: "Telegram",
      selectionLabel: "Telegram",
      docsPath: "/channels/telegram",
      blurb: "test",
    },
    capabilities: { chatTypes: ["direct"] },
    config: {
      listAccountIds: () => ["primary"],
      defaultAccountId: () => "primary",
      inspectAccount: () => ({
        accountId: "primary",
        name: "Main Bot",
        enabled: params.enabled,
        configured: params.configured,
        linked: params.linked,
        allowFrom: params.allowFrom ?? [],
        dmPolicy: "mutuals",
        tokenSource: "env",
      }),
      resolveAccount: () => ({
        accountId: "primary",
        name: "Main Bot",
        enabled: params.enabled,
        configured: params.configured,
        linked: params.linked,
        allowFrom: params.allowFrom ?? [],
        dmPolicy: "mutuals",
        tokenSource: "env",
      }),
      isConfigured: (account) => Boolean((account as { configured?: boolean }).configured),
      isEnabled: (account) => Boolean((account as { enabled?: boolean }).enabled),
      formatAllowFrom: () => ["alice", "bob", "carol"],
    },
    status: {
      buildChannelSummary: async () => ({
        linked: params.linked,
        configured: params.configured,
        authAgeMs: params.authAgeMs,
        self: { e164: "+15551234567" },
      }),
    },
    actions: {
      describeMessageTool: () => ({ actions: ["send"] }),
    },
  };
}

function makeSignalSummaryPlugin(params: { enabled: boolean; configured: boolean }): ChannelPlugin {
  return {
    id: "signal",
    meta: {
      id: "signal",
      label: "Signal",
      selectionLabel: "Signal",
      docsPath: "/channels/signal",
      blurb: "test",
    },
    capabilities: { chatTypes: ["direct"] },
    config: {
      listAccountIds: () => ["desktop"],
      defaultAccountId: () => "desktop",
      inspectAccount: () => ({
        accountId: "desktop",
        name: "Desktop",
        enabled: params.enabled,
        configured: params.configured,
        appTokenSource: "env",
        baseUrl: "https://signal.example.test",
        port: 31337,
        cliPath: "/usr/local/bin/signal-cli",
        dbPath: "/tmp/signal.db",
      }),
      resolveAccount: () => ({
        accountId: "desktop",
        name: "Desktop",
        enabled: params.enabled,
        configured: params.configured,
        appTokenSource: "env",
        baseUrl: "https://signal.example.test",
        port: 31337,
        cliPath: "/usr/local/bin/signal-cli",
        dbPath: "/tmp/signal.db",
      }),
      isConfigured: (account) => Boolean((account as { configured?: boolean }).configured),
      isEnabled: (account) => Boolean((account as { enabled?: boolean }).enabled),
    },
    actions: {
      describeMessageTool: () => ({ actions: ["send"] }),
    },
  };
}

function makeFallbackSummaryPlugin(params: {
  configured: boolean;
  enabled: boolean;
  accountIds?: string[];
  defaultAccountId?: string;
}): ChannelPlugin {
  return {
    id: "fallback-plugin",
    meta: {
      id: "fallback-plugin",
      label: "Fallback",
      selectionLabel: "Fallback",
      docsPath: "/channels/fallback",
      blurb: "test",
    },
    capabilities: { chatTypes: ["direct"] },
    config: {
      listAccountIds: () => params.accountIds ?? [],
      defaultAccountId: () => params.defaultAccountId ?? "default",
      inspectAccount: (_cfg, accountId) => ({
        accountId,
        enabled: params.enabled,
        configured: params.configured,
      }),
      resolveAccount: (_cfg, accountId) => ({
        accountId,
        enabled: params.enabled,
        configured: params.configured,
      }),
      isConfigured: (account) => Boolean((account as { configured?: boolean }).configured),
      isEnabled: (account) => Boolean((account as { enabled?: boolean }).enabled),
    },
    actions: {
      describeMessageTool: () => ({ actions: ["send"] }),
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

  it("shows disabled status without configured account detail lines", async () => {
    vi.mocked(listChannelPlugins).mockReturnValue([
      makeTelegramSummaryPlugin({ enabled: false, configured: false }),
    ]);

    const lines = await buildChannelSummary({ channels: {} } as never, {
      colorize: false,
      includeAllowFrom: true,
    });

    expect(lines).toEqual(["Telegram: disabled +15551234567"]);
  });

  it("includes linked summary metadata and truncates allow-from details", async () => {
    vi.mocked(listChannelPlugins).mockReturnValue([
      makeTelegramSummaryPlugin({
        enabled: true,
        configured: true,
        linked: true,
        authAgeMs: 300_000,
        allowFrom: ["alice", "bob", "carol"],
      }),
    ]);

    const lines = await buildChannelSummary({ channels: {} } as never, {
      colorize: false,
      includeAllowFrom: true,
    });

    expect(lines).toContain("Telegram: linked +15551234567 auth 5m ago");
    expect(lines).toContain("  - primary (Main Bot) (dm:mutuals, token:env, allow:alice,bob)");
  });

  it("shows not-linked status when linked metadata is explicitly false", async () => {
    vi.mocked(listChannelPlugins).mockReturnValue([
      makeTelegramSummaryPlugin({
        enabled: true,
        configured: true,
        linked: false,
      }),
    ]);

    const lines = await buildChannelSummary({ channels: {} } as never, {
      colorize: false,
      includeAllowFrom: false,
    });

    expect(lines).toContain("Telegram: not linked +15551234567");
    expect(lines).toContain("  - primary (Main Bot) (dm:mutuals, token:env)");
  });

  it("renders non-slack account detail fields for configured accounts", async () => {
    vi.mocked(listChannelPlugins).mockReturnValue([
      makeSignalSummaryPlugin({ enabled: false, configured: true }),
    ]);

    const lines = await buildChannelSummary({ channels: {} } as never, {
      colorize: false,
      includeAllowFrom: false,
    });

    expect(lines).toEqual([
      "Signal: disabled",
      "  - desktop (Desktop) (disabled, app:env, https://signal.example.test, port:31337, cli:/usr/local/bin/signal-cli, db:/tmp/signal.db)",
    ]);
  });

  it("uses the channel label and default account id when no accounts exist", async () => {
    vi.mocked(listChannelPlugins).mockReturnValue([
      makeFallbackSummaryPlugin({
        enabled: true,
        configured: true,
        accountIds: [],
        defaultAccountId: "fallback-account",
      }),
    ]);

    const lines = await buildChannelSummary({ channels: {} } as never, {
      colorize: false,
      includeAllowFrom: false,
    });

    expect(lines).toEqual(["Fallback: configured", "  - fallback-account"]);
  });

  it("shows not-configured status when enabled accounts exist without configured ones", async () => {
    vi.mocked(listChannelPlugins).mockReturnValue([
      makeFallbackSummaryPlugin({
        enabled: true,
        configured: false,
        accountIds: ["fallback-account"],
      }),
    ]);

    const lines = await buildChannelSummary({ channels: {} } as never, {
      colorize: false,
      includeAllowFrom: false,
    });

    expect(lines).toEqual(["Fallback: not configured"]);
  });
});
