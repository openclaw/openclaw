import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPluginCatalogEntry } from "../channels/plugins/catalog.js";
import {
  deleteAccountFromConfigSection,
  setAccountEnabledInConfigSection,
} from "../channels/plugins/config-helpers.js";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import type { OpenClawConfig } from "../config/config.js";
import { createScopedChannelConfigAdapter } from "../plugin-sdk/channel-config-helpers.js";
import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  ensureChannelSetupPluginInstalled as ensureInstalled,
  loadChannelSetupPluginRegistrySnapshotForChannel as loadSnapshot,
} from "./channel-setup/plugin-install.js";
import { configMocks, offsetMocks } from "./channels.mock-harness.js";
import {
  createExternalChatCatalogEntry,
  createExternalChatDeletePlugin,
} from "./channels.plugin-install.test-helpers.js";
import { createTestConfigSnapshot, createTestRuntime } from "./test-runtime-config-helpers.js";

let channelsRemoveCommand: typeof import("./channels.js").channelsRemoveCommand;

const { catalog, refreshPluginRegistryAfterConfigMutation, callGateway } = vi.hoisted(() => ({
  catalog: vi.fn((): ChannelPluginCatalogEntry[] => []),
  refreshPluginRegistryAfterConfigMutation: vi.fn(async () => undefined),
  callGateway: vi.fn(async () => ({ stopped: true })),
}));

vi.mock(import("../channels/plugins/catalog.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  listRawChannelPluginCatalogEntries: catalog,
}));

vi.mock(import("../channels/plugins/bundled.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  getBundledChannelPlugin: vi.fn(() => undefined),
}));

vi.mock("./channel-setup/plugin-install.js", async () => {
  const actual = await vi.importActual<typeof import("./channel-setup/plugin-install.js")>(
    "./channel-setup/plugin-install.js",
  );
  const { createMockChannelSetupPluginInstallModule } =
    await import("./channels.plugin-install.test-helpers.js");
  return createMockChannelSetupPluginInstallModule(actual);
});

vi.mock("../plugins/registry-refresh.js", () => ({ refreshPluginRegistryAfterConfigMutation }));

vi.mock("../gateway/call.js", () => ({ callGateway }));

const prompterMocks = vi.hoisted(() => ({
  confirm: vi.fn(async () => true),
}));

vi.mock("../wizard/clack-prompter.js", () => ({
  createClackPrompter: () => prompterMocks,
}));

const runtime = createTestRuntime();
const externalChannel = "external-chat";
const externalConfig = (
  section: Record<string, unknown> = { enabled: true, token: "token-1" },
) => ({ channels: { [externalChannel]: section } });
const workConfig = () =>
  externalConfig({ enabled: true, accounts: { work: { enabled: true, token: "token-1" } } });

function setConfig(config: OpenClawConfig) {
  configMocks.readConfigFileSnapshot.mockResolvedValue(createTestConfigSnapshot(config));
}

function remove(
  opts: Omit<Parameters<typeof channelsRemoveCommand>[0], "channel"> = {},
  channel = externalChannel,
) {
  return channelsRemoveCommand({ channel, ...opts }, runtime, { hasFlags: true });
}

function runtimeHooks(plugin: ChannelPlugin) {
  const hooks = { onAccountRemoved: vi.fn(), onAccountConfigChanged: vi.fn() };
  plugin.lifecycle = hooks;
  plugin.gateway = { startAccount: vi.fn() };
  return hooks;
}

function writtenConfig() {
  return configMocks.writeConfigFile.mock.calls[0]?.[0] as OpenClawConfig | undefined;
}

function mockInstalledPlugin(plugin: ChannelPlugin) {
  vi.mocked(loadSnapshot).mockResolvedValue(
    createTestRegistry([{ pluginId: "@vendor/external-chat-plugin", plugin, source: "test" }]),
  );
}

