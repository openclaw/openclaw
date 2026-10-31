import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import { ExpectedCliError } from "../../cli/failure-output.js";
import type { OpenClawConfig, replaceConfigFile } from "../../config/config.js";
import { DEFAULT_ACCOUNT_ID } from "../../routing/session-key.js";
import { createChannelTestPluginBase } from "../../test-utils/channel-plugins.js";
import {
  createCapturingTestRuntime,
  createTestConfigSnapshot,
} from "../test-runtime-config-helpers.js";
import { channelsCapabilitiesCommand } from "./capabilities.js";

const { runtime, logs, errors } = createCapturingTestRuntime();
const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  readConfigFileSnapshot: vi.fn(),
  readConfigFileSnapshotForWrite: vi.fn(),
  resolveCommandSecretRefsViaGateway: vi.fn(),
  replaceConfigFile: vi.fn<(params: Parameters<typeof replaceConfigFile>[0]) => Promise<void>>(),
  refreshPluginRegistryAfterConfigMutation: vi.fn(async () => undefined),
  resolveInstallableChannelPlugin: vi.fn(),
  listReadOnlyChannelPluginsForConfig: vi.fn(),
}));

vi.mock("../../cli/command-secret-gateway.js", () => ({
  resolveCommandSecretRefsViaGateway: mocks.resolveCommandSecretRefsViaGateway,
}));

vi.mock("../../channels/plugins/read-only.js", () => ({
  listReadOnlyChannelPluginsForConfig: mocks.listReadOnlyChannelPluginsForConfig,
}));

vi.mock("../../config/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
  const { createTestConfigReadMocks } = await import("../test-runtime-config-helpers.js");
  return {
    ...actual,
    ...createTestConfigReadMocks(mocks, "loadConfig"),
    readConfigFileSnapshot: mocks.readConfigFileSnapshot,
    readConfigFileSnapshotForWrite: mocks.readConfigFileSnapshotForWrite,
    replaceConfigFile: mocks.replaceConfigFile,
  };
});

vi.mock("../../plugins/registry-refresh.js", () => ({
  refreshPluginRegistryAfterConfigMutation: mocks.refreshPluginRegistryAfterConfigMutation,
}));

vi.mock("../channel-setup/channel-plugin-resolution.js", () => ({
  resolveInstallableChannelPlugin: mocks.resolveInstallableChannelPlugin,
}));

function buildPlugin(
  params: Partial<Pick<ChannelPlugin, "id" | "status">> & {
    account?: Record<string, unknown>;
  } = {},
): ChannelPlugin {
  const id = params.id ?? "slack";
  return {
    ...createChannelTestPluginBase({
      id,
      docsPath: "/channels/test",
      config: {
        resolveAccount: () => params.account ?? { accountId: "default" },
        defaultAccountId: () => DEFAULT_ACCOUNT_ID,
        isConfigured: () => true,
        isEnabled: () => true,
      },
    }),
    status: params.status,
    actions: {
      describeMessageTool: () => ({ actions: ["poll"] }),
    },
  };
}

function selectPlugin(params: Parameters<typeof buildPlugin>[0] = {}) {
  const plugin = buildPlugin(params);
  mocks.resolveInstallableChannelPlugin.mockResolvedValue({
    cfg: { channels: {} },
    channelId: plugin.id,
    plugin,
    configChanged: false,
  });
  return plugin;
}

const botAccount = { accountId: "default", botToken: "xoxb-bot" };
const accountRequired =
  "--account requires a specific --channel. Run openclaw channels list to choose one.";
const targetRequired =
  "--target requires a specific --channel. Run openclaw channels list to choose one.";
const pending = () => Promise.withResolvers<never>().promise;
const reportHeader = "slack default\nSupport: chatTypes=direct\nActions: send, broadcast, poll";

function expectReport(...lines: string[]) {
  expect(logs).toStrictEqual([[reportHeader, ...lines].join("\n")]);
}

