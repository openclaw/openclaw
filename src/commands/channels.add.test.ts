import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { getBundledChannelSetupPlugin } from "../channels/plugins/bundled.js";
import type { ChannelPluginCatalogEntry } from "../channels/plugins/catalog.js";
import { defineChannelSetupContract } from "../channels/plugins/setup-contract.js";
import {
  applyAccountNameToChannelSection,
  patchScopedAccountConfig,
} from "../channels/plugins/setup-helpers.js";
import type { SetupChannelsOptions } from "../channels/plugins/setup-wizard-types.js";
import type { ChannelSetupInput } from "../channels/plugins/types.core.js";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withPluginMetadataSnapshotScope } from "../plugins/current-plugin-metadata-snapshot.js";
import type { PluginPackageChannelCliOption } from "../plugins/manifest.js";
import {
  bindPluginMetadataSnapshotCache,
  createPluginCache,
  getPluginCache,
  withPluginCache,
} from "../plugins/plugin-cache.js";
import { PluginInstance } from "../plugins/plugin-instance.js";
import {
  hasPluginLifecycleLease,
  withPluginLifecycleLease,
} from "../plugins/plugin-lifecycle-lease.js";
import * as pluginMetadata from "../plugins/plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { createInstallAccountPolicyFixture } from "../plugins/test-helpers/install-account-policy.test-support.js";
import { resolveChannelAccountEntry } from "../routing/account-lookup.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../routing/session-key.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { WizardSession } from "../wizard/session.js";
import {
  ensureChannelSetupPluginInstalled,
  loadChannelSetupPluginRegistrySnapshotForChannel,
} from "./channel-setup/plugin-install.js";
import { configMocks, lifecycleMocks } from "./channels.mock-harness.js";
import {
  createExternalChatCatalogEntry,
  createExternalChatSetupPlugin,
} from "./channels.plugin-install.test-helpers.js";
import { committedConfigFiles as configFiles } from "./committed-config.test-support.js";
import {
  baseConfigSnapshot,
  createTestConfigSnapshot,
  createTestRuntime,
} from "./test-runtime-config-helpers.js";

let channelsAddCommand: typeof import("./channels/add.js").channelsAddCommand;
let runChannelsSetupWizard: typeof import("./channels/add-wizard.js").runChannelsSetupWizard;

const {
  catalogMocks,
  discoveryMocks,
  pluginInstallMocks,
  registryRefreshMocks,
  pluginInstallRecordCommitMocks,
  terminalMocks,
  policyMocks,
} = vi.hoisted(() => ({
  catalogMocks: {
    getChannelPluginCatalogEntry: vi.fn(),
    listChannelPluginCatalogEntries: vi.fn((): ChannelPluginCatalogEntry[] => []),
  },
  discoveryMocks: { isCatalogChannelInstalled: vi.fn(() => false) },
  pluginInstallMocks: {
    ensureChannelSetupPluginInstalled: vi.fn(),
    loadChannelSetupPluginRegistrySnapshotForChannel: vi.fn(),
  },
  registryRefreshMocks: {
    refreshPluginRegistryAfterConfigMutation: vi.fn<
      typeof import("../plugins/registry-refresh.js").refreshPluginRegistryAfterConfigMutation
    >(async () => undefined),
  },
  pluginInstallRecordCommitMocks: { commitConfigWithPendingPluginInstalls: vi.fn() },
  terminalMocks: { isTerminalInteractive: vi.fn(() => true) },
  policyMocks: {
    readCurrentConfigForPolicyCheckAsync: vi.fn<() => Promise<OpenClawConfig>>(async () => ({})),
  },
}));

vi.mock("../config/io.runtime.js", () => policyMocks);

const channelWizardMocks = vi.hoisted(() => ({
  prompter: {
    intro: vi.fn(async () => undefined),
    outro: vi.fn(async () => undefined),
    confirm: vi.fn(async () => false),
    note: vi.fn(async () => undefined),
    select: vi.fn(),
    multiselect: vi.fn(async () => []),
    text: vi.fn(),
    progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
  },
  setupChannels: vi.fn<typeof import("../flows/channel-setup.js").setupChannels>(
    async (cfg) => cfg,
  ),
}));

const bundledMocks = vi.hoisted(() => ({
  getBundledChannelPlugin: vi.fn(() => undefined),
  getBundledChannelSetupPlugin: vi.fn(() => undefined),
}));

vi.mock("../channels/plugins/catalog.js", () => ({
  getChannelPluginCatalogEntry: catalogMocks.getChannelPluginCatalogEntry,
  listRawChannelPluginCatalogEntries: catalogMocks.listChannelPluginCatalogEntries,
}));

vi.mock("./channel-setup/discovery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./channel-setup/discovery.js")>()),
  ...discoveryMocks,
}));

vi.mock("../channels/plugins/bundled.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../channels/plugins/bundled.js")>()),
  ...bundledMocks,
}));

vi.mock("./channel-setup/plugin-install.js", () => pluginInstallMocks);

