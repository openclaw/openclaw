import { describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.js";

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

  it("returns non-empty fallback lines when plugin preload is skipped", async () => {
    vi.mocked(listChannelPlugins).mockReturnValue([]);

    const lines = await buildChannelSummary(
      {
        channels: {
          slack: {
            enabled: true,
            botToken: "xoxb-test",
            appToken: "xapp-test",
          },
          imessage: {
            enabled: true,
            cliPath: "/usr/local/bin/imsg",
          },
          zulip: {
            enabled: true,
            botEmail: "bot@zulip.example.com",
            botApiKey: "zulip-api-key",
            baseUrl: "https://zulip.example.com",
          },
          twitch: {
            enabled: true,
            username: "openclawbot",
            accessToken: "oauth:test123",
            clientId: "twitch-client-id",
            channel: "lionrootstudio",
          },
          matrix: {
            enabled: true,
            homeserver: "https://matrix.example.org",
            userId: "@bot:example.org",
            accessToken: "tok-matrix",
          },
          msteams: {
            enabled: true,
            appId: "teams-app-id",
            appPassword: "teams-password",
            tenantId: "tenant-123",
          },
          "synology-chat": {
            enabled: true,
            token: "synology-token",
            incomingUrl: "https://nas.example.com/webapi/entry.cgi",
            nasHost: "nas.example.com",
            botName: "OpenClaw NAS",
          },
        },
      } as never,
      {
        colorize: false,
        includeAllowFrom: false,
      },
    );

    expect(lines).toContain("Slack: configured");
    expect(lines).toContain("iMessage: configured");
    expect(lines).toContain("Zulip: configured");
    expect(lines).toContain("Twitch: configured");
    expect(lines).toContain("Matrix: configured");
    expect(lines).toContain("Microsoft Teams: configured");
    expect(lines).toContain("Synology Chat: configured");
    expect(lines).toContain("  - default (bot:config, app:config)");
    expect(lines).toContain("  - default (cli:/usr/local/bin/imsg)");
    expect(lines).toContain(
      "  - default (email:bot@zulip.example.com, https://zulip.example.com)",
    );
    expect(lines).toContain(
      "  - default (user:openclawbot, channel:lionrootstudio, token:config, client:config)",
    );
    expect(lines).toContain(
      "  - default (user:@bot:example.org, homeserver:https://matrix.example.org, token:config)",
    );
    expect(lines).toContain("  - default (tenant:tenant-123, app:config, password:config)");
    expect(lines).toContain(
      "  - default (bot:OpenClaw NAS, nas:nas.example.com, token:config, incoming:config)",
    );
  });
});
