// Channels list tests cover catalog entries, installed plugins, status fallback, and terminal output.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import type { ChannelPluginCatalogEntry } from "../channels/plugins/catalog.js";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import type { resolvePluginControlPlaneWorkspace } from "../plugins/control-plane-workspace.js";
import { createTestConfigSnapshot, createTestRuntime } from "./test-runtime-config-helpers.js";

const mocks = vi.hoisted(() => ({
  metadataSnapshot: {
    plugins: [],
    index: { plugins: [] },
    discovery: { candidates: [], diagnostics: [] },
  },
  readConfigFileSnapshot: vi.fn(),
  resolveCommandConfigWithSecrets: vi.fn(async ({ config }: { config: unknown }) => ({
    resolvedConfig: config,
    effectiveConfig: config,
    diagnostics: [],
  })),
  listReadOnlyChannelPluginsForConfig: vi.fn<() => ChannelPlugin[]>(() => []),
  resolveChannelAccountSnapshot: vi.fn(),
  listTrustedChannelPluginCatalogEntries: vi.fn<() => ChannelPluginCatalogEntry[]>(() => []),
  listPluginContributionIds: vi.fn<() => readonly string[]>(() => []),
  resolveMissingOfficialExternalChannelPluginRepairHints: vi.fn(),
  callGateway: vi.fn(),
  resolvePluginControlPlaneWorkspace: vi.fn<typeof resolvePluginControlPlaneWorkspace>(() => ({
    workspaceDir: "/tmp/workspace",
    workspaceScope: "selected",
  })),
  resolvePluginMetadataSnapshot: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
}));

vi.mock("../cli/command-config-resolution.js", () => ({
  resolveCommandConfigWithSecrets: mocks.resolveCommandConfigWithSecrets,
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: mocks.callGateway,
}));

vi.mock("../plugins/plugin-metadata-snapshot.js", () => ({
  resolvePluginMetadataSnapshot: mocks.resolvePluginMetadataSnapshot,
}));

vi.mock("../plugins/control-plane-workspace.js", () => ({
  resolvePluginControlPlaneWorkspace: mocks.resolvePluginControlPlaneWorkspace,
}));

vi.mock("../cli/command-secret-targets.js", () => ({
  getChannelsCommandSecretTargetIds: () => new Set<string>(),
}));

vi.mock("../channels/plugins/read-only.js", () => ({
  listReadOnlyChannelPluginsForConfig: mocks.listReadOnlyChannelPluginsForConfig,
}));

vi.mock("../channels/plugins/status.js", () => ({
  resolveChannelAccountSnapshot: mocks.resolveChannelAccountSnapshot,
}));

vi.mock("./channel-setup/trusted-catalog.js", () => ({
  listTrustedChannelPluginCatalogEntries: mocks.listTrustedChannelPluginCatalogEntries,
}));

vi.mock("../plugins/plugin-registry.js", () => ({
  listPluginContributionIds: mocks.listPluginContributionIds,
}));

vi.mock("../plugins/official-external-plugin-repair-hints.js", () => ({
  resolveMissingOfficialExternalChannelPluginRepairHints:
    mocks.resolveMissingOfficialExternalChannelPluginRepairHints,
}));

import { channelsListCommand } from "./channels/list.js";

function createMockChannelPlugin(overrides: {
  id?: string;
  label?: string;
  accountIds?: string[];
}): ChannelPlugin {
  const id = overrides.id ?? "telegram";
  return {
    id,
    meta: {
      id,
      label: overrides.label ?? "Telegram",
      selectionLabel: overrides.label ?? "Telegram",
      docsPath: `/channels/${id}`,
      blurb: overrides.label ?? "Telegram",
    },
    capabilities: { chatTypes: ["direct"] },
    config: {
      listAccountIds: () => overrides.accountIds ?? [],
      resolveAccount: () => ({}),
    },
  };
}

function createCatalogEntry(id: string, label: string): ChannelPluginCatalogEntry {
  return {
    id,
    pluginId: `@openclaw/${id}`,
    meta: {
      id,
      label,
      selectionLabel: label,
      docsPath: `/channels/${id}`,
      blurb: label,
    },
    install: { npmSpec: `@openclaw/${id}` },
  };
}

function loggedText(runtime: ReturnType<typeof createTestRuntime>): string {
  const value = runtime.log.mock.calls[0]?.[0];
  if (typeof value !== "string") {
    throw new Error("expected runtime log text");
  }
  return value;
}

