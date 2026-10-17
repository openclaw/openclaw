import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import type { ChannelPluginCatalogEntry } from "../channels/plugins/catalog.js";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import type { ChannelAccountSnapshot } from "../channels/plugins/types.public.js";
import type { resolvePluginControlPlaneWorkspace as ResolveWorkspace } from "../plugins/control-plane-workspace.js";
import { createTestConfigSnapshot, createTestRuntime } from "./test-runtime-config-helpers.js";

const {
  metadataSnapshot,
  readConfigFileSnapshot,
  resolveCommandConfigWithSecrets,
  listReadOnlyChannelPluginsForConfig,
  resolveChannelAccountSnapshot,
  listTrustedChannelPluginCatalogEntries,
  listPluginContributionIds,
  resolveMissingOfficialExternalChannelPluginRepairHints,
  callGateway,
  resolvePluginControlPlaneWorkspace,
  resolvePluginMetadataSnapshot,
} = vi.hoisted(() => ({
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
  resolvePluginControlPlaneWorkspace: vi.fn<typeof ResolveWorkspace>(() => ({
    workspaceDir: "/tmp/workspace",
    workspaceScope: "selected",
  })),
  resolvePluginMetadataSnapshot: vi.fn(),
}));

vi.mock("../config/config.js", () => ({ readConfigFileSnapshot }));
vi.mock("../cli/command-config-resolution.js", () => ({ resolveCommandConfigWithSecrets }));
vi.mock("../gateway/call.js", () => ({ callGateway }));
vi.mock("../plugins/plugin-metadata-snapshot.js", () => ({ resolvePluginMetadataSnapshot }));
vi.mock("../plugins/control-plane-workspace.js", () => ({ resolvePluginControlPlaneWorkspace }));
vi.mock("../cli/command-secret-targets.js", () => ({
  getChannelsCommandSecretTargetIds: () => new Set<string>(),
}));
vi.mock("../channels/plugins/read-only.js", () => ({ listReadOnlyChannelPluginsForConfig }));
vi.mock("../channels/plugins/status.js", () => ({ resolveChannelAccountSnapshot }));
vi.mock("./channel-setup/trusted-catalog.js", () => ({ listTrustedChannelPluginCatalogEntries }));
vi.mock("../plugins/plugin-registry.js", () => ({ listPluginContributionIds }));
vi.mock("../plugins/official-external-plugin-repair-hints.js", () => ({
  resolveMissingOfficialExternalChannelPluginRepairHints,
}));

import { channelsListCommand } from "./channels/list.js";

function channelMeta(id: string, label: string) {
  return { id, label, selectionLabel: label, docsPath: `/channels/${id}`, blurb: label };
}

function channelPlugin(id: string, label: string, accountIds: string[] = []): ChannelPlugin {
  return {
    id,
    meta: channelMeta(id, label),
    capabilities: { chatTypes: ["direct"] },
    config: {
      listAccountIds: () => accountIds,
      resolveAccount: () => ({}),
    },
  };
}

function createCatalogEntry(id: string, label: string): ChannelPluginCatalogEntry {
  return {
    id,
    pluginId: `@openclaw/${id}`,
    meta: channelMeta(id, label),
    install: { npmSpec: `@openclaw/${id}` },
  };
}

