// Channels add tests cover guided setup, plugin install paths, and channel account config writes.
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

const catalogMocks = vi.hoisted(() => ({
  getChannelPluginCatalogEntry: vi.fn(),
  listChannelPluginCatalogEntries: vi.fn((): ChannelPluginCatalogEntry[] => []),
}));

const discoveryMocks = vi.hoisted(() => ({
  isCatalogChannelInstalled: vi.fn(() => false),
}));

const pluginInstallMocks = vi.hoisted(() => ({
  ensureChannelSetupPluginInstalled: vi.fn(),
  loadChannelSetupPluginRegistrySnapshotForChannel: vi.fn(),
}));

const registryRefreshMocks = vi.hoisted(() => ({
  refreshPluginRegistryAfterConfigMutation: vi.fn<
    typeof import("../plugins/registry-refresh.js").refreshPluginRegistryAfterConfigMutation
  >(async () => undefined),
}));

const pluginInstallRecordCommitMocks = vi.hoisted(() => ({
  commitConfigWithPendingPluginInstalls: vi.fn(),
}));

const terminalMocks = vi.hoisted(() => ({
  isTerminalInteractive: vi.fn(() => true),
}));

const policyMocks = vi.hoisted(() => ({
  readCurrentConfigForPolicyCheckAsync: vi.fn<() => Promise<OpenClawConfig>>(async () => ({})),
}));

vi.mock("../config/io.runtime.js", () => policyMocks);

const channelWizardMocks = vi.hoisted(() => {
  const prompter = {
    intro: vi.fn(async () => undefined),
    outro: vi.fn(async () => undefined),
    confirm: vi.fn(async () => false),
    note: vi.fn(async () => undefined),
    select: vi.fn(),
    multiselect: vi.fn(async () => []),
    text: vi.fn(),
    progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
  };
  return {
    prompter,
    setupChannels: vi.fn(async (...args: unknown[]) => args[0] as OpenClawConfig),
  };
});

const bundledMocks = vi.hoisted(() => ({
  getBundledChannelPlugin: vi.fn(() => undefined),
  getBundledChannelSetupPlugin: vi.fn(() => undefined),
}));

vi.mock("../channels/plugins/catalog.js", () => ({
  getChannelPluginCatalogEntry: catalogMocks.getChannelPluginCatalogEntry,
  listRawChannelPluginCatalogEntries: catalogMocks.listChannelPluginCatalogEntries,
}));

vi.mock("./channel-setup/discovery.js", async () => {
  const actual = await vi.importActual<typeof import("./channel-setup/discovery.js")>(
    "./channel-setup/discovery.js",
  );
  return {
    ...actual,
    isCatalogChannelInstalled: discoveryMocks.isCatalogChannelInstalled,
  };
});

vi.mock("../channels/plugins/bundled.js", async () => {
  const actual = await vi.importActual<typeof import("../channels/plugins/bundled.js")>(
    "../channels/plugins/bundled.js",
  );
  return {
    ...actual,
    getBundledChannelPlugin: bundledMocks.getBundledChannelPlugin,
    getBundledChannelSetupPlugin: bundledMocks.getBundledChannelSetupPlugin,
  };
});

vi.mock("./channel-setup/plugin-install.js", () => pluginInstallMocks);

vi.mock("../plugins/registry-refresh.js", () => registryRefreshMocks);

vi.mock("../plugins/install-record-commit.js", () => pluginInstallRecordCommitMocks);

vi.mock("../cli/terminal-interactivity.js", () => terminalMocks);

vi.mock("../wizard/clack-prompter.js", () => ({
  createClackPrompter: () => channelWizardMocks.prompter,
}));

vi.mock("../flows/channel-setup.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../flows/channel-setup.js")>();
  return {
    ...actual,
    setupChannels: (...args: Parameters<typeof actual.setupChannels>) =>
      channelWizardMocks.setupChannels(...args),
  };
});

const runtime = createTestRuntime();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

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
    meta: {
      id,
      label,
      selectionLabel: label,
      docsPath: `/channels/${id}`,
      blurb: `${label} test channel.`,
    },
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
function setupChannelArg(index: number) {
  return channelWizardMocks.setupChannels.mock.calls[0]?.[index];
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
function refreshCall() {
  return requireRecord(
    registryRefreshMocks.refreshPluginRegistryAfterConfigMutation.mock.calls[0]?.[0],
    "refresh",
  );
}
function expectExternalChatEnabledConfigWrite() {
  expect(writtenChannel("external-chat").enabled).toBe(true);
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

function setMinimalChannelsAddRegistryForTests(): void {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "lifecycle-chat",
        plugin: createLifecycleChatAddTestPlugin(),
        source: "test",
      },
    ]),
  );
}

function registerExternalChatSetupPlugin(pluginId = "@vendor/external-chat-plugin"): void {
  vi.mocked(loadChannelSetupPluginRegistrySnapshotForChannel).mockReturnValue(
    createTestRegistry([{ pluginId, plugin: createExternalChatSetupPlugin(), source: "test" }]),
  );
}

function registerEnvContractTestPlugin(channelId: string, envVars: readonly string[]): void {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: channelId,
        plugin: {
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
              applyAccountConfig: ({ cfg }) => ({
                ...cfg,
                channels: {
                  ...cfg.channels,
                  [channelId]: { enabled: true },
                },
              }),
            },
          }),
        } as ChannelPlugin,
        source: "test",
      },
    ]),
  );
}