vi.mock("../plugins/registry-refresh.js", () => registryRefreshMocks);

vi.mock("../plugins/install-record-commit.js", () => pluginInstallRecordCommitMocks);

vi.mock("../cli/terminal-interactivity.js", () => terminalMocks);

vi.mock("../wizard/clack-prompter.js", () => ({
  createClackPrompter: () => channelWizardMocks.prompter,
}));

vi.mock("../flows/channel-setup.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../flows/channel-setup.js")>()),
  setupChannels: channelWizardMocks.setupChannels,
}));

const runtime = createTestRuntime();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const readSignalAccount: ChannelPlugin["config"]["resolveAccount"] = (cfg, accountId) =>
  resolveChannelAccountEntry(
    cfg.channels?.signal?.accounts,
    normalizeAccountId(accountId),
    "signal",
  );
const commitInstalls = pluginInstallRecordCommitMocks.commitConfigWithPendingPluginInstalls;
const prompter = channelWizardMocks.prompter;
const wizard = (opts: Parameters<typeof runChannelsSetupWizard>[0] = {}) =>
  runChannelsSetupWizard(opts, runtime, prompter);
const signalAccount = (name: string) => ({ account: "+12025550123", name });
const signalAccounts = (name: string) => ({ accounts: { "Work Phone": signalAccount(name) } });

function mockSetup(
  run: (options: SetupChannelsOptions, cfg: OpenClawConfig) => Promise<OpenClawConfig>,
) {
  channelWizardMocks.setupChannels.mockImplementationOnce(
    (cfg, _runtime, _prompter, options = {}) => run(options, cfg),
  );
}

function add(
  opts: Parameters<typeof channelsAddCommand>[0],
  params: Parameters<typeof channelsAddCommand>[2] = { hasFlags: true },
) {
  return channelsAddCommand(opts, runtime, params);
}

function setConfig(config: OpenClawConfig) {
  configMocks.readConfigFileSnapshot.mockResolvedValue(createTestConfigSnapshot(config));
}

function withChannel(
  cfg: OpenClawConfig,
  channel: string,
  value: Record<string, unknown>,
): OpenClawConfig {
  return { ...cfg, channels: { ...cfg.channels, [channel]: value } };
}

function registerPlugin(plugin: ChannelPlugin, pluginId = plugin.id) {
  setActivePluginRegistry(createTestRegistry([{ pluginId, plugin, source: "test" }]));
}

function ownerConfig(includeChannels = true): OpenClawConfig {
  return {
    agents: {
      ownership: "explicit",
      entries: {
        main: { workspace: "/tmp/openclaw-main-workspace" },
        helper: { workspace: "/tmp/openclaw-helper-workspace" },
      },
    },
    ...(includeChannels ? { channels: {} } : {}),
  };
}

function externalCatalog(
  overrides: Partial<Omit<ChannelPluginCatalogEntry, "meta">> & {
    meta?: Partial<ChannelPluginCatalogEntry["meta"]>;
  },
): ChannelPluginCatalogEntry {
  const entry = createExternalChatCatalogEntry();
  return { ...entry, ...overrides, meta: { ...entry.meta, ...overrides.meta } };
}

function expectNoWizardWrite() {
  expect(prompter.intro).not.toHaveBeenCalled();
  expect(channelWizardMocks.setupChannels).not.toHaveBeenCalled();
  expect(configMocks.writeConfigFile).not.toHaveBeenCalled();
}

function createSetupOptionCatalogEntry(
  id: string,
  label: string,
  cliAddOptions: readonly PluginPackageChannelCliOption[],
): ChannelPluginCatalogEntry {
  return {
    id,
    pluginId: id,
    origin: "global",
    channel: { id, label, cliAddOptions },
    meta: createChannelTestPluginBase({ id, label }).meta,
    install: { npmSpec: `@openclaw/${id}` },
  };
}