describe("channels list", () => {
  const runtime = createTestRuntime();
  afterEach(() => vi.unstubAllEnvs());

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readConfigFileSnapshot.mockReset().mockResolvedValue(createTestConfigSnapshot({}));
    mocks.resolveCommandConfigWithSecrets.mockClear();
    mocks.listReadOnlyChannelPluginsForConfig.mockReset();
    mocks.listReadOnlyChannelPluginsForConfig.mockReturnValue([]);
    mocks.resolveChannelAccountSnapshot.mockReset();
    mocks.listTrustedChannelPluginCatalogEntries.mockReset();
    mocks.listTrustedChannelPluginCatalogEntries.mockReturnValue([]);
    mocks.listPluginContributionIds.mockReset();
    mocks.listPluginContributionIds.mockReturnValue([]);
    mocks.resolveMissingOfficialExternalChannelPluginRepairHints.mockReset();
    mocks.resolveMissingOfficialExternalChannelPluginRepairHints.mockReturnValue([]);
    mocks.callGateway.mockReset();
    mocks.callGateway.mockRejectedValue(new Error("gateway unavailable"));
    mocks.resolvePluginControlPlaneWorkspace.mockReset();
    mocks.resolvePluginControlPlaneWorkspace.mockReturnValue({
      workspaceDir: "/tmp/workspace",
      workspaceScope: "selected",
    });
    mocks.resolvePluginMetadataSnapshot.mockReturnValue(mocks.metadataSnapshot);
  });

  it("keeps shared inventory when an explicit multi-agent roster has no system owner", async () => {
    const config = {
      agents: {
        ownership: "explicit" as const,
        entries: { main: {}, research: {} },
      },
    };
    mocks.resolvePluginControlPlaneWorkspace.mockReturnValue({
      workspaceScope: "omitted",
      diagnostic: {
        level: "warn",
        code: "workspace-scope-omitted",
        message: "Workspace plugin discovery was skipped for this explicit roster.",
      },
    });
    mocks.listTrustedChannelPluginCatalogEntries.mockReturnValue([
      createCatalogEntry("qqbot", "QQ Bot"),
    ]);
    mocks.listPluginContributionIds.mockReturnValue(["qqbot"]);
    mocks.readConfigFileSnapshot.mockResolvedValue(createTestConfigSnapshot(config));

    await channelsListCommand({ all: true, json: true }, runtime);

    const payload = JSON.parse(loggedText(runtime)) as {
      chat: Record<string, { installed: boolean }>;
      diagnostics?: Array<{ code?: string }>;
    };
    expect(payload.chat.qqbot?.installed).toBe(true);
    expect(payload.diagnostics).toContainEqual(
      expect.objectContaining({ code: "workspace-scope-omitted" }),
    );
  });

  it("sanitizes channel labels only in terminal output", async () => {
    const control = "\u001B]0;channels-list-injection\u0007";
    const accountId = `${control}default\nforged-row`;
    const channelLabel = `${control}Telegram 🦞\r\nAdmin`;
    const accountName = `${control}Primary\tAccount`;
    mocks.listReadOnlyChannelPluginsForConfig.mockReturnValue([
      createMockChannelPlugin({ label: channelLabel, accountIds: [accountId] }),
    ]);
    mocks.resolveChannelAccountSnapshot.mockResolvedValue({
      accountId,
      name: accountName,
      configured: true,
      enabled: true,
    });
    const config = { channels: { telegram: { accounts: { [accountId]: {} } } } };
    mocks.readConfigFileSnapshot.mockResolvedValue(createTestConfigSnapshot(config));

    const textRuntime = createTestRuntime();
    await channelsListCommand({}, textRuntime);

    const textOutput = loggedText(textRuntime);
    expect(textOutput).not.toContain("\u001B");
    expect(textOutput).not.toContain("\nforged-row");
    expect(textOutput).toContain("Telegram 🦞\\r\\nAdmin");
    expect(textOutput).toContain("\\nforged-row");
    expect(textOutput).toContain("Primary\\tAccount");

    const jsonRuntime = createTestRuntime();
    await channelsListCommand({ json: true }, jsonRuntime);
    const payload = JSON.parse(loggedText(jsonRuntime)) as {
      chat?: Record<string, { accounts: string[] }>;
    };
    expect(payload.chat?.telegram?.accounts).toStrictEqual([accountId]);
  });

  it("prefers reachable gateway account snapshots over command-local token state", async () => {
    mocks.listReadOnlyChannelPluginsForConfig.mockReturnValue([
      createMockChannelPlugin({ id: "discord", label: "Discord", accountIds: ["default"] }),
    ]);
    mocks.resolveChannelAccountSnapshot.mockResolvedValue({
      accountId: "default",
      configured: false,
      tokenSource: "none",
      enabled: true,
    });
    mocks.callGateway.mockResolvedValue({
      channelAccounts: {
        discord: [
          {
            accountId: "default",
            name: "clawsweeper",
            configured: true,
            tokenSource: "env",
            tokenStatus: "available",
            enabled: true,
          },
        ],
      },
    });

    await channelsListCommand({ all: true }, runtime);

    expect(mocks.callGateway).toHaveBeenCalledWith({
      method: "channels.status",
      params: { probe: false, timeoutMs: 5000 },
      timeoutMs: 5000,
    });
    const output = stripAnsi(loggedText(runtime));
    expect(output).toContain("Discord default (clawsweeper):");
    expect(output).toContain("configured");
    expect(output).toContain("token=env");
    expect(output).not.toContain("not configured");
    expect(output).not.toContain("token=none");
  });

  it("falls back to command-local account snapshots when gateway status is unavailable", async () => {
    mocks.listReadOnlyChannelPluginsForConfig.mockReturnValue([
      createMockChannelPlugin({ id: "discord", label: "Discord", accountIds: ["default"] }),
    ]);
    mocks.resolveChannelAccountSnapshot.mockResolvedValue({
      accountId: "default",
      configured: false,
      tokenSource: "none",
      enabled: true,
    });
    mocks.callGateway.mockRejectedValue(new Error("gateway unavailable"));

    await channelsListCommand({ all: true }, runtime);

    const output = stripAnsi(loggedText(runtime));
    expect(output).toContain("Discord default:");
    expect(output).toContain("not configured");
    expect(output).toContain("token=none");
  });

  it("marks configured-but-unavailable credential sources in text output", async () => {
    mocks.listReadOnlyChannelPluginsForConfig.mockReturnValue([
      createMockChannelPlugin({ id: "discord", label: "Discord", accountIds: ["default"] }),
    ]);
    mocks.resolveChannelAccountSnapshot.mockResolvedValue({
      accountId: "default",
      configured: true,
      tokenSource: "config",
      tokenStatus: "configured_unavailable",
      enabled: true,
    });

    await channelsListCommand({ all: true }, runtime);

    const output = stripAnsi(loggedText(runtime));
    expect(output).toContain("configured");
    expect(output).toContain("token=config-unavailable");
  });

  it("default output does NOT show installable catalog channels (only configured ones)", async () => {
    mocks.listReadOnlyChannelPluginsForConfig.mockReturnValue([]);
    mocks.listTrustedChannelPluginCatalogEntries.mockReturnValue([
      createCatalogEntry("qqbot", "QQ Bot"),
    ]);
    mocks.listPluginContributionIds.mockReturnValue([]);

    await channelsListCommand({}, runtime);

    const output = stripAnsi(loggedText(runtime));
    expect(output).toContain("Chat channels:");
    expect(output).not.toContain("QQ Bot");
    // Hint user about --all
    expect(output).toContain("--all");
  });

  it.each(["env"])(
    "default output shows recovery for a missing plugin with credentials from %s",
    async (source) => {
      mocks.listTrustedChannelPluginCatalogEntries.mockReturnValue([
        createCatalogEntry("mattermost", "Mattermost"),
      ]);
      const actual = await vi.importActual<
        typeof import("../plugins/official-external-plugin-repair-hints.js")
      >("../plugins/official-external-plugin-repair-hints.js");
      mocks.resolveMissingOfficialExternalChannelPluginRepairHints.mockImplementation(
        actual.resolveMissingOfficialExternalChannelPluginRepairHints,
      );
      vi.stubEnv("MATTERMOST_URL", source === "env" ? "https://mattermost.example.test" : "");
      vi.stubEnv("MATTERMOST_BOT_TOKEN", source === "env" ? "test-token" : "");
      mocks.readConfigFileSnapshot.mockResolvedValue(
        createTestConfigSnapshot(
          source === "config" ? { channels: { mattermost: { botToken: "test-token" } } } : {},
        ),
      );

      await channelsListCommand({}, runtime);

      const output = stripAnsi(loggedText(runtime));
      expect(output).toContain("Mattermost");
      expect(output).toContain("not installed");
      expect(output).toContain("configured");
      expect(output).toContain("disabled");
      expect(output).toContain(
        "run openclaw plugins install @openclaw/mattermost or openclaw doctor --fix",
      );
      expect(output).not.toContain("no configured chat channels");
    },
  );

  it("--all surfaces bundled-but-unconfigured plugins with installed=true / not configured", async () => {
    mocks.listReadOnlyChannelPluginsForConfig.mockReturnValue([
      createMockChannelPlugin({ id: "discord", label: "Discord", accountIds: [] }),
    ]);
    mocks.resolveChannelAccountSnapshot.mockResolvedValue({
      accountId: "default",
      configured: false,
      enabled: false,
    });

    // Without --all: discord should not appear.
    await channelsListCommand({}, runtime);
    const noAllOutput = stripAnsi(loggedText(runtime));
    expect(noAllOutput).not.toContain("Discord default:");

    runtime.log.mockClear();

    // With --all: discord is rendered with installed + not configured + disabled.
    await channelsListCommand({ all: true }, runtime);
    const allOutput = stripAnsi(loggedText(runtime));
    expect(allOutput).toContain("Discord default:");
    expect(allOutput).toContain("installed");
    expect(allOutput).toContain("not configured");
    expect(allOutput).toContain("disabled");
  });

  it("--all JSON exposes 'origin' tag (configured / available / installable)", async () => {
    mocks.listReadOnlyChannelPluginsForConfig.mockReturnValue([
      createMockChannelPlugin({ id: "telegram", accountIds: ["default"] }),
      createMockChannelPlugin({ id: "discord", label: "Discord", accountIds: [] }),
    ]);
    mocks.resolveChannelAccountSnapshot.mockResolvedValue({
      accountId: "default",
      configured: false,
      enabled: false,
    });
    mocks.listTrustedChannelPluginCatalogEntries.mockReturnValue([
      { ...createCatalogEntry("qqbot", "QQ Bot"), officialDocsPath: "/channels/qqbot" },
      { ...createCatalogEntry("telegram", "Telegram"), officialDocsPath: "/channels/telegram" },
    ]);
    mocks.listPluginContributionIds.mockReturnValue(["telegram"]);
    mocks.readConfigFileSnapshot.mockResolvedValue(
      createTestConfigSnapshot({
        channels: {
          telegram: { accounts: { default: { botToken: "x:y" } } },
        },
      }),
    );

    await channelsListCommand({ json: true, all: true }, runtime);

    const payload = JSON.parse(loggedText(runtime)) as {
      chat: Record<string, { origin: string; installed: boolean }>;
    };
    expect(payload.chat.telegram?.origin).toBe("configured");
    expect(payload.chat.telegram?.installed).toBe(true);
    expect(payload.chat.discord?.origin).toBe("available");
    expect(payload.chat.discord?.installed).toBe(true);
    expect(payload.chat.qqbot?.origin).toBe("installable");
    expect(payload.chat.qqbot?.installed).toBe(false);
    expect(payload.chat.telegram).toMatchObject({
      label: "Telegram",
      docsPath: "/channels/telegram",
    });
    expect(payload.chat.qqbot).toMatchObject({ label: "QQ Bot", docsPath: "/channels/qqbot" });
    expect(payload.chat.discord).toMatchObject({ label: "Discord" });
    expect(payload.chat.discord).not.toHaveProperty("docsPath");
  });

  it.each([false])("reuses catalog facts and preserves rows with json=%s", async (json) => {
    mocks.listReadOnlyChannelPluginsForConfig.mockReturnValue([
      createMockChannelPlugin({ accountIds: ["default"] }),
    ]);
    mocks.resolveChannelAccountSnapshot.mockResolvedValue({ accountId: "default" });
    mocks.listTrustedChannelPluginCatalogEntries.mockReturnValue([
      createCatalogEntry("wecom", "WeCom"),
      createCatalogEntry("telegram", "Telegram"),
      createCatalogEntry("discord", "Discord"),
      createCatalogEntry("wecom", "WeCom duplicate"),
      createCatalogEntry("qqbot", "QQ Bot"),
    ]);
    mocks.listPluginContributionIds.mockReturnValue(["wecom", "telegram"]);
    mocks.resolveMissingOfficialExternalChannelPluginRepairHints.mockReturnValue([
      {
        channelId: "discord",
        installCommand: "openclaw plugins install @openclaw/discord",
        doctorFixCommand: "openclaw doctor --fix",
      },
    ]);

    await channelsListCommand({ all: true, json }, runtime);

    expect(mocks.listPluginContributionIds).toHaveBeenCalledOnce();
    expect(mocks.resolveMissingOfficialExternalChannelPluginRepairHints).toHaveBeenCalledOnce();
    expect(stripAnsi(loggedText(runtime))).toBe(
      [
        "Chat channels:",
        "- Telegram default: installed",
        "- WeCom: installed, not configured, disabled",
        "- Discord: not installed, configured, disabled, run openclaw plugins install @openclaw/discord or openclaw doctor --fix",
        "- WeCom duplicate: installed, not configured, disabled",
        "- QQ Bot: not installed, not configured, disabled",
      ].join("\n"),
    );
  });
});