type SignalAfterAccountConfigWritten = NonNullable<
  NonNullable<ChannelPlugin["setup"]>["afterAccountConfigWritten"]
>;
type ApplyAccountConfigParams = Parameters<
  NonNullable<NonNullable<ChannelPlugin["setup"]>["applyAccountConfig"]>
>[0];
type SignalSetupInput = ChannelSetupInput & { signalNumber?: string };
type MatrixSetupInput = ChannelSetupInput & { initialSyncLimit?: number };

function createSignalPlugin(
  afterAccountConfigWritten: SignalAfterAccountConfigWritten,
): ChannelPlugin {
  return {
    ...createChannelTestPluginBase({
      id: "signal",
      label: "Signal",
    }),
    setup: {
      applyAccountConfig: ({ cfg, accountId, input }) => ({
        ...cfg,
        channels: {
          ...cfg.channels,
          signal: {
            enabled: true,
            accounts: {
              [accountId]: {
                account: (input as SignalSetupInput).signalNumber,
              },
            },
          },
        },
      }),
      afterAccountConfigWritten,
    },
  } as ChannelPlugin;
}

async function runSignalAddCommand(
  afterAccountConfigWritten: SignalAfterAccountConfigWritten,
  beforePersistentEffect?: () => Promise<void>,
) {
  const plugin = createSignalPlugin(afterAccountConfigWritten);
  setActivePluginRegistry(createTestRegistry([{ pluginId: "signal", plugin, source: "test" }]));
  configMocks.readConfigFileSnapshot.mockResolvedValue({ ...baseConfigSnapshot });
  await channelsAddCommand(
    { channel: "signal", account: "ops", signalNumber: "+15550001" },
    runtime,
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
    configMocks.replaceConfigFile
      .mockReset()
      .mockImplementation(async (params: { sourceConfig: unknown }) => {
        await configMocks.writeConfigFile(params.sourceConfig);
      });
    pluginInstallRecordCommitMocks.commitConfigWithPendingPluginInstalls.mockReset();
    pluginInstallRecordCommitMocks.commitConfigWithPendingPluginInstalls.mockImplementation(
      async (params: { sourceConfig: OpenClawConfig }) => {
        await configMocks.writeConfigFile(params.sourceConfig);
        return {
          ...configFiles.write(params.sourceConfig),
          installRecords: {},
          movedInstallRecords: false,
        };
      },
    );
    terminalMocks.isTerminalInteractive.mockReset().mockReturnValue(true);
    catalogMocks.getChannelPluginCatalogEntry.mockReturnValue(undefined);
    catalogMocks.listChannelPluginCatalogEntries.mockReturnValue([]);
    discoveryMocks.isCatalogChannelInstalled.mockReturnValue(false);
    bundledMocks.getBundledChannelPlugin.mockReset();
    bundledMocks.getBundledChannelPlugin.mockReturnValue(undefined);
    bundledMocks.getBundledChannelSetupPlugin.mockReset();
    bundledMocks.getBundledChannelSetupPlugin.mockReturnValue(undefined);
    vi.mocked(ensureChannelSetupPluginInstalled).mockReset();
    vi.mocked(ensureChannelSetupPluginInstalled).mockImplementation(async ({ cfg }) => ({
      cfg,
      installed: true,
      status: "installed",
    }));
    vi.mocked(loadChannelSetupPluginRegistrySnapshotForChannel).mockReset();
    vi.mocked(loadChannelSetupPluginRegistrySnapshotForChannel).mockReturnValue(
      createTestRegistry(),
    );
    channelWizardMocks.setupChannels
      .mockReset()
      .mockImplementation(async (...args: unknown[]) => args[0] as OpenClawConfig);
    setMinimalChannelsAddRegistryForTests();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
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
      channelWizardMocks.setupChannels.mockImplementationOnce(async (...args: unknown[]) => {
        await changeEnvironment();
        const options = args[3] as SetupChannelsOptions;
        options.onSelection?.(["lifecycle-chat"]);
        options.onAccountId?.("lifecycle-chat", "default");
        return cfg;
      });
      if (flow === "gateway") {
        await runChannelsSetupWizard(
          { channel: "lifecycle-chat", beforePersistentEffect: changeEnvironment },
          runtime,
          channelWizardMocks.prompter,
        );
      } else {
        await channelsAddCommand({ channel: "lifecycle-chat", token: "fixture-token" }, runtime, {
          hasFlags: flow === "direct",
          beforePersistentEffect: changeEnvironment,
        });
      }
      expect(process.env.CHANNEL_SETUP_TOKEN).toBe("after-await");
      expect(
        pluginInstallRecordCommitMocks.commitConfigWithPendingPluginInstalls,
      ).toHaveBeenCalledWith(expect.objectContaining({ writeOptions }));
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
      configMocks.readConfigFileSnapshot.mockResolvedValue({ ...baseConfigSnapshot });

      await channelsAddCommand({ channel }, runtime, { hasFlags: false });

      expect(runtime.error).toHaveBeenCalledWith(
        interactive
          ? `Unknown channel "${expectedChannel}". Run \`openclaw channels list --all\` to see configured and installable channels.`
          : expect.stringContaining("channels add --channel <id> --use-env"),
      );
      expect(runtime.exit).toHaveBeenCalledWith(1);
      expect(runtime.log).not.toHaveBeenCalled();
      expect(channelWizardMocks.prompter.intro).not.toHaveBeenCalled();
      expect(channelWizardMocks.setupChannels).not.toHaveBeenCalled();
      expect(configMocks.writeConfigFile).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      label: "unknown",
      channel: "unknown-channel",
      expectedChannel: "unknown-channel",
    },
  ])(
    "rejects an explicit $label hosted selector before wizard effects",
    async ({ channel, expectedChannel }) => {
      configMocks.readConfigFileSnapshot.mockResolvedValue({ ...baseConfigSnapshot });

      await expect(
        runChannelsSetupWizard({ channel }, runtime, channelWizardMocks.prompter),
      ).rejects.toThrow(
        `Unknown channel "${expectedChannel}". Run \`openclaw channels list --all\` to see configured and installable channels.`,
      );

      expect(runtime.exit).not.toHaveBeenCalled();
      expect(channelWizardMocks.prompter.intro).not.toHaveBeenCalled();
      expect(channelWizardMocks.setupChannels).not.toHaveBeenCalled();
      expect(configMocks.writeConfigFile).not.toHaveBeenCalled();
    },
  );

  it("runChannelsSetupWizard renames the stored Signal account after hosted setup without creating a name-only account", async () => {
    const config: OpenClawConfig = {
      channels: {
        signal: {
          accounts: { "Work Phone": { account: "+12025550123", name: "Old name" } },
        },
      },
    };
    const plugin: ChannelPlugin = {
      ...createChannelTestPluginBase({
        id: "signal",
        config: {
          resolveAccount: (cfg, accountId) =>
            resolveChannelAccountEntry(
              cfg.channels?.signal?.accounts,
              normalizeAccountId(accountId),
              "signal",
            ),
        },
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
          channelAccountKeyPolicies: {
            signal: { canonicalAliasesRequireOwnField: "account" },
          },
        },
      ],
    });
    const resolveMetadata = vi
      .spyOn(pluginMetadata, "resolvePluginMetadataSnapshot")
      .mockReturnValue(snapshot);
    configMocks.readConfigFileSnapshot.mockResolvedValue(createTestConfigSnapshot(config));
    channelWizardMocks.setupChannels.mockImplementationOnce(async (...args: unknown[]) => {
      const options = args[3] as SetupChannelsOptions;
      options.onSelection?.(["signal"]);
      options.onAccountId?.("signal", "work-phone");
      options.onResolvedPlugin?.("signal", plugin);
      return config;
    });
    channelWizardMocks.prompter.confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    channelWizardMocks.prompter.text.mockResolvedValueOnce("Work calls");

    try {
      await using cache = createPluginCache();
      await withPluginCache(cache, () =>
        runChannelsSetupWizard({}, runtime, channelWizardMocks.prompter),
      );

      expect(channelWizardMocks.prompter.text).toHaveBeenCalledWith({
        message: 'signal display name for account "work-phone"',
        initialValue: "Old name",
      });
      expect(writtenChannel("signal")).toEqual({
        accounts: { "Work Phone": { account: "+12025550123", name: "Work calls" } },
      });
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
      channelWizardMocks.setupChannels.mockImplementationOnce(async (...args: unknown[]) => {
        const options = args[3] as SetupChannelsOptions;
        options.onPostWriteHook?.({ channel: "matrix", accountId: "ops", run: hook });
        return { ...(args[0] as OpenClawConfig), messages: { responsePrefix: "configured" } };
      });
      if (failure === "write") {
        pluginInstallRecordCommitMocks.commitConfigWithPendingPluginInstalls.mockRejectedValueOnce(
          new Error("write failed"),
        );
      }

      await expect(
        channelsAddCommand({}, runtime, { hasFlags: false, beforePersistentEffect }),
      ).rejects.toThrow(failure === "authority" ? "owner revoked" : "write failed");

      expect(hook).not.toHaveBeenCalled();
      expect(beforePersistentEffect).toHaveBeenCalledOnce();
      expect(configMocks.writeConfigFile).not.toHaveBeenCalled();
      expect(
        pluginInstallRecordCommitMocks.commitConfigWithPendingPluginInstalls,
      ).toHaveBeenCalledTimes(failure === "authority" ? 0 : 1);
    },
  );

  it.each(["ext"])("preselects a hosted catalog channel from the %s selector", async (channel) => {
    const config: OpenClawConfig = { channels: {} };
    configMocks.readConfigFileSnapshot.mockResolvedValue(createTestConfigSnapshot(config));
    catalogMocks.listChannelPluginCatalogEntries.mockReturnValue([
      {
        ...createExternalChatCatalogEntry(),
        origin: "bundled",
        trustedSourceLinkedOfficialInstall: true,
        meta: { ...createExternalChatCatalogEntry().meta, aliases: ["ext"] },
      },
    ]);

    await runChannelsSetupWizard({ channel }, runtime, channelWizardMocks.prompter);

    expect(setupOptions().initialSelection).toEqual(["external-chat"]);
    expect(setupOptions().finishAfterInitialSelection).toBe(true);
    expect(setupOptions().deferDeviceLinkToClient).toBe(true);
  });

  it("selects and carries an explicit multi-agent channel owner in the hosted wizard", async () => {
    const config: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        entries: {
          main: { workspace: "/tmp/openclaw-main-workspace" },
          helper: { workspace: "/tmp/openclaw-helper-workspace" },
        },
      },
      channels: {},
    };
    configMocks.readConfigFileSnapshot.mockResolvedValue(createTestConfigSnapshot(config));
    channelWizardMocks.prompter.select
      .mockResolvedValueOnce({ agentId: "helper" })
      .mockResolvedValueOnce("main");
    policyMocks.readCurrentConfigForPolicyCheckAsync.mockResolvedValue(config);
    channelWizardMocks.setupChannels.mockImplementationOnce(async (...args: unknown[]) => {
      const options = requireRecord(args[3], "setup options");
      const onSelection = options.onSelection as ((selection: string[]) => void) | undefined;
      const onAccountId = options.onAccountId as
        | ((channel: string, accountId: string) => void)
        | undefined;
      onSelection?.(["lifecycle-chat"]);
      onAccountId?.("lifecycle-chat", "ops");
      return args[0] as OpenClawConfig;
    });

    await runChannelsSetupWizard(
      { channel: "lifecycle-chat" },
      runtime,
      channelWizardMocks.prompter,
    );

    expect(channelWizardMocks.prompter.select).toHaveBeenCalledTimes(2);
    expect(channelWizardMocks.prompter.select.mock.calls[0]?.[0]).toEqual({
      message: "Set up channels for agent",
      options: [
        { value: { agentId: "main" }, label: "main" },
        { value: { agentId: "helper" }, label: "helper" },
      ],
    });
    expect(setupOptions().workspaceDir).toBe("/tmp/openclaw-helper-workspace");
    expect(writtenConfig()).toMatchObject({
      bindings: [
        {
          agentId: "main",
          match: { channel: "lifecycle-chat", accountId: "ops" },
        },
      ],
    });
  });

  it.each([{ answer: null, error: "Invalid channel setup owner selection" }])(
    "rejects invalid hosted owner $answer before setup",
    async ({ answer, error }) => {
      const config: OpenClawConfig = {
        agents: {
          ownership: "explicit",
          entries: {
            main: { workspace: "/tmp/openclaw-main-workspace" },
            helper: { workspace: "/tmp/openclaw-helper-workspace" },
          },
        },
        channels: {},
      };
      configMocks.readConfigFileSnapshot.mockResolvedValue(createTestConfigSnapshot(config));
      policyMocks.readCurrentConfigForPolicyCheckAsync.mockResolvedValue(config);
      const session = new WizardSession(async (prompter) => {
        await runChannelsSetupWizard({ channel: "lifecycle-chat" }, runtime, prompter);
      });

      const selection = await session.next();
      expect(selection).toMatchObject({
        step: { type: "select", message: "Set up channels for agent" },
      });
      if (selection.done || !selection.step) {
        throw new Error("Expected agent selection step");
      }
      try {
        await session.answer(selection.step.id, answer);
        expect(await session.next()).toMatchObject({
          done: true,
          status: "error",
          error: expect.stringContaining(error),
        });
        expect(channelWizardMocks.setupChannels).not.toHaveBeenCalled();
        expect(configMocks.writeConfigFile).not.toHaveBeenCalled();
      } finally {
        session.cancel();
        await session.whenSettled();
      }
    },
  );

  it("rejects an owner removed while the hosted selection is pending", async () => {
    const config: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        entries: {
          main: { workspace: "/tmp/openclaw-main-workspace" },
          helper: { workspace: "/tmp/openclaw-helper-workspace" },
        },
      },
    };
    configMocks.readConfigFileSnapshot.mockResolvedValue(createTestConfigSnapshot(config));
    policyMocks.readCurrentConfigForPolicyCheckAsync.mockResolvedValue(config);
    const session = new WizardSession(async (prompter) => {
      await runChannelsSetupWizard({ channel: "lifecycle-chat" }, runtime, prompter);
    });
    try {
      const selection = await session.next();
      if (selection.done || !selection.step) {
        throw new Error("Expected owner selection step");
      }
      policyMocks.readCurrentConfigForPolicyCheckAsync.mockResolvedValue({
        agents: {
          ownership: "explicit",
          entries: { main: { workspace: "/tmp/openclaw-main-workspace" } },
        },
      });
      await session.answer(selection.step.id, { agentId: "helper" });
      expect(await session.next()).toMatchObject({
        done: true,
        status: "error",
        error: expect.stringContaining('Unknown agent id "helper"'),
      });
      expect(channelWizardMocks.setupChannels).not.toHaveBeenCalled();
      expect(configMocks.writeConfigFile).not.toHaveBeenCalled();
    } finally {
      session.cancel();
      await session.whenSettled();
    }
  });

  it.each([
    {
      channel: "multi-env-chat",
      env: { MULTI_CHAT_TOKEN: "token", MULTI_CHAT_SECOND_TOKEN: "" },
      missing: ["MULTI_CHAT_SECOND_TOKEN"],
    },
  ])("rejects $channel --use-env when declared env vars are missing", async (testCase) => {
    for (const [name, value] of Object.entries(testCase.env)) {
      vi.stubEnv(name, value);
    }
    registerEnvContractTestPlugin(testCase.channel, Object.keys(testCase.env));
    configMocks.readConfigFileSnapshot.mockResolvedValue({ ...baseConfigSnapshot });

    await channelsAddCommand({ channel: testCase.channel, useEnv: true }, runtime, {
      hasFlags: true,
    });

    for (const missing of testCase.missing) {
      expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining(missing));
    }
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(configMocks.writeConfigFile).not.toHaveBeenCalled();
  });

  it("keeps guided channel setup lazy until the user selects a channel", async () => {
    const config: OpenClawConfig = { channels: {} };
    configMocks.readConfigFileSnapshot.mockResolvedValue(createTestConfigSnapshot(config));

    await channelsAddCommand({}, runtime, { hasFlags: false });

    expect(channelWizardMocks.prompter.intro).toHaveBeenCalledWith("Channel setup");
    expect(setupChannelArg(0)).toBe(config);
    expect(setupChannelArg(1)).toBe(runtime);
    expect(setupChannelArg(2)).toBe(channelWizardMocks.prompter);
    expect(setupOptions().deferStatusUntilSelection).toBe(true);
    expect(setupOptions().skipStatusNote).toBe(true);
    expect(setupOptions().promptAccountIds).toBe(true);
    expect(configMocks.writeConfigFile).not.toHaveBeenCalled();
    expect(channelWizardMocks.prompter.outro).toHaveBeenCalledWith("No channel changes made.");
  });

  it("persists an accepted plugin install after setup returns to an empty selection", async () => {
    const config: OpenClawConfig = { channels: {} };
    const installedConfig: OpenClawConfig = {
      ...config,
      plugins: {
        entries: { "external-chat": { enabled: true } },
        installs: {
          "external-chat": {
            source: "npm",
            spec: "@vendor/external-chat@1.0.0",
          },
        },
      },
    };
    configMocks.readConfigFileSnapshot.mockResolvedValue(createTestConfigSnapshot(config));
    channelWizardMocks.setupChannels.mockResolvedValueOnce(installedConfig);

    await channelsAddCommand({}, runtime, { hasFlags: false });

    expect(
      pluginInstallRecordCommitMocks.commitConfigWithPendingPluginInstalls,
    ).toHaveBeenCalledWith(expect.objectContaining({ sourceConfig: installedConfig }));
    expect(
      pluginInstallRecordCommitMocks.commitConfigWithPendingPluginInstalls,
    ).toHaveBeenCalledOnce();
    expect(configMocks.writeConfigFile).toHaveBeenCalledWith(installedConfig);
    expect(channelWizardMocks.prompter.confirm).not.toHaveBeenCalled();
    expect(channelWizardMocks.prompter.outro).toHaveBeenCalledWith("Channels updated.");
  });

  it("opens an exact channel id instead of an earlier plugin alias", async () => {
    const config: OpenClawConfig = { channels: {} };
    const aliasOwner = createChannelTestPluginBase({
      id: "alias-owner",
      label: "Alias Owner",
    });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "alias-owner",
          plugin: {
            ...aliasOwner,
            meta: { ...aliasOwner.meta, aliases: ["exact-id"] },
          },
          source: "test",
        },
      ]),
    );
    configMocks.readConfigFileSnapshot.mockResolvedValue(createTestConfigSnapshot(config));
    catalogMocks.listChannelPluginCatalogEntries.mockReturnValue([
      {
        ...createExternalChatCatalogEntry(),
        id: "exact-id",
        meta: {
          ...createExternalChatCatalogEntry().meta,
          id: "exact-id",
          label: "Exact ID",
          selectionLabel: "Exact ID",
        },
      },
    ]);

    await channelsAddCommand({ channel: "exact-id" }, runtime, { hasFlags: false });

    expect(setupOptions().initialSelection).toEqual(["exact-id"]);
    expect(setupOptions().finishAfterInitialSelection).toBe(true);
  });

  it("exits quietly when guided channel setup is cancelled", async () => {
    const { WizardCancelledError } = await import("../wizard/prompts.js");
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseConfigSnapshot,
      sourceConfig: { channels: {} },
      config: { channels: {} },
    });
    channelWizardMocks.setupChannels.mockRejectedValue(new WizardCancelledError());

    await channelsAddCommand({}, runtime, { hasFlags: false });

    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(runtime.error).not.toHaveBeenCalled();
    expect(configMocks.writeConfigFile).not.toHaveBeenCalled();
  });

  it("uses channel-owned setup parsing for bundled plugins", async () => {
    const applyAccountConfig = vi.fn(({ cfg, input }) => ({
      ...cfg,
      channels: {
        ...cfg.channels,
        "typed-chat": {
          token: input.token,
          port: input.port,
        },
      },
    }));
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "typed-chat",
          plugin: {
            ...createChannelTestPluginBase({ id: "typed-chat", label: "Typed Chat" }),
            setupContract: defineChannelSetupContract({
              fields: {
                token: {
                  kind: "string",
                  cli: { flags: "--token <token>", description: "Bot token" },
                },
                port: {
                  kind: "integer",
                  cli: { flags: "--port <port>", description: "HTTP port" },
                },
              },
              adapter: { applyAccountConfig },
            }),
          } as ChannelPlugin,
          source: "test",
        },
      ]),
    );
    configMocks.readConfigFileSnapshot.mockResolvedValue({ ...baseConfigSnapshot });

    await channelsAddCommand(
      { channel: "typed-chat", agent: "main", token: "secret", port: "8080" },
      runtime,
      {
        hasFlags: true,
      },
    );

    expect(writtenChannel("typed-chat")).toEqual({ token: "secret", port: 8080 });
    expect(applyAccountConfig).toHaveBeenCalledWith({
      cfg: baseConfigSnapshot.config,
      accountId: "default",
      input: { token: "secret", port: 8080 },
    });
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
    const readAccount: ChannelPlugin["config"]["resolveAccount"] = (cfg, accountId) =>
      resolveChannelAccountEntry(
        cfg.channels?.signal?.accounts,
        normalizeAccountId(accountId),
        "signal",
      );
    const bootPlugin = createChannelTestPluginBase({
      id: "signal",
      config: { resolveAccount: bootInstance.wrap(readAccount) },
    });
    const bootRegistry = createTestRegistry([
      { pluginId: "signal", plugin: bootPlugin, source: "test" },
    ]);
    const readBoot = bootInstance.wrap(() => "Gateway available");
    const resolveMetadata = vi
      .spyOn(pluginMetadata, "resolvePluginMetadataSnapshot")
      .mockImplementation((params) => fixture.readMetadata(params.config, params.workspaceDir));
    configMocks.readConfigFileSnapshot.mockResolvedValue(createTestConfigSnapshot(config));
    setActivePluginRegistry(createTestRegistry());
    catalogMocks.listChannelPluginCatalogEntries.mockReturnValue([
      {
        ...createExternalChatCatalogEntry(),
        id: "signal",
        pluginId: "signal",
        meta: { ...createExternalChatCatalogEntry().meta, id: "signal", label: "Signal" },
      },
    ]);
    const events: string[] = [];
    const setupInstance = new PluginInstance("signal-setup");
    setupInstance.lifecycle.onDispose(() => {
      events.push("disposed");
    });
    const afterAccountConfigWritten = vi.fn(
      async ({ cfg, accountId }: Parameters<SignalAfterAccountConfigWritten>[0]) => {
        expect(hasPluginLifecycleLease()).toBe(false);
        expect(readAccount(cfg, accountId)).toEqual({
          account: "+12025550123",
          name: "Work calls",
        });
        events.push("post-write");
      },
    );
    const setupPlugin = setupInstance.wrap<ChannelPlugin>({
      ...createChannelTestPluginBase({ id: "signal", config: { resolveAccount: readAccount } }),
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
      expect(readAccount(cfg, "work-phone")).toBeUndefined();
      await withPluginLifecycleLease({ env: fixture.env }, async () => {
        fixture.installPolicy();
        events.push("installed");
      });
      return { cfg, installed: true, status: "installed", pluginId: "signal" };
    });
    vi.mocked(loadChannelSetupPluginRegistrySnapshotForChannel).mockImplementationOnce(() => {
      expect(hasPluginLifecycleLease()).toBe(false);
      getPluginCache().instances.add(setupInstance);
      expect(setupPlugin.config.resolveAccount(config, "work-phone")).toEqual({
        account: "+12025550123",
        name: "Old name",
      });
      return createTestRegistry([{ pluginId: "signal", plugin: setupPlugin, source: "test" }]);
    });

    try {
      await using commandCache = createPluginCache();
      await withPluginCache(commandCache, async () => {
        const beforeInstall = fixture.readMetadata();
        await withPluginMetadataSnapshotScope(
          beforeInstall,
          () =>
            channelsAddCommand(
              { channel: "signal", account: "work-phone", name: "Work calls" },
              runtime,
              { hasFlags: true },
            ),
          { config },
        );
        expect(events).toEqual(["installed", "post-write"]);
        expect(afterAccountConfigWritten).toHaveBeenCalledOnce();
      });
      expect(writtenChannel("signal")).toEqual({
        accounts: { "Work Phone": { account: "+12025550123", name: "Work calls" } },
      });
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

  it("loads external channel setup snapshots for newly installed and existing plugins", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({ ...baseConfigSnapshot });
    setActivePluginRegistry(createTestRegistry());
    const catalogEntry = createExternalChatCatalogEntry();
    catalogMocks.listChannelPluginCatalogEntries.mockReturnValue([catalogEntry]);
    registerExternalChatSetupPlugin("external-chat");

    await channelsAddCommand(
      {
        channel: "external-chat",
        account: "default",
        token: "tenant-scoped",
      },
      runtime,
      { hasFlags: true },
    );

    expect(installCall().entry).toBe(catalogEntry);
    expect(installCall().promptInstall).toBe(false);
    expect(loadChannelSetupPluginRegistrySnapshotForChannel).toHaveBeenCalledTimes(1);
    expect(snapshotCall().forceSetupOnlyChannelPlugins).toBe(true);
    expect(refreshCall().reason).toBe("source-changed");
    expectExternalChatEnabledConfigWrite();
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();

    vi.mocked(ensureChannelSetupPluginInstalled).mockClear();
    vi.mocked(loadChannelSetupPluginRegistrySnapshotForChannel).mockClear();
    configMocks.writeConfigFile.mockClear();
    discoveryMocks.isCatalogChannelInstalled.mockReturnValue(true);

    await channelsAddCommand(
      {
        channel: "external-chat",
        account: "default",
        token: "tenant-installed",
      },
      runtime,
      { hasFlags: true },
    );

    expect(ensureChannelSetupPluginInstalled).not.toHaveBeenCalled();
    expect(loadChannelSetupPluginRegistrySnapshotForChannel).toHaveBeenCalledTimes(1);
    expect(snapshotCall().forceSetupOnlyChannelPlugins).toBe(true);
    expectExternalChatEnabledConfigWrite();
  });

  it("normalizes external channel compatibility before a non-interactive write", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({ ...baseConfigSnapshot });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "openclaw-qqbot",
          plugin: {
            ...createChannelTestPluginBase({ id: "qqbot", label: "QQ Bot" }),
            setup: {
              applyAccountConfig: ({ cfg, input }: ApplyAccountConfigParams) => {
                const [appId, clientSecret] = input.token?.split(":") ?? [];
                return {
                  ...cfg,
                  channels: {
                    ...cfg.channels,
                    qqbot: {
                      appId,
                      clientSecret,
                      allowFrom: ["*"],
                    },
                  },
                };
              },
            },
          },
          source: "test",
        },
      ]),
    );

    await channelsAddCommand(
      {
        channel: "qqbot",
        token: "app-id:secret",
      },
      runtime,
      { hasFlags: true },
    );

    expect(writtenChannel("qqbot")).toMatchObject({
      appId: "app-id",
      clientSecret: "secret",
      dmPolicy: "open",
      allowFrom: ["openclaw:approval-disabled"],
    });
  });

  it("uses setup-entry snapshots when an already loaded channel plugin has no setup adapter", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({ ...baseConfigSnapshot });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "telegram",
          plugin: createChannelTestPluginBase({ id: "telegram", label: "Telegram" }),
          source: "test",
        },
      ]),
    );
    vi.mocked(loadChannelSetupPluginRegistrySnapshotForChannel).mockReturnValue(
      createTestRegistry([
        {
          pluginId: "telegram",
          plugin: {
            ...createChannelTestPluginBase({ id: "telegram", label: "Telegram" }),
            setup: {
              applyAccountConfig: ({ cfg, input }: ApplyAccountConfigParams) => ({
                ...cfg,
                channels: {
                  ...cfg.channels,
                  telegram: {
                    enabled: true,
                    botToken: input.token,
                  },
                },
              }),
            },
          },
          source: "test",
        },
      ]),
    );

    await channelsAddCommand(
      {
        channel: "telegram",
        token: "123456:token",
      },
      runtime,
      { hasFlags: true },
    );

    expect(loadChannelSetupPluginRegistrySnapshotForChannel).toHaveBeenCalledTimes(1);
    expect(writtenChannel("telegram").enabled).toBe(true);
    expect(writtenChannel("telegram").botToken).toBe("123456:token");
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("uses the bundled setup fallback when snapshots only see a runtime plugin", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({ ...baseConfigSnapshot });
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "telegram",
          plugin: createChannelTestPluginBase({ id: "telegram", label: "Telegram" }),
          source: "test",
        },
      ]),
    );
    vi.mocked(getBundledChannelSetupPlugin).mockReturnValue({
      ...createChannelTestPluginBase({ id: "telegram", label: "Telegram" }),
      setup: {
        applyAccountConfig: ({ cfg, input }: ApplyAccountConfigParams) => ({
          ...cfg,
          channels: {
            ...cfg.channels,
            telegram: {
              enabled: true,
              botToken: input.token,
            },
          },
        }),
      },
    });

    await channelsAddCommand(
      {
        channel: "telegram",
        token: "123456:token",
      },
      runtime,
      { hasFlags: true },
    );

    expect(getBundledChannelSetupPlugin).toHaveBeenCalledWith("telegram");
    expect(writtenChannel("telegram").enabled).toBe(true);
    expect(writtenChannel("telegram").botToken).toBe("123456:token");
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it.each(["10x"])(
    "rejects malformed numeric channel setup options before plugin setup (%j)",
    async (initialSyncLimit) => {
      const applyAccountConfig = vi.fn(({ cfg, input }: ApplyAccountConfigParams) => ({
        ...cfg,
        channels: {
          ...cfg.channels,
          matrix: {
            enabled: true,
            initialSyncLimit: (input as MatrixSetupInput).initialSyncLimit,
          },
        },
      }));
      const plugin = {
        ...createChannelTestPluginBase({ id: "legacy-numeric", label: "Legacy Numeric" }),
        setup: { applyAccountConfig },
      };
      catalogMocks.listChannelPluginCatalogEntries.mockReturnValue([
        createSetupOptionCatalogEntry("legacy-numeric", "Legacy Numeric", [
          {
            flags: "--initial-sync-limit <n>",
            description: "Matrix initial sync limit",
            valueType: "int",
          },
        ]),
      ]);
      configMocks.readConfigFileSnapshot.mockResolvedValue({ ...baseConfigSnapshot });
      setActivePluginRegistry(
        createTestRegistry([{ pluginId: "legacy-numeric", plugin, source: "test" }]),
      );

      await expect(
        channelsAddCommand(
          {
            channel: "legacy-numeric",
            initialSyncLimit,
          },
          runtime,
          { hasFlags: true },
        ),
      ).rejects.toThrow("--initial-sync-limit must be a non-negative integer.");

      expect(applyAccountConfig).not.toHaveBeenCalled();
      expect(configMocks.writeConfigFile).not.toHaveBeenCalled();
    },
  );

  it("coerces list-valued channel setup options from delimited strings", async () => {
    const applyAccountConfig = vi.fn(({ cfg, input }: ApplyAccountConfigParams) => ({
      ...cfg,
      channels: {
        ...cfg.channels,
        tlon: {
          enabled: true,
          groupChannels: input.groupChannels,
          dmAllowlist: input.dmAllowlist,
        },
      },
    }));
    const plugin = {
      ...createChannelTestPluginBase({ id: "legacy-lists", label: "Legacy Lists" }),
      setup: { applyAccountConfig },
    };
    catalogMocks.listChannelPluginCatalogEntries.mockReturnValue([
      createSetupOptionCatalogEntry("legacy-lists", "Legacy Lists", [
        {
          flags: "--group-channels <list>",
          description: "Tlon group channels",
          valueType: "list",
        },
        {
          flags: "--dm-allowlist <list>",
          description: "Tlon DM allowlist",
          valueType: "list",
        },
      ]),
    ]);
    configMocks.readConfigFileSnapshot.mockResolvedValue({ ...baseConfigSnapshot });
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "legacy-lists", plugin, source: "test" }]),
    );

    await channelsAddCommand(
      {
        channel: "legacy-lists",
        groupChannels: "chat/~host/general, chat/~host/random",
        dmAllowlist: "~zod;~nec",
      },
      runtime,
      { hasFlags: true },
    );

    expect(writtenChannel("tlon")).toEqual({
      enabled: true,
      groupChannels: ["chat/~host/general", "chat/~host/random"],
      dmAllowlist: ["~zod", "~nec"],
    });
  });

  it("falls back from untrusted workspace catalog shadows when adding by alias", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({ ...baseConfigSnapshot });
    setActivePluginRegistry(createTestRegistry());
    const workspaceEntry: ChannelPluginCatalogEntry = {
      ...createExternalChatCatalogEntry(),
      pluginId: "evil-external-chat-shadow",
      origin: "workspace",
      meta: {
        ...createExternalChatCatalogEntry().meta,
        aliases: ["ext"],
      },
      install: {
        npmSpec: "evil-external-chat-shadow",
      },
    };
    const trustedEntry: ChannelPluginCatalogEntry = {
      ...createExternalChatCatalogEntry(),
      origin: "bundled",
      meta: {
        ...createExternalChatCatalogEntry().meta,
        aliases: ["ext"],
      },
    };
    catalogMocks.listChannelPluginCatalogEntries.mockImplementation(() => [workspaceEntry]);
    catalogMocks.getChannelPluginCatalogEntry.mockImplementation(
      (_channel: string, opts?: { excludePluginRefs?: Array<{ pluginId: string }> }) =>
        opts?.excludePluginRefs?.some((entry) => entry.pluginId === "evil-external-chat-shadow")
          ? trustedEntry
          : undefined,
    );
    registerExternalChatSetupPlugin("@vendor/external-chat-plugin");

    await channelsAddCommand(
      {
        channel: "ext",
        account: "default",
        token: "tenant-scoped",
      },
      runtime,
      { hasFlags: true },
    );

    expect(installCall().entry).toBe(trustedEntry);
    expect(installCall().promptInstall).toBe(false);
    expect(snapshotCall().pluginId).toBe("@vendor/external-chat-plugin");
    expectExternalChatEnabledConfigWrite();
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("keeps explicitly trusted workspace catalog ownership when adding by alias", async () => {
    const workspaceEntry: ChannelPluginCatalogEntry = {
      ...createExternalChatCatalogEntry(),
      pluginId: "trusted-external-chat-shadow",
      origin: "workspace",
      meta: {
        ...createExternalChatCatalogEntry().meta,
        aliases: ["ext"],
      },
      install: {
        npmSpec: "trusted-external-chat-shadow",
      },
    };
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {
        plugins: {
          enabled: true,
          allow: ["trusted-external-chat-shadow"],
        },
      },
    });
    setActivePluginRegistry(createTestRegistry());
    catalogMocks.listChannelPluginCatalogEntries.mockReturnValue([workspaceEntry]);
    registerExternalChatSetupPlugin("trusted-external-chat-shadow");

    await channelsAddCommand(
      {
        channel: "ext",
        account: "default",
        token: "tenant-scoped",
      },
      runtime,
      { hasFlags: true },
    );

    expect(installCall().entry).toBe(workspaceEntry);
    expect(installCall().promptInstall).toBe(false);
    expect(snapshotCall().pluginId).toBe("trusted-external-chat-shadow");
    expectExternalChatEnabledConfigWrite();
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
  });

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
      signal: {
        enabled: true,
        accounts: {
          ops: {
            account: "+15550001",
          },
        },
      },
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