describe("channels list", () => {
  const runtime = createTestRuntime();
  const loggedText = () => {
    const value = runtime.log.mock.calls[0]?.[0];
    expect(typeof value).toBe("string");
    return String(value);
  };
  const output = () => stripAnsi(loggedText());
  const list = (opts: Parameters<typeof channelsListCommand>[0] = {}) =>
    channelsListCommand(opts, runtime);
  const jsonOutput = () =>
    JSON.parse(loggedText()) as {
      chat: Record<string, { installed: boolean; origin: string; accounts: string[] }>;
      diagnostics?: Array<{ code?: string }>;
    };
  function discordAccount(
    snapshot: Partial<ChannelAccountSnapshot> = {},
    accountIds = ["default"],
  ) {
    listReadOnlyChannelPluginsForConfig.mockReturnValue([
      channelPlugin("discord", "Discord", accountIds),
    ]);
    resolveChannelAccountSnapshot.mockResolvedValue({
      accountId: "default",
      configured: false,
      tokenSource: "none",
      enabled: true,
      ...snapshot,
    });
  }
  function expectText(text: string, included: readonly string[], excluded: readonly string[] = []) {
    included.forEach((fragment) => expect(text).toContain(fragment));
    excluded.forEach((fragment) => expect(text).not.toContain(fragment));
  }
  afterEach(() => vi.unstubAllEnvs());

  beforeEach(() => {
    vi.clearAllMocks();
    readConfigFileSnapshot.mockReset().mockResolvedValue(createTestConfigSnapshot({}));
    listReadOnlyChannelPluginsForConfig.mockReset().mockReturnValue([]);
    resolveChannelAccountSnapshot.mockReset();
    listTrustedChannelPluginCatalogEntries.mockReset().mockReturnValue([]);
    listPluginContributionIds.mockReset().mockReturnValue([]);
    resolveMissingOfficialExternalChannelPluginRepairHints.mockReset().mockReturnValue([]);
    callGateway.mockReset().mockRejectedValue(new Error("gateway unavailable"));
    resolvePluginControlPlaneWorkspace.mockReset().mockReturnValue({
      workspaceDir: "/tmp/workspace",
      workspaceScope: "selected",
    });
    resolvePluginMetadataSnapshot.mockReturnValue(metadataSnapshot);
  });

  it("keeps shared inventory when an explicit multi-agent roster has no system owner", async () => {
    resolvePluginControlPlaneWorkspace.mockReturnValue({
      workspaceScope: "omitted",
      diagnostic: {
        level: "warn",
        code: "workspace-scope-omitted",
        message: "Workspace plugin discovery was skipped for this explicit roster.",
      },
    });
    listTrustedChannelPluginCatalogEntries.mockReturnValue([createCatalogEntry("qqbot", "QQ Bot")]);
    listPluginContributionIds.mockReturnValue(["qqbot"]);
    readConfigFileSnapshot.mockResolvedValue(
      createTestConfigSnapshot({
        agents: { ownership: "explicit", entries: { main: {}, research: {} } },
      }),
    );

    await list({ all: true, json: true });

    const payload = jsonOutput();
    expect(payload.chat.qqbot?.installed).toBe(true);
    expect(payload.diagnostics).toContainEqual(
      expect.objectContaining({ code: "workspace-scope-omitted" }),
    );
  });

  it("sanitizes channel labels only in terminal output", async () => {
    const control = "\u001B]0;channels-list-injection\u0007";
    const accountId = `${control}default\nforged-row`;
    listReadOnlyChannelPluginsForConfig.mockReturnValue([
      channelPlugin("telegram", `${control}Telegram 🦞\r\nAdmin`, [accountId]),
    ]);
    resolveChannelAccountSnapshot.mockResolvedValue({
      accountId,
      name: `${control}Primary\tAccount`,
      configured: true,
      enabled: true,
    });
    await list();

    expectText(
      loggedText(),
      ["Telegram 🦞\\r\\nAdmin", "\\nforged-row", "Primary\\tAccount"],
      ["\u001B", "\nforged-row"],
    );

    runtime.log.mockClear();
    await list({ json: true });
    const payload = jsonOutput();
    expect(payload.chat?.telegram?.accounts).toStrictEqual([accountId]);
  });

  it.each([
    [
      "reachable Gateway",
      {},
      ["Discord default (clawsweeper):", "configured", "token=env"],
      ["not configured", "token=none"],
    ],
    ["unreachable Gateway", {}, ["Discord default:", "not configured", "token=none"], []],
    [
      "unavailable credential",
      { configured: true, tokenSource: "config", tokenStatus: "configured_unavailable" },
      ["configured", "token=config-unavailable"],
      [],
    ],
  ] as const)("renders %s account status", async (label, snapshot, included, excluded) => {
    discordAccount(snapshot);
    if (label === "reachable Gateway") {
      callGateway.mockResolvedValue({
        channelAccounts: {
          discord: [
            {
              accountId: "default",
              name: "clawsweeper",
              configured: true,
              tokenSource: "env",
            },
          ],
        },
      });
    }
    await list({ all: true });
    expect(callGateway).toHaveBeenCalledWith({
      method: "channels.status",
      params: { probe: false, timeoutMs: 5000 },
      timeoutMs: 5000,
    });
    expectText(output(), included, excluded);
  });

  it("default output shows recovery for a missing plugin with env credentials", async () => {
    listTrustedChannelPluginCatalogEntries.mockReturnValue([
      createCatalogEntry("mattermost", "Mattermost"),
    ]);
    const actual = await vi.importActual<
      typeof import("../plugins/official-external-plugin-repair-hints.js")
    >("../plugins/official-external-plugin-repair-hints.js");
    resolveMissingOfficialExternalChannelPluginRepairHints.mockImplementation(
      actual.resolveMissingOfficialExternalChannelPluginRepairHints,
    );
    vi.stubEnv("MATTERMOST_URL", "https://mattermost.example.test");
    vi.stubEnv("MATTERMOST_BOT_TOKEN", "test-token");

    await list();

    expectText(
      output(),
      [
        "Mattermost",
        "not installed",
        "configured",
        "disabled",
        "run openclaw plugins install npm:@openclaw/mattermost or openclaw doctor --fix",
      ],
      ["no configured chat channels"],
    );
  });

  it("--all surfaces bundled-but-unconfigured plugins with installed=true / not configured", async () => {
    discordAccount({ enabled: false, tokenSource: undefined }, []);

    await list();
    expect(output()).not.toContain("Discord default:");

    runtime.log.mockClear();

    await list({ all: true });
    expectText(output(), ["Discord default:", "installed", "not configured", "disabled"]);
  });

  it("--all JSON exposes 'origin' tag (configured / available / installable)", async () => {
    listReadOnlyChannelPluginsForConfig.mockReturnValue([
      channelPlugin("telegram", "Telegram", ["default"]),
      channelPlugin("discord", "Discord"),
    ]);
    listTrustedChannelPluginCatalogEntries.mockReturnValue([
      { ...createCatalogEntry("qqbot", "QQ Bot"), officialDocsPath: "/channels/qqbot" },
      { ...createCatalogEntry("telegram", "Telegram"), officialDocsPath: "/channels/telegram" },
    ]);
    listPluginContributionIds.mockReturnValue(["telegram"]);
    await list({ json: true, all: true });

    const payload = jsonOutput();
    expect(payload.chat).toMatchObject({
      telegram: {
        origin: "configured",
        installed: true,
        label: "Telegram",
        docsPath: "/channels/telegram",
      },
      discord: { origin: "available", installed: true, label: "Discord" },
      qqbot: {
        origin: "installable",
        installed: false,
        label: "QQ Bot",
        docsPath: "/channels/qqbot",
      },
    });
    expect(payload.chat.discord).not.toHaveProperty("docsPath");
  });
});
