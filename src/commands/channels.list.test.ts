import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import { stripAnsi } from "../terminal/ansi.js";
import { baseConfigSnapshot, createTestRuntime } from "./test-runtime-config-helpers.js";

const mocks = vi.hoisted(() => ({
  readConfigFileSnapshot: vi.fn(),
  resolveCommandConfigWithSecrets: vi.fn(async ({ config }: { config: unknown }) => ({
    resolvedConfig: config,
    effectiveConfig: config,
    diagnostics: [],
  })),
  listChatChannels: vi.fn(() => [
    { id: "discord", label: "Discord", order: 10 },
    { id: "telegram", label: "Telegram", order: 20 },
  ]),
  listReadOnlyChannelPluginsForConfig: vi.fn<() => ChannelPlugin[]>(() => []),
  listTrustedChannelPluginCatalogEntries: vi.fn<() => any[]>(() => []),
  buildChannelAccountSnapshot: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
}));

vi.mock("../cli/command-config-resolution.js", () => ({
  resolveCommandConfigWithSecrets: mocks.resolveCommandConfigWithSecrets,
}));

vi.mock("../cli/command-secret-targets.js", () => ({
  getChannelsCommandSecretTargetIds: () => new Set<string>(),
}));

vi.mock("../channels/chat-meta.js", () => ({
  listChatChannels: mocks.listChatChannels,
}));

vi.mock("../channels/plugins/read-only.js", () => ({
  listReadOnlyChannelPluginsForConfig: mocks.listReadOnlyChannelPluginsForConfig,
}));

vi.mock("../channels/plugins/status.js", () => ({
  buildChannelAccountSnapshot: mocks.buildChannelAccountSnapshot,
}));

vi.mock("./channel-setup/trusted-catalog.js", () => ({
  listTrustedChannelPluginCatalogEntries: mocks.listTrustedChannelPluginCatalogEntries,
}));

import { channelsListCommand } from "./channels/list.js";

function createMockChannelPlugin(params: {
  id?: string;
  label?: string;
  accountIds?: string[];
  order?: number;
}): ChannelPlugin {
  const id = params.id ?? "telegram";
  return {
    id,
    meta: {
      id,
      label: params.label ?? id,
      selectionLabel: params.label ?? id,
      docsPath: `/channels/${id}`,
      blurb: params.label ?? id,
      order: params.order,
    },
    capabilities: { chatTypes: ["direct"] },
    config: {
      listAccountIds: () => params.accountIds ?? [],
      resolveAccount: () => ({}),
    },
  };
}

describe("channels list", () => {
  beforeEach(() => {
    mocks.readConfigFileSnapshot.mockReset();
    mocks.resolveCommandConfigWithSecrets.mockClear();
    mocks.listChatChannels.mockReset();
    mocks.listChatChannels.mockReturnValue([
      { id: "discord", label: "Discord", order: 10 },
      { id: "telegram", label: "Telegram", order: 20 },
    ]);
    mocks.listTrustedChannelPluginCatalogEntries.mockReset();
    mocks.listTrustedChannelPluginCatalogEntries.mockReturnValue([]);
    mocks.listReadOnlyChannelPluginsForConfig.mockReset();
    mocks.listReadOnlyChannelPluginsForConfig.mockReturnValue([]);
    mocks.buildChannelAccountSnapshot.mockReset();
  });

  it("lists only channels in JSON output", async () => {
    const runtime = createTestRuntime();
    mocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {},
    });

    await channelsListCommand({ json: true, usage: false }, runtime);

    expect(mocks.resolveCommandConfigWithSecrets).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(runtime.log.mock.calls[0]?.[0] as string) as {
      channels?: Array<{ id: string; configured: boolean; enabled: boolean; installed: boolean }>;
      auth?: unknown;
      usage?: unknown;
    };
    expect(payload.auth).toBeUndefined();
    expect(payload.usage).toBeUndefined();
    expect(payload.channels?.map((entry) => entry.id)).toEqual(["discord", "telegram"]);
    expect(payload.channels?.[0]).toMatchObject({
      id: "discord",
      configured: false,
      enabled: true,
      installed: false,
    });
  });

  it("includes bundled/catalog/configured channels with status flags", async () => {
    const runtime = createTestRuntime();
    mocks.listReadOnlyChannelPluginsForConfig.mockReturnValue([
      createMockChannelPlugin({
        id: "telegram",
        label: "Telegram",
        accountIds: ["alerts"],
        order: 20,
      }),
    ]);
    mocks.listTrustedChannelPluginCatalogEntries.mockReturnValue([
      {
        id: "slack",
        meta: { id: "slack", label: "Slack", selectionLabel: "Slack", order: 30 },
        install: { npmSpec: "@openclaw/slack" },
      },
    ]);
    mocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {
        channels: {
          telegram: {
            accounts: { alerts: { botToken: "456:def" } },
          },
          slack: { enabled: false },
          custom: { webhookUrl: "https://example.invalid/hook" },
        },
      },
    });

    await channelsListCommand({ json: true, usage: false }, runtime);

    expect(mocks.listReadOnlyChannelPluginsForConfig).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ includeSetupFallbackPlugins: true }),
    );
    const payload = JSON.parse(runtime.log.mock.calls[0]?.[0] as string) as {
      channels: Array<{
        id: string;
        configured: boolean;
        enabled: boolean;
        installed: boolean;
        accounts: string[];
      }>;
    };
    expect(payload.channels).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "telegram",
          configured: true,
          enabled: true,
          installed: true,
          accounts: ["alerts"],
        }),
        expect.objectContaining({
          id: "slack",
          configured: false,
          enabled: false,
          installed: false,
          accounts: [],
        }),
        expect.objectContaining({
          id: "custom",
          configured: true,
          enabled: true,
          installed: false,
          accounts: [],
        }),
      ]),
    );
  });

  it("prints channel rows and account rows without auth providers", async () => {
    const runtime = createTestRuntime();
    mocks.listReadOnlyChannelPluginsForConfig.mockReturnValue([
      createMockChannelPlugin({
        id: "telegram",
        label: "Telegram",
        accountIds: ["default"],
        order: 20,
      }),
    ]);
    mocks.buildChannelAccountSnapshot.mockResolvedValue({
      accountId: "default",
      configured: true,
      tokenSource: "config",
      enabled: true,
    });
    mocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {
        channels: {
          telegram: {
            accounts: {
              default: { botToken: "123:abc" },
            },
          },
        },
      },
    });

    await channelsListCommand({ usage: false }, runtime);

    const output = stripAnsi(runtime.log.mock.calls[0]?.[0] as string);
    expect(output).toContain("Chat channels:");
    expect(output).toContain("Discord: not configured, enabled, not installed");
    expect(output).toContain("Telegram: configured, enabled, installed");
    expect(output).toContain("Telegram default: configured, token=config, enabled");
    expect(output).not.toContain("Auth providers");
  });
});