describe("channelsRemoveCommand", () => {
  beforeAll(async () => {
    ({ channelsRemoveCommand } = await import("./channels.js"));
  });

  beforeEach(() => {
    resetPluginRuntimeStateForTest();
    vi.clearAllMocks();
    setConfig(externalConfig());
    configMocks.replaceConfigFile
      .mockReset()
      .mockImplementation(async (params: { sourceConfig: unknown }) => {
        await configMocks.writeConfigFile(params.sourceConfig);
      });
    catalog.mockReturnValue([createExternalChatCatalogEntry()]);
    vi.mocked(ensureInstalled).mockImplementation(async ({ cfg }) => ({
      cfg,
      installed: true,
      status: "installed",
    }));
    vi.mocked(loadSnapshot).mockResolvedValue(createTestRegistry());
    callGateway.mockResolvedValue({ stopped: true });
    setActivePluginRegistry(createTestRegistry());
  });

  it("asks users to add an external channel plugin before removing its account", async () => {
    setConfig({
      ...externalConfig(),
      agents: {
        ownership: "explicit",
        entries: {
          research: { workspace: "/tmp/research-workspace" },
          ops: { workspace: "/tmp/ops-workspace" },
        },
      },
    });

    await remove({ agent: "ops", account: "default", delete: true });

    expect(ensureInstalled).not.toHaveBeenCalled();
    expect(loadSnapshot).toHaveBeenCalledTimes(1);
    expect(loadSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceDir: "/tmp/ops-workspace" }),
    );
    expect(configMocks.writeConfigFile).not.toHaveBeenCalled();
    expect(runtime.error).toHaveBeenCalledWith(
      'Channel plugin "external-chat" is not installed. Run openclaw channels add --channel external-chat first.',
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("cleans up telegram update offset when deleting a telegram account", async () => {
    const plugin = {
      ...createChannelTestPluginBase({ id: "telegram", label: "Telegram" }),
      config: createScopedChannelConfigAdapter({
        sectionKey: "telegram",
        listAccountIds: (cfg) => Object.keys(cfg.channels?.telegram?.accounts ?? { default: {} }),
        resolveAccount: (cfg, accountId) =>
          cfg.channels?.telegram?.accounts?.[accountId ?? "default"] ?? cfg.channels?.telegram,
        defaultAccountId: () => "default",
        clearBaseFields: ["botToken", "name", "dmPolicy", "allowFrom", "groupPolicy", "streaming"],
        resolveAllowFrom: () => [],
        formatAllowFrom: (allowFrom) => allowFrom.map(String),
      }),
      lifecycle: {
        onAccountRemoved: async ({ accountId }: { accountId: string }) => {
          await offsetMocks.deleteTelegramUpdateOffset({ accountId });
        },
      },
    };
    setActivePluginRegistry(createTestRegistry([{ pluginId: "telegram", plugin, source: "test" }]));
    setConfig({ channels: { telegram: { botToken: "123:abc", enabled: true } } });

    await remove({ account: "default", delete: true }, "telegram");

    expect(offsetMocks.deleteTelegramUpdateOffset).toHaveBeenCalledWith({ accountId: "default" });
  });

  it("keeps omitted removal on literal default when the plugin selects another default", async () => {
    const plugin = createExternalChatDeletePlugin();
    const defaultAccountId = vi.fn(() => "work");
    plugin.config.defaultAccountId = defaultAccountId;
    mockInstalledPlugin(plugin);

    await remove({ delete: true });

    expect(plugin.config.deleteAccount).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "default" }),
    );
    expect(defaultAccountId).not.toHaveBeenCalled();
    expect(writtenConfig()?.channels?.["external-chat"]).toBeUndefined();
    expect(runtime.log).toHaveBeenCalledWith('Deleted external-chat account "default".');
  });

  it("rejects a blank --account before deleting or writing config", async () => {
    const scopedPlugin = createExternalChatDeletePlugin();
    mockInstalledPlugin(scopedPlugin);

    await expect(remove({ account: "   ", delete: true })).rejects.toThrow(
      "--account must not be blank",
    );

    expect(scopedPlugin.config.deleteAccount).not.toHaveBeenCalled();
    expect(configMocks.writeConfigFile).not.toHaveBeenCalled();
    expect(runtime.log).not.toHaveBeenCalled();
  });

  function installWorkAccountChannel() {
    setConfig(workConfig());
    const sectionKey = "external-chat";
    const scopedPlugin: ChannelPlugin = {
      ...createChannelTestPluginBase({ id: externalChannel, label: "External Chat" }),
      config: {
        listAccountIds: (cfg: OpenClawConfig) => {
          const accounts = (cfg.channels?.[sectionKey] as { accounts?: Record<string, unknown> })
            ?.accounts;
          const ids = accounts ? Object.keys(accounts) : [];
          return ids.length ? ids : ["default"];
        },
        resolveAccount: () => ({}),
        deleteAccount: vi.fn((params: { cfg: OpenClawConfig; accountId: string }) =>
          deleteAccountFromConfigSection({ ...params, sectionKey }),
        ),
        setAccountEnabled: vi.fn(
          (params: { cfg: OpenClawConfig; accountId: string; enabled: boolean }) =>
            setAccountEnabledInConfigSection({ ...params, sectionKey, allowTopLevel: true }),
        ),
      },
    };
    mockInstalledPlugin(scopedPlugin);
    return scopedPlugin;
  }

  function expectNoRemoval(message: string) {
    expect(callGateway).not.toHaveBeenCalled();
    expect(configMocks.writeConfigFile).not.toHaveBeenCalled();
    expect(runtime.log).not.toHaveBeenCalled();
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining(message));
    expect(runtime.exit).toHaveBeenCalledWith(1);
  }

  it.each([
    {
      account: "ghost",
      deleteConfig: true,
      message: 'external-chat has no account "ghost" to remove.',
    },
    {
      account: "ghost",
      deleteConfig: false,
      message: 'external-chat has no account "ghost" to remove.',
    },
    {
      account: undefined,
      deleteConfig: false,
      message: "external-chat has no default account to remove.",
    },
  ])(
    "rejects missing account $account before mutation (delete=$deleteConfig)",
    async ({ account, deleteConfig, message }) => {
      const plugin = installWorkAccountChannel();
      const { onAccountRemoved, onAccountConfigChanged } = runtimeHooks(plugin);

      await remove({ account, delete: deleteConfig });

      expectNoRemoval(message);
      expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("Known accounts: work."));
      expect(plugin.config.deleteAccount).not.toHaveBeenCalled();
      expect(plugin.config.setAccountEnabled).not.toHaveBeenCalled();
      expect(onAccountRemoved).not.toHaveBeenCalled();
      expect(onAccountConfigChanged).not.toHaveBeenCalled();
    },
  );

  it("disables a listed default without authored config and runs its lifecycle hook", async () => {
    const plugin = installWorkAccountChannel();
    plugin.config.listAccountIds = () => ["default", "work"];
    const onAccountConfigChanged = vi.fn();
    plugin.lifecycle = { onAccountConfigChanged };

    await remove();

    expect(writtenConfig()?.channels?.["external-chat"]).toEqual({
      enabled: true,
      accounts: {
        work: { enabled: true, token: "token-1" },
        default: { enabled: false },
      },
    });
    expect(onAccountConfigChanged).toHaveBeenCalledExactlyOnceWith({
      prevCfg: workConfig(),
      nextCfg: writtenConfig(),
      accountId: "default",
      runtime,
    });
    expect(runtime.log).toHaveBeenCalledWith('Disabled external-chat account "default".');
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("refuses a fresh no-op deletion result before runtime, lifecycle, or config effects", async () => {
    const plugin = installWorkAccountChannel();
    plugin.config.listAccountIds = () => ["default"];
    plugin.config.deleteAccount = vi.fn(() => ({ channels: undefined }));
    const { onAccountRemoved } = runtimeHooks(plugin);
    setConfig({});

    await remove({ delete: true });

    expect(plugin.config.deleteAccount).toHaveBeenCalledExactlyOnceWith({
      cfg: {},
      accountId: "default",
    });
    expectNoRemoval('external-chat account "default" has no configuration to delete.');
    expect(onAccountRemoved).not.toHaveBeenCalled();
  });

  it("normalizes a listed deletion before stopping runtime, running lifecycle, and persisting", async () => {
    const callOrder: string[] = [];
    const record = (event: string) => () => {
      callOrder.push(event);
    };
    const cfg = externalConfig({
      accounts: { default: { token: "default-token" }, work: { token: "work-token" } },
    });
    const plugin = installWorkAccountChannel();
    setConfig(cfg);
    plugin.config.listAccountIds = () => ["Default", "Work"];
    plugin.config.deleteAccount = vi.fn((params) => {
      callOrder.push("delete");
      return deleteAccountFromConfigSection({ ...params, sectionKey: "external-chat" });
    });
    plugin.gateway = { startAccount: vi.fn() };
    const onAccountRemoved = vi.fn(record("lifecycle"));
    plugin.lifecycle = { onAccountRemoved };
    callGateway.mockImplementationOnce(async () => {
      callOrder.push("stop");
      return { stopped: true };
    });
    configMocks.writeConfigFile.mockImplementationOnce(async () => record("persist")());
    runtime.log.mockImplementationOnce(record("output"));

    await remove({ account: "Work", delete: true });

    expect(plugin.config.deleteAccount).toHaveBeenCalledExactlyOnceWith({ cfg, accountId: "work" });
    expect(callGateway).toHaveBeenCalledWith({
      config: cfg,
      method: "channels.stop",
      params: { channel: "external-chat", accountId: "work" },
      mode: "backend",
      clientName: "gateway-client",
      deviceIdentity: null,
    });
    expect(onAccountRemoved).toHaveBeenCalledExactlyOnceWith({
      prevCfg: cfg,
      accountId: "work",
      runtime,
    });
    expect(writtenConfig()?.channels?.["external-chat"]).toEqual({
      accounts: { default: { token: "default-token" } },
    });
    expect(callOrder).toEqual(["delete", "stop", "lifecycle", "persist", "output"]);
    expect(runtime.log).toHaveBeenCalledWith('Deleted external-chat account "work".');
  });

  it.each([
    { deleteConfig: true, action: "delete" },
    { deleteConfig: false, action: "disable" },
  ])(
    "leaves runtime and lifecycle untouched when $action is unsupported",
    async ({ deleteConfig, action }) => {
      const plugin = installWorkAccountChannel();
      if (deleteConfig) {
        delete plugin.config.deleteAccount;
      } else {
        delete plugin.config.setAccountEnabled;
      }
      const { onAccountRemoved, onAccountConfigChanged } = runtimeHooks(plugin);

      await remove({ account: "work", delete: deleteConfig });

      expectNoRemoval(`Channel "external-chat" does not support ${action}.`);
      expect(onAccountRemoved).not.toHaveBeenCalled();
      expect(onAccountConfigChanged).not.toHaveBeenCalled();
    },
  );

  it("channelsRemoveCommand refuses a colliding delete before runtime, lifecycle, or config effects", async () => {
    const plugin = installWorkAccountChannel();
    const accounts = { "Work Phone": { account: "shadow" }, "work-phone": { account: "selected" } };
    const cfg = externalConfig({ accounts });
    const metadata = createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: "external-chat",
          channels: ["external-chat"],
          channelAccountKeyPolicies: {
            "external-chat": { canonicalAliasesRequireOwnField: "account" },
          },
        },
      ],
    });
    configMocks.readConfigFileSnapshotForWrite.mockResolvedValueOnce({
      snapshot: createTestConfigSnapshot(cfg),
      writeOptions: {
        basePluginMetadataSnapshot: {
          ...metadata,
          bundledManifestRegistry: metadata.manifestRegistry,
        },
      },
    });
    const { onAccountRemoved } = runtimeHooks(plugin);

    await expect(
      withPluginCache(createPluginCache(), () => remove({ account: "work-phone", delete: true })),
    ).rejects.toThrow('stored keys "work-phone" and "Work Phone"');
    expect(callGateway).not.toHaveBeenCalled();
    expect(onAccountRemoved).not.toHaveBeenCalled();
    expect(configMocks.writeConfigFile).not.toHaveBeenCalled();
    expect(runtime.log).not.toHaveBeenCalled();
    expect(Object.keys(accounts)).toEqual(["Work Phone", "work-phone"]);
  });
});