describe("channelsCapabilitiesCommand", () => {
  beforeEach(() => {
    vi.stubEnv("NO_COLOR", "1");
    logs.length = 0;
    errors.length = 0;
    vi.clearAllMocks();
    const baseConfig = { channels: {} };
    mocks.loadConfig.mockReturnValue(baseConfig);
    mocks.readConfigFileSnapshot.mockResolvedValue({
      ...createTestConfigSnapshot(baseConfig),
      hash: "config-1",
    });
    mocks.resolveCommandSecretRefsViaGateway.mockImplementation(async ({ config }) => ({
      resolvedConfig: config,
      diagnostics: [],
    }));
    mocks.readConfigFileSnapshotForWrite.mockImplementation(async () => ({
      snapshot: await mocks.readConfigFileSnapshot(),
      writeOptions: {},
    }));
    mocks.replaceConfigFile.mockResolvedValue(undefined);
    mocks.listReadOnlyChannelPluginsForConfig.mockReturnValue([]);
    mocks.resolveInstallableChannelPlugin.mockResolvedValue({
      cfg: { channels: {} },
      configChanged: false,
    });
  });

  it.each([undefined, "all"])("keeps %s capabilities listing read-only", async (channel) => {
    await channelsCapabilitiesCommand({ channel }, runtime);
    expect(mocks.readConfigFileSnapshot).toHaveBeenCalledOnce();
    expect(mocks.readConfigFileSnapshotForWrite).not.toHaveBeenCalled();
    expect(mocks.resolveInstallableChannelPlugin).not.toHaveBeenCalled();
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
  });

  it("prints an empty all-channel report when no channels are configured", async () => {
    await channelsCapabilitiesCommand({ json: true }, runtime);

    expect(errors).toStrictEqual([]);
    expect(logs).toStrictEqual([JSON.stringify({ channels: [] }, null, 2)]);
  });

  it.each([
    ["account without channel", { account: "ghost", json: true }, accountRequired, 0],
    ["account with all", { channel: "all", account: "ghost" }, accountRequired, 0],
    ["target without channel", { target: "channel:1", json: true }, targetRequired, 0],
    ["target with all", { channel: "all", target: "channel:1" }, targetRequired, 0],
    ["account before target", { account: "ghost", target: "channel:1" }, accountRequired, 0],
    [
      "unknown channel",
      { channel: "definitely-not-a-channel", json: true },
      'Unknown channel "definitely-not-a-channel". Run `openclaw channels list --all` to see configured and installable channels.',
      1,
    ],
  ] as const)("rejects %s before account resolution", async (_name, options, message, calls) => {
    const plugin = buildPlugin();
    const listAccountIds = vi.fn(() => ["default"]);
    const resolveAccount = vi.fn(() => ({ accountId: "default" }));
    const probeAccount = vi.fn(async () => ({ ok: true }));
    plugin.config.listAccountIds = listAccountIds;
    plugin.config.resolveAccount = resolveAccount;
    plugin.status = { probeAccount };
    mocks.listReadOnlyChannelPluginsForConfig.mockReturnValue([plugin]);

    const failure = channelsCapabilitiesCommand(options, runtime);

    await expect(failure).rejects.toBeInstanceOf(ExpectedCliError);
    await expect(failure).rejects.toMatchObject({
      message,
      humanOutput: message,
      machineOutput: message,
    });
    expect(logs).toStrictEqual([]);
    expect(errors).toStrictEqual([]);
    expect(mocks.listReadOnlyChannelPluginsForConfig).toHaveBeenCalledTimes(calls);
    expect(mocks.resolveInstallableChannelPlugin).toHaveBeenCalledTimes(calls);
    expect(listAccountIds).not.toHaveBeenCalled();
    expect(resolveAccount).not.toHaveBeenCalled();
    expect(probeAccount).not.toHaveBeenCalled();
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
    expect(mocks.refreshPluginRegistryAfterConfigMutation).not.toHaveBeenCalled();
  });

  it.each([
    { expected: 'Received: "10s"', label: "unparseable", timeout: "10s" },
    { expected: "Invalid --timeout", label: "empty", timeout: "" },
    { expected: "Invalid --timeout", label: "whitespace", timeout: " \t " },
  ])("rejects a $label timeout before capability probes", async ({ expected, timeout }) => {
    const probeAccount = vi.fn(async () => ({ ok: true }));
    selectPlugin({ account: botAccount, status: { probeAccount } });

    await expect(
      channelsCapabilitiesCommand({ channel: "slack", timeout }, runtime),
    ).rejects.toThrow(expected);
    expect(probeAccount).not.toHaveBeenCalled();
  });

  it("caps oversized timeouts before invoking capability probes", async () => {
    const probeAccount = vi.fn(async () => ({ ok: true }));
    const buildCapabilitiesDiagnostics = vi.fn(async () => ({
      lines: [{ text: "Diagnostics: ok" }],
    }));
    selectPlugin({ account: botAccount, status: { probeAccount, buildCapabilitiesDiagnostics } });

    await channelsCapabilitiesCommand({ channel: "slack", timeout: "999999" }, runtime);

    expect(probeAccount).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 30_000 }));
    expect(buildCapabilitiesDiagnostics).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 30_000 }),
    );
  });

  it("probes prepared accounts and reports their names", async () => {
    const account = { accountId: "default", name: "Prepared account" };
    const probeAccount = vi.fn(async () => ({ ok: true }));
    const plugin = selectPlugin({ status: { probeAccount } });
    plugin.config.resolveAccount = () => {
      throw new Error("legacy account resolution");
    };
    plugin.config.resolveAccountAsync = async () => account;

    await channelsCapabilitiesCommand({ channel: "slack", json: true }, runtime);

    expect(probeAccount).toHaveBeenCalledWith(expect.objectContaining({ account }));
    expect(logs.join("\n")).toContain("Prepared account");
  });

  it("times out a stalled probe after a wall-clock rollback and continues to the next account", async () => {
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    try {
      const plugin = buildPlugin();
      plugin.config.listAccountIds = () => ["stalled", "healthy"];
      plugin.config.resolveAccount = (_cfg, accountId) => ({ accountId });
      plugin.status = {
        probeAccount: async ({ account }) => {
          if (account.accountId === "healthy") {
            return { ok: true };
          }
          vi.setSystemTime(Date.now() - 5_000);
          return pending();
        },
      };
      mocks.listReadOnlyChannelPluginsForConfig.mockReturnValue([plugin]);

      const result = channelsCapabilitiesCommand({ json: true, timeout: "1000" }, runtime);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(logs).toHaveLength(1);
      await result;

      expect(JSON.parse(logs.join("\n")).channels).toMatchObject([
        {
          accountId: "stalled",
          probe: { ok: false, timedOut: true, error: "check timed out after 1000ms" },
        },
        { accountId: "healthy", probe: { ok: true } },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders remote probe failures and diagnostics as terminal-safe text", async () => {
    const evil = "\u001b]52;c;QQ==\u0007evil\u001b[2J\r\nforged";
    selectPlugin({
      id: "telegram",
      account: { accountId: "default", botToken: "bot-token" },
      status: {
        probeAccount: async () => ({ ok: false, error: evil }),
        formatCapabilitiesProbe: () => [],
        buildCapabilitiesDiagnostics: async () => ({
          lines: [{ text: `Diag: ${evil}`, tone: "error" }, { text: evil }],
        }),
      },
    });

    await channelsCapabilitiesCommand({ channel: "telegram" }, runtime);

    const output = logs.join("\n");
    const withoutWhitespaceControl = output.replaceAll("\n", "");
    expect(withoutWhitespaceControl).not.toMatch(/\p{Cc}/u);
    expect(output).not.toContain("52;c;QQ==");
    expect(output).toContain("Check: failed (evil\\r\\nforged)");
    expect(output).toContain("Diag: evil\\r\\nforged");
    expect(output.split("\n")).toContain("evil\\r\\nforged");

    logs.length = 0;
    await channelsCapabilitiesCommand({ channel: "telegram", json: true }, runtime);
    expect(JSON.parse(logs[0] ?? "{}").channels[0]).toMatchObject({
      probe: { error: evil },
      diagnostics: { lines: [{ text: `Diag: ${evil}`, tone: "error" }, { text: evil }] },
    });
  });

  it("serializes diagnostics when capability diagnostics exceed their timeout", async () => {
    selectPlugin({
      account: botAccount,
      status: { probeAccount: async () => ({ ok: true }), buildCapabilitiesDiagnostics: pending },
    });

    await channelsCapabilitiesCommand({ channel: "slack", json: true, timeout: "1" }, runtime);
    expect(JSON.parse(logs[0] ?? "{}").channels?.[0]?.diagnostics).toStrictEqual({
      lines: [{ text: "Diagnostics: timed out after 1ms", tone: "error" }],
      details: { timedOut: true },
    });
  });

  it("installs an explicit optional channel in the selected owner before rendering capabilities", async () => {
    const tokenRef = {
      source: "env",
      provider: "default",
      id: "CAPABILITIES_TEST_SLACK_TOKEN",
    } as const;
    const sourceConfig = { channels: { slack: { botToken: tokenRef } } };
    const messages = { responsePrefix: "runtime-default" };
    let runtimeConfig: OpenClawConfig = { ...sourceConfig, messages };
    mocks.loadConfig.mockImplementation(() => runtimeConfig);
    mocks.readConfigFileSnapshot.mockImplementation(async () => ({
      ...createTestConfigSnapshot(sourceConfig, runtimeConfig),
      hash: "config-1",
    }));
    mocks.resolveCommandSecretRefsViaGateway.mockImplementation(async ({ config }) => ({
      resolvedConfig: {
        ...config,
        channels: { slack: { botToken: "resolved-capabilities-token" } },
      },
      diagnostics: [],
    }));
    const plugin = buildPlugin();
    const resolveAccount = vi.fn((cfg) => ({
      accountId: "default",
      botToken: cfg.channels?.slack?.botToken,
    }));
    const probeAccount = vi.fn(async ({ cfg }) => ({
      ok: true,
      botToken: cfg.channels?.slack?.botToken,
    }));
    plugin.config.resolveAccount = resolveAccount;
    plugin.status = {
      probeAccount,
      formatCapabilitiesProbe: () => [{ text: "Probe: linked" }, { text: "Team: team" }],
    };
    mocks.resolveInstallableChannelPlugin.mockImplementation(async ({ cfg }) => ({
      cfg: { ...cfg, plugins: { entries: { slack: { enabled: true } } } },
      channelId: "slack",
      plugin,
      configChanged: true,
      pluginInstalled: true,
    }));
    mocks.replaceConfigFile.mockImplementation(async ({ sourceConfig: writtenSource }) => {
      runtimeConfig = { ...writtenSource, messages };
    });

    await channelsCapabilitiesCommand({ channel: "slack", agent: "ops" }, runtime);

    const installArgs = mocks.resolveInstallableChannelPlugin.mock.calls[0]?.[0];
    expect(installArgs).toMatchObject({
      rawChannel: "slack",
      agentId: "ops",
      allowInstall: true,
    });
    expect(installArgs.cfg).toEqual(sourceConfig);

    const writeArgs = mocks.replaceConfigFile.mock.calls[0]?.[0];
    expect(writeArgs?.baseHash).toBe("config-1");
    expect(writeArgs?.sourceConfig).toStrictEqual({
      ...sourceConfig,
      plugins: { entries: { slack: { enabled: true } } },
    });
    expect(mocks.resolveCommandSecretRefsViaGateway).toHaveBeenCalledTimes(2);
    const resolutions = mocks.resolveCommandSecretRefsViaGateway.mock.calls.map(([args]) => args);
    expect(resolutions.map(({ commandName }) => commandName)).toEqual(["channels", "channels"]);
    expect(resolutions[1]?.config).toEqual(runtimeConfig);
    const preparedConfig = {
      channels: { slack: { botToken: "resolved-capabilities-token" } },
      messages,
    };
    expect(resolveAccount.mock.calls[0]?.[0]).toMatchObject(preparedConfig);
    expect(probeAccount.mock.calls[0]?.[0].cfg).toMatchObject(preparedConfig);

    expect(mocks.refreshPluginRegistryAfterConfigMutation).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ reason: "source-changed" }),
    );
    expectReport("Probe: linked", "Team: team");
  });
});