const requireRecord = createRequireRecord("object", "expected-label");
function writtenConfig() {
  return requireRecord(configMocks.writeConfigFile.mock.calls[0]?.[0], "written config");
}
function writtenChannel(channel: string) {
  return requireRecord(requireRecord(writtenConfig().channels, "channels")[channel], channel);
}
function setupOptions() {
  return requireRecord(channelWizardMocks.setupChannels.mock.calls[0]?.[3], "setup options");
}
function installCall() {
  return requireRecord(vi.mocked(ensureChannelSetupPluginInstalled).mock.calls[0]?.[0], "install");
}
function snapshotCall() {
  return requireRecord(
    vi.mocked(loadChannelSetupPluginRegistrySnapshotForChannel).mock.calls[0]?.[0],
    "snapshot",
  );
}
function createLifecycleChatAddTestPlugin(): ChannelPlugin {
  const resolveAccount = (cfg: OpenClawConfig, accountId?: string | null) => {
    const channel = cfg.channels?.["lifecycle-chat"];
    const scoped = channel?.accounts?.[accountId || DEFAULT_ACCOUNT_ID];
    return {
      token:
        typeof scoped?.token === "string"
          ? scoped.token
          : typeof channel?.token === "string"
            ? channel.token
            : "",
      enabled: scoped?.enabled ?? channel?.enabled ?? true,
    };
  };
  return {
    ...createChannelTestPluginBase({ id: "lifecycle-chat", label: "Lifecycle Chat" }),
    config: {
      listAccountIds: (cfg) => {
        const channel = cfg.channels?.["lifecycle-chat"];
        const ids = Object.keys(channel?.accounts ?? {});
        return ids.length ? ids : channel?.token ? [DEFAULT_ACCOUNT_ID] : [];
      },
      resolveAccount,
    },
    setup: {
      resolveAccountId: ({ accountId }) => accountId || DEFAULT_ACCOUNT_ID,
      applyAccountConfig: ({ cfg, accountId, input }) =>
        patchScopedAccountConfig({
          cfg,
          channelKey: "lifecycle-chat",
          accountId,
          patch: input.token ? { token: input.token } : {},
        }),
    },
    lifecycle: {
      onAccountConfigChanged: async ({ prevCfg, nextCfg, accountId }) => {
        if (
          resolveAccount(prevCfg, accountId).token.trim() !==
          resolveAccount(nextCfg, accountId).token.trim()
        ) {
          await lifecycleMocks.onAccountConfigChanged({ accountId });
        }
      },
    },
  };
}

function registerExternalChatSetupPlugin(pluginId = "@vendor/external-chat-plugin"): void {
  vi.mocked(loadChannelSetupPluginRegistrySnapshotForChannel).mockResolvedValue(
    createTestRegistry([{ pluginId, plugin: createExternalChatSetupPlugin(), source: "test" }]),
  );
}

function registerEnvContractTestPlugin(channelId: string, envVars: readonly string[]): void {
  registerPlugin({
    ...createChannelTestPluginBase({ id: channelId, label: channelId }),
    setupContract: defineChannelSetupContract({
      fields: {
        useEnv: {
          kind: "boolean",
          cli: { flags: "--use-env", description: "Use environment credentials" },
          envVars,
        },
      },
      adapter: {
        applyAccountConfig: ({ cfg }) => withChannel(cfg, channelId, { enabled: true }),
      },
    }),
  } as ChannelPlugin);
}

type SignalAfterAccountConfigWritten = NonNullable<
  NonNullable<ChannelPlugin["setup"]>["afterAccountConfigWritten"]
>;
type ApplyAccountConfigParams = Parameters<
  NonNullable<NonNullable<ChannelPlugin["setup"]>["applyAccountConfig"]>
>[0];
type SignalSetupInput = ChannelSetupInput & { signalNumber?: string };
type MatrixSetupInput = ChannelSetupInput & { initialSyncLimit?: number };

function setupOptionPlugin(
  id: string,
  outputChannel: string,
  options: readonly PluginPackageChannelCliOption[],
  fields: (input: ChannelSetupInput) => Record<string, unknown>,
) {
  const applyAccountConfig = vi.fn(({ cfg, input }: ApplyAccountConfigParams) =>
    withChannel(cfg, outputChannel, { enabled: true, ...fields(input) }),
  );
  catalogMocks.listChannelPluginCatalogEntries.mockReturnValue([
    createSetupOptionCatalogEntry(id, id, options),
  ]);
  registerPlugin({ ...createChannelTestPluginBase({ id }), setup: { applyAccountConfig } });
  return applyAccountConfig;
}

function cliOption(flags: string, valueType: "int" | "list"): PluginPackageChannelCliOption {
  return { flags, description: flags, valueType };
}

async function runSignalAddCommand(
  afterAccountConfigWritten: SignalAfterAccountConfigWritten,
  beforePersistentEffect?: () => Promise<void>,
) {
  registerPlugin({
    ...createChannelTestPluginBase({ id: "signal", label: "Signal" }),
    setup: {
      applyAccountConfig: ({ cfg, accountId, input }) =>
        withChannel(cfg, "signal", {
          enabled: true,
          accounts: { [accountId]: { account: (input as SignalSetupInput).signalNumber } },
        }),
      afterAccountConfigWritten,
    },
  } as ChannelPlugin);
  await add(
    { channel: "signal", account: "ops", signalNumber: "+15550001" },
    { hasFlags: true, ...(beforePersistentEffect ? { beforePersistentEffect } : {}) },
  );
}

describe("channelsAddCommand", () => {
  beforeAll(async () => {
    ({ channelsAddCommand } = await import("./channels/add.js"));
    ({ runChannelsSetupWizard } = await import("./channels/add-wizard.js"));
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    policyMocks.readCurrentConfigForPolicyCheckAsync.mockReset().mockResolvedValue({});
    resetPluginRuntimeStateForTest();
    configFiles.clear();
    configMocks.readConfigFileSnapshot.mockResolvedValue({ ...baseConfigSnapshot });
    configMocks.replaceConfigFile
      .mockReset()
      .mockImplementation(async (params: { sourceConfig: unknown }) =>
        configMocks.writeConfigFile(params.sourceConfig),
      );
    commitInstalls
      .mockReset()
      .mockImplementation(async (params: { sourceConfig: OpenClawConfig }) => {
        await configMocks.writeConfigFile(params.sourceConfig);
        return {
          ...configFiles.write(params.sourceConfig),
          installRecords: {},
          movedInstallRecords: false,
        };
      });
    terminalMocks.isTerminalInteractive.mockReset().mockReturnValue(true);
    catalogMocks.getChannelPluginCatalogEntry.mockReturnValue(undefined);
    catalogMocks.listChannelPluginCatalogEntries.mockReturnValue([]);
    discoveryMocks.isCatalogChannelInstalled.mockReturnValue(false);
    bundledMocks.getBundledChannelPlugin.mockReset().mockReturnValue(undefined);
    bundledMocks.getBundledChannelSetupPlugin.mockReset().mockReturnValue(undefined);
    vi.mocked(ensureChannelSetupPluginInstalled)
      .mockReset()
      .mockImplementation(async ({ cfg }) => ({ cfg, installed: true, status: "installed" }));
    vi.mocked(loadChannelSetupPluginRegistrySnapshotForChannel)
      .mockReset()
      .mockResolvedValue(createTestRegistry());
    channelWizardMocks.setupChannels.mockReset().mockImplementation(async (cfg) => cfg);
    registerPlugin(createLifecycleChatAddTestPlugin());
  });

  afterEach(vi.unstubAllEnvs);

  it("points at the channel's help command when its setup contract omits --use-env", async () => {
    catalogMocks.listChannelPluginCatalogEntries.mockReturnValue([
      {
        ...createSetupOptionCatalogEntry("fixture-signal", "Signal", []),
        channel: {
          id: "fixture-signal",
          setup: {
            fields: [
              {
                key: "httpUrl",
                kind: "string",
                cli: { flags: "--http-url <url>", description: "Signal HTTP service URL" },
              },
            ],
          },
        },
      },
    ]);
    terminalMocks.isTerminalInteractive.mockReturnValue(false);
    await add({ channel: "fixture-signal" }, { hasFlags: false });

    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("openclaw channels add --channel fixture-signal --help"),
    );
    expect(runtime.error).not.toHaveBeenCalledWith(
      expect.stringContaining("channels add --channel <id> --use-env"),
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it.each(["direct", "gateway"] as const)(
    "keeps the original write ownership across awaited %s channel setup",
    async (flow) => {
      const cfg: OpenClawConfig = {
        gateway: { auth: { mode: "token", token: "at-read" } },
        agents: {
          ownership: "explicit",
          entries: { research: {} },
          defaults: { systemAgent: { agentId: "research" } },
        },
      };
      const snapshot = createTestConfigSnapshot(cfg);
      const writeOptions = {
        expectedConfigPath: snapshot.path,
        envSnapshotForRestore: { CHANNEL_SETUP_TOKEN: "at-read" },
      };
      configMocks.readConfigFileSnapshot.mockResolvedValue(snapshot);
      configMocks.readConfigFileSnapshotForWrite.mockResolvedValueOnce({ snapshot, writeOptions });
      vi.stubEnv("CHANNEL_SETUP_TOKEN", "at-read");
      const changeEnvironment = async () => {
        await Promise.resolve();
        vi.stubEnv("CHANNEL_SETUP_TOKEN", "after-await");
      };
      mockSetup(async (options) => {
        await changeEnvironment();
        options.onSelection?.(["lifecycle-chat"]);
        options.onAccountId?.("lifecycle-chat", "default");
        return cfg;
      });
      if (flow === "gateway") {
        await wizard({ channel: "lifecycle-chat", beforePersistentEffect: changeEnvironment });
      } else {
        await channelsAddCommand({ channel: "lifecycle-chat", token: "fixture-token" }, runtime, {
          hasFlags: flow === "direct",
          beforePersistentEffect: changeEnvironment,
        });
      }
      expect(process.env.CHANNEL_SETUP_TOKEN).toBe("after-await");
      expect(commitInstalls).toHaveBeenCalledWith(expect.objectContaining({ writeOptions }));
      expect(configMocks.writeConfigFile).toHaveBeenCalledOnce();
      expect(runtime.error).not.toHaveBeenCalled();
    },
  );

  it.each([
    { label: "whitespace-only", channel: " \t ", expectedChannel: "", interactive: true },
    {
      label: "unknown",
      channel: "unknown-channel",
      expectedChannel: "unknown-channel",
      interactive: false,
    },
  ])(
    "rejects an explicit $label guided selector when interactive=$interactive",
    async ({ channel, expectedChannel, interactive }) => {
      terminalMocks.isTerminalInteractive.mockReturnValue(interactive);

      await add({ channel }, { hasFlags: false });

      expect(runtime.error).toHaveBeenCalledWith(
        interactive
          ? `Unknown channel "${expectedChannel}". Run \`openclaw channels list --all\` to see configured and installable channels.`
          : expect.stringContaining("channels add --channel <id> --use-env"),
      );
      expect(runtime.exit).toHaveBeenCalledWith(1);
      expect(runtime.log).not.toHaveBeenCalled();
      expectNoWizardWrite();
    },
  );

  it("rejects an explicit unknown hosted selector before wizard effects", async () => {
    await expect(wizard({ channel: "unknown-channel" })).rejects.toThrow(
      'Unknown channel "unknown-channel". Run `openclaw channels list --all` to see configured and installable channels.',
    );

    expect(runtime.exit).not.toHaveBeenCalled();
    expectNoWizardWrite();
  });

  it("runChannelsSetupWizard renames the stored Signal account after hosted setup without creating a name-only account", async () => {
    const config: OpenClawConfig = { channels: { signal: signalAccounts("Old name") } };
    const plugin: ChannelPlugin = {
      ...createChannelTestPluginBase({
        id: "signal",
        config: { resolveAccount: readSignalAccount },
      }),
      setup: {
        applyAccountName: (params) =>
          applyAccountNameToChannelSection({ ...params, channelKey: "signal" }),
        applyAccountConfig: ({ cfg }) => cfg,
      },
    };
    const snapshot = createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: "signal",
          channels: ["signal"],
          channelAccountKeyPolicies: { signal: { canonicalAliasesRequireOwnField: "account" } },
        },
      ],
    });
    const resolveMetadata = vi
      .spyOn(pluginMetadata, "resolvePluginMetadataSnapshot")
      .mockReturnValue(snapshot);
    setConfig(config);
    mockSetup(async (options) => {
      options.onSelection?.(["signal"]);
      options.onAccountId?.("signal", "work-phone");
      options.onResolvedPlugin?.("signal", plugin);
      return config;
    });
    prompter.confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    prompter.text.mockResolvedValueOnce("Work calls");

    try {
      await using cache = createPluginCache();
      await withPluginCache(cache, () => wizard());

      expect(prompter.text).toHaveBeenCalledWith({
        message: 'signal display name for account "work-phone"',
        initialValue: "Old name",
      });
      expect(writtenChannel("signal")).toEqual(signalAccounts("Work calls"));
    } finally {
      resolveMetadata.mockRestore();
    }
  });

  it.each(["authority", "write"] as const)(
    "does not run guided hooks after %s rejection",
    async (failure) => {
      const hook = vi.fn(async () => {});
      const beforePersistentEffect = vi.fn(async () => {
        if (failure === "authority") {
          throw new Error("owner revoked");
        }
      });
      mockSetup(async (options, cfg) => {
        options.onPostWriteHook?.({ channel: "matrix", accountId: "ops", run: hook });
        return { ...cfg, messages: { responsePrefix: "configured" } };
      });
      if (failure === "write") {
        commitInstalls.mockRejectedValueOnce(new Error("write failed"));
      }

      await expect(add({}, { hasFlags: false, beforePersistentEffect })).rejects.toThrow(
        failure === "authority" ? "owner revoked" : "write failed",
      );

      expect(hook).not.toHaveBeenCalled();
      expect(beforePersistentEffect).toHaveBeenCalledOnce();
      expect(configMocks.writeConfigFile).not.toHaveBeenCalled();
      expect(commitInstalls).toHaveBeenCalledTimes(failure === "authority" ? 0 : 1);
    },
  );

  it("selects and carries an explicit multi-agent channel owner in the hosted wizard", async () => {
    const config = ownerConfig();
    setConfig(config);
    prompter.select.mockResolvedValueOnce({ agentId: "helper" }).mockResolvedValueOnce("main");
    policyMocks.readCurrentConfigForPolicyCheckAsync.mockResolvedValue(config);
    mockSetup(async (options, cfg) => {
      options.onSelection?.(["lifecycle-chat"]);
      options.onAccountId?.("lifecycle-chat", "ops");
      return cfg;
    });

    await wizard({ channel: "lifecycle-chat" });

    expect(setupOptions().workspaceDir).toBe("/tmp/openclaw-helper-workspace");
    expect(writtenConfig()).toMatchObject({
      bindings: [{ agentId: "main", match: { channel: "lifecycle-chat", accountId: "ops" } }],
    });
  });

  it.each(["invalid", "removed"] as const)(
    "rejects a hosted owner that is %s before setup",
    async (kind) => {
      const config = ownerConfig(kind === "invalid");
      setConfig(config);
      policyMocks.readCurrentConfigForPolicyCheckAsync.mockResolvedValue(config);
      const session = new WizardSession((sessionPrompter) =>
        runChannelsSetupWizard({ channel: "lifecycle-chat" }, runtime, sessionPrompter),
      );
      try {
        const selection = await session.next();
        expect(selection).toMatchObject({
          step: { type: "select", message: "Set up channels for agent" },
        });
        if (selection.done || !selection.step) {
          throw new Error("Expected owner selection step");
        }
        if (kind === "removed") {
          const currentConfig = ownerConfig(false);
          delete currentConfig.agents?.entries?.helper;
          policyMocks.readCurrentConfigForPolicyCheckAsync.mockResolvedValue(currentConfig);
        }
        await session.answer(selection.step.id, kind === "invalid" ? null : { agentId: "helper" });
        expect(await session.next()).toMatchObject({
          done: true,
          status: "error",
          error: expect.stringContaining(
            kind === "invalid"
              ? "Invalid channel setup owner selection"
              : 'Unknown agent id "helper"',
          ),
        });
        expect(channelWizardMocks.setupChannels).not.toHaveBeenCalled();
        expect(configMocks.writeConfigFile).not.toHaveBeenCalled();
      } finally {
        session.cancel();
        await session.whenSettled();
      }
    },
  );

  it("rejects --use-env when a declared env var is missing", async () => {
    vi.stubEnv("MULTI_CHAT_TOKEN", "token");
    vi.stubEnv("MULTI_CHAT_SECOND_TOKEN", "");
    registerEnvContractTestPlugin("multi-env-chat", [
      "MULTI_CHAT_TOKEN",
      "MULTI_CHAT_SECOND_TOKEN",
    ]);
    await add({ channel: "multi-env-chat", useEnv: true });
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("MULTI_CHAT_SECOND_TOKEN"));
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(configMocks.writeConfigFile).not.toHaveBeenCalled();
  });

  it("persists an accepted plugin install after setup returns to an empty selection", async () => {
    const config: OpenClawConfig = { channels: {} };
    const installedConfig: OpenClawConfig = {
      ...config,
      plugins: {
        entries: { "external-chat": { enabled: true } },
        installs: { "external-chat": { source: "npm", spec: "@vendor/external-chat@1.0.0" } },
      },
    };
    setConfig(config);
    channelWizardMocks.setupChannels.mockResolvedValueOnce(installedConfig);

    await add({}, { hasFlags: false });

    expect(configMocks.writeConfigFile).toHaveBeenCalledWith(installedConfig);
    expect(prompter.confirm).not.toHaveBeenCalled();
    expect(prompter.outro).toHaveBeenCalledWith("Channels updated.");
  });

  it("opens an exact channel id instead of an earlier plugin alias", async () => {
    const config: OpenClawConfig = { channels: {} };
    const aliasOwner = createChannelTestPluginBase({ id: "alias-owner", label: "Alias Owner" });
    registerPlugin({
      ...aliasOwner,
      meta: { ...aliasOwner.meta, aliases: ["exact-id"] },
    });
    setConfig(config);
    catalogMocks.listChannelPluginCatalogEntries.mockReturnValue([
      externalCatalog({
        id: "exact-id",
        meta: { id: "exact-id", label: "Exact ID", selectionLabel: "Exact ID" },
      }),
    ]);

    await add({ channel: "exact-id" }, { hasFlags: false });

    expect(setupOptions().initialSelection).toEqual(["exact-id"]);
    expect(setupOptions()).toMatchObject({ finishAfterInitialSelection: true });
  });

  it("exits quietly when guided channel setup is cancelled", async () => {
    const { WizardCancelledError } = await import("../wizard/prompts.js");
    setConfig({ channels: {} });
    channelWizardMocks.setupChannels.mockRejectedValue(new WizardCancelledError());

    await add({}, { hasFlags: false });

    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(runtime.error).not.toHaveBeenCalled();
    expect(configMocks.writeConfigFile).not.toHaveBeenCalled();
  });

  it("uses installed account policy through CLI persistence and post-write hooks while Gateway boot stays usable", async () => {
    const fixture = createInstallAccountPolicyFixture(
      tempDirs.make("cli-install-policy-"),
      "signal",
    );
    const config = fixture.config;
    await using bootCache = createPluginCache({ kind: "process" });
    const bootSnapshot = fixture.readMetadata();
    bindPluginMetadataSnapshotCache(bootSnapshot, bootCache);
    const bootInstance = new PluginInstance("gateway-boot");
    bootCache.instances.add(bootInstance);

    const bootPlugin = createChannelTestPluginBase({
      id: "signal",
      config: { resolveAccount: bootInstance.wrap(readSignalAccount) },
    });
    const bootRegistry = createTestRegistry([
      { pluginId: "signal", plugin: bootPlugin, source: "test" },
    ]);
    const readBoot = bootInstance.wrap(() => "Gateway available");
    const resolveMetadata = vi
      .spyOn(pluginMetadata, "resolvePluginMetadataSnapshot")
      .mockImplementation((params) => fixture.readMetadata(params.config, params.workspaceDir));
    setConfig(config);
    setActivePluginRegistry(createTestRegistry());
    catalogMocks.listChannelPluginCatalogEntries.mockReturnValue([
      externalCatalog({
        id: "signal",
        pluginId: "signal",
        meta: { id: "signal", label: "Signal" },
      }),
    ]);
    const events: string[] = [];
    const setupInstance = new PluginInstance("signal-setup");
    setupInstance.lifecycle.onDispose(() => {
      events.push("disposed");
    });
    const afterAccountConfigWritten = vi.fn(
      async ({ cfg, accountId }: Parameters<SignalAfterAccountConfigWritten>[0]) => {
        expect(hasPluginLifecycleLease()).toBe(false);
        expect(readSignalAccount(cfg, accountId)).toEqual(signalAccount("Work calls"));
        events.push("post-write");
      },
    );
    const setupPlugin = setupInstance.wrap<ChannelPlugin>({
      ...createChannelTestPluginBase({
        id: "signal",
        config: { resolveAccount: readSignalAccount },
      }),
      setup: {
        applyAccountConfig: ({ cfg, accountId, input }) =>
          applyAccountNameToChannelSection({
            cfg,
            accountId,
            name: input.name,
            channelKey: "signal",
          }),
        afterAccountConfigWritten,
      },
    });
    vi.mocked(ensureChannelSetupPluginInstalled).mockImplementationOnce(async ({ cfg }) => {
      expect(readSignalAccount(cfg, "work-phone")).toBeUndefined();
      await withPluginLifecycleLease({ env: fixture.env }, async () => {
        fixture.installPolicy();
        events.push("installed");
      });
      return { cfg, installed: true, status: "installed", pluginId: "signal" };
    });
    vi.mocked(loadChannelSetupPluginRegistrySnapshotForChannel).mockImplementationOnce(async () => {
      expect(hasPluginLifecycleLease()).toBe(false);
      getPluginCache().instances.add(setupInstance);
      expect(setupPlugin.config.resolveAccount(config, "work-phone")).toEqual(
        signalAccount("Old name"),
      );
      return createTestRegistry([{ pluginId: "signal", plugin: setupPlugin, source: "test" }]);
    });

    try {
      await using commandCache = createPluginCache();
      await withPluginCache(commandCache, async () => {
        await withPluginMetadataSnapshotScope(
          fixture.readMetadata(),
          () => add({ channel: "signal", account: "work-phone", name: "Work calls" }),
          { config },
        );
        expect(events).toEqual(["installed", "post-write"]);
        expect(afterAccountConfigWritten).toHaveBeenCalledOnce();
      });
      expect(writtenChannel("signal")).toEqual(signalAccounts("Work calls"));
      expect(runtime.error).not.toHaveBeenCalled();
      withPluginRuntimeGenerationScope(
        { metadataSnapshot: bootSnapshot, pluginRegistry: bootRegistry },
        () => {
          expect(bootRegistry.channels).toHaveLength(1);
          expect(bootPlugin.config.resolveAccount(config, "work-phone")).toBeUndefined();
          expect(readBoot()).toBe("Gateway available");
        },
      );
    } finally {
      resolveMetadata.mockRestore();
    }
  });

  it("normalizes external channel compatibility before a non-interactive write", async () => {
    registerPlugin(
      {
        ...createChannelTestPluginBase({ id: "qqbot", label: "QQ Bot" }),
        setup: {
          applyAccountConfig: ({ cfg, input }: ApplyAccountConfigParams) => {
            const [appId, clientSecret] = input.token?.split(":") ?? [];
            return withChannel(cfg, "qqbot", { appId, clientSecret, allowFrom: ["*"] });
          },
        },
      },
      "openclaw-qqbot",
    );

    await add({ channel: "qqbot", token: "app-id:secret" });

    expect(writtenChannel("qqbot")).toMatchObject({
      appId: "app-id",
      clientSecret: { source: "store", provider: "default", id: expect.any(String) },
      dmPolicy: "open",
      allowFrom: ["openclaw:approval-disabled"],
    });
  });

  it("uses the bundled setup fallback when snapshots only see a runtime plugin", async () => {
    registerPlugin(createChannelTestPluginBase({ id: "telegram", label: "Telegram" }));
    vi.mocked(getBundledChannelSetupPlugin).mockReturnValue({
      ...createChannelTestPluginBase({ id: "telegram", label: "Telegram" }),
      setup: {
        applyAccountConfig: ({ cfg, input }: ApplyAccountConfigParams) =>
          withChannel(cfg, "telegram", { enabled: true, botToken: input.token }),
      },
    });

    await add({ channel: "telegram", token: "123456:token" });

    expect(writtenChannel("telegram")).toMatchObject({
      enabled: true,
      botToken: { source: "store" },
    });
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("rejects malformed numeric channel setup options before plugin setup", async () => {
    const applyAccountConfig = setupOptionPlugin(
      "legacy-numeric",
      "matrix",
      [cliOption("--initial-sync-limit <n>", "int")],
      (input) => ({ initialSyncLimit: (input as MatrixSetupInput).initialSyncLimit }),
    );

    await expect(add({ channel: "legacy-numeric", initialSyncLimit: "10x" })).rejects.toThrow(
      "--initial-sync-limit must be a non-negative integer.",
    );

    expect(applyAccountConfig).not.toHaveBeenCalled();
    expect(configMocks.writeConfigFile).not.toHaveBeenCalled();
  });

  it("coerces list-valued channel setup options from delimited strings", async () => {
    setupOptionPlugin(
      "legacy-lists",
      "tlon",
      [cliOption("--group-channels <list>", "list"), cliOption("--dm-allowlist <list>", "list")],
      (input) => ({ groupChannels: input.groupChannels, dmAllowlist: input.dmAllowlist }),
    );

    await add({
      channel: "legacy-lists",
      groupChannels: "chat/~host/general, chat/~host/random",
      dmAllowlist: "~zod;~nec",
    });

    expect(writtenChannel("tlon")).toEqual({
      enabled: true,
      groupChannels: ["chat/~host/general", "chat/~host/random"],
      dmAllowlist: ["~zod", "~nec"],
    });
  });

  it.each([false, true])(
    "respects workspace catalog trust=%s when adding by alias",
    async (trusted) => {
      const pluginId = trusted ? "trusted-external-chat-shadow" : "evil-external-chat-shadow";
      const workspaceEntry = externalCatalog({
        pluginId,
        origin: "workspace",
        meta: { aliases: ["ext"] },
        install: { npmSpec: pluginId },
      });
      const bundledEntry = externalCatalog({ origin: "bundled", meta: { aliases: ["ext"] } });
      if (trusted) {
        configMocks.readConfigFileSnapshot.mockResolvedValue({
          ...baseConfigSnapshot,
          config: { plugins: { enabled: true, allow: [pluginId] } },
        });
      } else {
        catalogMocks.getChannelPluginCatalogEntry.mockImplementation(
          (_channel: string, opts?: { excludePluginRefs?: Array<{ pluginId: string }> }) =>
            opts?.excludePluginRefs?.some((entry) => entry.pluginId === pluginId)
              ? bundledEntry
              : undefined,
        );
      }
      setActivePluginRegistry(createTestRegistry());
      catalogMocks.listChannelPluginCatalogEntries.mockReturnValue([workspaceEntry]);
      const selectedPluginId = trusted ? pluginId : "@vendor/external-chat-plugin";
      registerExternalChatSetupPlugin(selectedPluginId);
      await add({ channel: "ext", account: "default", token: "tenant-scoped" });
      expect(installCall().entry).toBe(trusted ? workspaceEntry : bundledEntry);
      expect(installCall().promptInstall).toBe(false);
      expect(snapshotCall().pluginId).toBe(selectedPluginId);
      expect(writtenChannel("external-chat").enabled).toBe(true);
      expect(runtime.error).not.toHaveBeenCalled();
      expect(runtime.exit).not.toHaveBeenCalled();
    },
  );

  it("runs post-setup hooks after writing config and keeps saved config on hook failure", async () => {
    const afterAccountConfigWritten = vi.fn().mockResolvedValue(undefined);
    await runSignalAddCommand(afterAccountConfigWritten);

    expect(configMocks.writeConfigFile).toHaveBeenCalledTimes(1);
    expect(afterAccountConfigWritten).toHaveBeenCalledTimes(1);
    expect(configMocks.writeConfigFile.mock.invocationCallOrder[0]).toBeLessThan(
      afterAccountConfigWritten.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    const hookCall = requireRecord(afterAccountConfigWritten.mock.calls[0]?.[0], "hook call");
    expect(hookCall.previousCfg).toBe(baseConfigSnapshot.config);
    expect(requireRecord(hookCall.cfg, "hook config").channels).toEqual({
      signal: { enabled: true, accounts: { ops: { account: "+15550001" } } },
    });
    expect(hookCall.accountId).toBe("ops");
    expect(requireRecord(hookCall.input, "hook input").signalNumber).toBe("+15550001");
    expect(hookCall.runtime).toBe(runtime);

    configMocks.writeConfigFile.mockClear();
    runtime.error.mockClear();
    runtime.exit.mockClear();
    const failingHook = vi.fn().mockRejectedValue(new Error("hook failed"));
    await runSignalAddCommand(failingHook);

    expect(configMocks.writeConfigFile).toHaveBeenCalledTimes(1);
    expect(runtime.exit).not.toHaveBeenCalled();
    expect(runtime.error).toHaveBeenCalledWith(
      'Channel signal post-setup warning for "ops": hook failed',
    );
  });

  it("rechecks persistent authority before direct account post-setup hooks", async () => {
    const afterAccountConfigWritten = vi.fn().mockResolvedValue(undefined);
    const beforePersistentEffect = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("inference authority changed"));

    await expect(
      runSignalAddCommand(afterAccountConfigWritten, beforePersistentEffect),
    ).rejects.toThrow("inference authority changed");

    expect(configMocks.writeConfigFile).toHaveBeenCalledTimes(1);
    expect(beforePersistentEffect).toHaveBeenCalledTimes(2);
    expect(afterAccountConfigWritten).not.toHaveBeenCalled();
  });
});
