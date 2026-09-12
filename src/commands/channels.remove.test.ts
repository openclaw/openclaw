// Channels remove tests cover config mutation, plugin catalog repair hints, and account removal behavior.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPluginCatalogEntry } from "../channels/plugins/catalog.js";
import {
  deleteAccountFromConfigSection,
  setAccountEnabledInConfigSection,
} from "../channels/plugins/config-helpers.js";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import type { OpenClawConfig } from "../config/config.js";
import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  ensureChannelSetupPluginInstalled,
  loadChannelSetupPluginRegistrySnapshotForChannel,
} from "./channel-setup/plugin-install.js";
import { configMocks } from "./channels.mock-harness.js";
import {
  createExternalChatCatalogEntry,
  createExternalChatDeletePlugin,
} from "./channels.plugin-install.test-helpers.js";
import { createTestConfigSnapshot, createTestRuntime } from "./test-runtime-config-helpers.js";

let channelsRemoveCommand: typeof import("./channels.js").channelsRemoveCommand;

const catalogMocks = vi.hoisted(() => ({
  listChannelPluginCatalogEntries: vi.fn((): ChannelPluginCatalogEntry[] => []),
}));

const registryRefreshMocks = vi.hoisted(() => ({
  refreshPluginRegistryAfterConfigMutation: vi.fn(async () => undefined),
}));

const gatewayMocks = vi.hoisted(() => ({
  callGateway: vi.fn(async () => ({ stopped: true })),
}));

vi.mock("../channels/plugins/catalog.js", async () => {
  const actual = await vi.importActual<typeof import("../channels/plugins/catalog.js")>(
    "../channels/plugins/catalog.js",
  );
  return {
    ...actual,
    listRawChannelPluginCatalogEntries: catalogMocks.listChannelPluginCatalogEntries,
  };
});

vi.mock("../channels/plugins/bundled.js", async () => {
  const actual = await vi.importActual<typeof import("../channels/plugins/bundled.js")>(
    "../channels/plugins/bundled.js",
  );
  return {
    ...actual,
    getBundledChannelPlugin: vi.fn(() => undefined),
  };
});

vi.mock("./channel-setup/plugin-install.js", async () => {
  const actual = await vi.importActual<typeof import("./channel-setup/plugin-install.js")>(
    "./channel-setup/plugin-install.js",
  );
  const { createMockChannelSetupPluginInstallModule } =
    await import("./channels.plugin-install.test-helpers.js");
  return createMockChannelSetupPluginInstallModule(actual);
});

vi.mock("../plugins/registry-refresh.js", () => registryRefreshMocks);

vi.mock("../gateway/call.js", () => ({
  callGateway: gatewayMocks.callGateway,
}));

const prompterMocks = vi.hoisted(() => ({
  confirm: vi.fn(async () => true),
}));

vi.mock("../wizard/clack-prompter.js", () => ({
  createClackPrompter: () => prompterMocks,
}));

const runtime = createTestRuntime();

function firstWrittenChannelsConfig() {
  return configMocks.writeConfigFile.mock.calls[0]?.[0] as
    | { channels?: Record<string, unknown> }
    | undefined;
}

describe("channelsRemoveCommand", () => {
  beforeAll(async () => {
    ({ channelsRemoveCommand } = await import("./channels.js"));
  });

  beforeEach(() => {
    resetPluginRuntimeStateForTest();
    configMocks.readConfigFileSnapshot.mockClear();
    configMocks.writeConfigFile.mockClear();
    configMocks.replaceConfigFile
      .mockReset()
      .mockImplementation(async (params: { sourceConfig: unknown }) => {
        await configMocks.writeConfigFile(params.sourceConfig);
      });
    runtime.log.mockClear();
    runtime.error.mockClear();
    runtime.exit.mockClear();
    catalogMocks.listChannelPluginCatalogEntries.mockClear();
    catalogMocks.listChannelPluginCatalogEntries.mockReturnValue([]);
    vi.mocked(ensureChannelSetupPluginInstalled).mockClear();
    vi.mocked(ensureChannelSetupPluginInstalled).mockImplementation(async ({ cfg }) => ({
      cfg,
      installed: true,
      status: "installed",
    }));
    vi.mocked(loadChannelSetupPluginRegistrySnapshotForChannel).mockClear();
    vi.mocked(loadChannelSetupPluginRegistrySnapshotForChannel).mockReturnValue(
      createTestRegistry(),
    );
    registryRefreshMocks.refreshPluginRegistryAfterConfigMutation.mockClear();
    gatewayMocks.callGateway.mockClear();
    prompterMocks.confirm.mockClear();
    gatewayMocks.callGateway.mockResolvedValue({ stopped: true });
    setActivePluginRegistry(createTestRegistry());
  });

  it("asks users to add an external channel plugin before removing its account", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue(
      createTestConfigSnapshot({
        agents: {
          ownership: "explicit",
          entries: {
            research: { workspace: "/tmp/research-workspace" },
            ops: { workspace: "/tmp/ops-workspace" },
          },
        },
        channels: {
          "external-chat": {
            enabled: true,
            token: "token-1",
          },
        },
      }),
    );
    const catalogEntry: ChannelPluginCatalogEntry = createExternalChatCatalogEntry();
    catalogMocks.listChannelPluginCatalogEntries.mockReturnValue([catalogEntry]);

    await channelsRemoveCommand(
      {
        channel: "external-chat",
        agent: "ops",
        account: "default",
        delete: true,
      },
      runtime,
      { hasFlags: true },
    );

    expect(ensureChannelSetupPluginInstalled).not.toHaveBeenCalled();
    expect(loadChannelSetupPluginRegistrySnapshotForChannel).toHaveBeenCalledTimes(1);
    expect(loadChannelSetupPluginRegistrySnapshotForChannel).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceDir: "/tmp/ops-workspace" }),
    );
    expect(configMocks.writeConfigFile).not.toHaveBeenCalled();
    expect(runtime.error).toHaveBeenCalledWith(
      'Channel plugin "external-chat" is not installed. Run openclaw channels add --channel external-chat first.',
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("removes an external channel account when its plugin is already installed", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue(
      createTestConfigSnapshot({
        channels: {
          "external-chat": {
            enabled: true,
            token: "token-1",
          },
        },
      }),
    );
    const catalogEntry: ChannelPluginCatalogEntry = createExternalChatCatalogEntry();
    catalogMocks.listChannelPluginCatalogEntries.mockReturnValue([catalogEntry]);
    const scopedPlugin = createExternalChatDeletePlugin();
    vi.mocked(loadChannelSetupPluginRegistrySnapshotForChannel).mockReturnValue(
      createTestRegistry([
        {
          pluginId: "@vendor/external-chat-plugin",
          plugin: scopedPlugin,
          source: "test",
        },
      ]),
    );

    await channelsRemoveCommand(
      {
        channel: "external-chat",
        account: "default",
        delete: true,
      },
      runtime,
      { hasFlags: true },
    );

    expect(ensureChannelSetupPluginInstalled).not.toHaveBeenCalled();
    expect(registryRefreshMocks.refreshPluginRegistryAfterConfigMutation).not.toHaveBeenCalled();
    const writtenConfig = firstWrittenChannelsConfig();
    expect(writtenConfig?.channels?.["external-chat"]).toBeUndefined();
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("keeps omitted removal on literal default when the plugin selects another default", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue(
      createTestConfigSnapshot({
        channels: {
          "external-chat": {
            enabled: true,
            token: "token-1",
          },
        },
      }),
    );
    catalogMocks.listChannelPluginCatalogEntries.mockReturnValue([
      createExternalChatCatalogEntry(),
    ]);
    const deletePlugin = createExternalChatDeletePlugin();
    const defaultAccountId = vi.fn(() => "work");
    const scopedPlugin = {
      ...deletePlugin,
      config: {
        ...deletePlugin.config,
        defaultAccountId,
      },
    } as ChannelPlugin;
    vi.mocked(loadChannelSetupPluginRegistrySnapshotForChannel).mockReturnValue(
      createTestRegistry([
        {
          pluginId: "@vendor/external-chat-plugin",
          plugin: scopedPlugin,
          source: "test",
        },
      ]),
    );

    await channelsRemoveCommand(
      {
        channel: "external-chat",
        delete: true,
      },
      runtime,
      { hasFlags: true },
    );

    expect(scopedPlugin.config.deleteAccount).toHaveBeenCalledWith({
      cfg: {
        channels: {
          "external-chat": {
            enabled: true,
            token: "token-1",
          },
        },
      },
      accountId: "default",
    });
    expect(defaultAccountId).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith('Deleted external-chat account "default".');
  });

  it.each([
    { account: "", label: "empty" },
    { account: "   ", label: "whitespace" },
  ])("rejects a $label --account before deleting or writing config", async ({ account }) => {
    configMocks.readConfigFileSnapshot.mockResolvedValue(
      createTestConfigSnapshot({
        channels: {
          "external-chat": {
            enabled: true,
            token: "token-1",
          },
        },
      }),
    );
    catalogMocks.listChannelPluginCatalogEntries.mockReturnValue([
      createExternalChatCatalogEntry(),
    ]);
    const scopedPlugin = createExternalChatDeletePlugin();
    vi.mocked(loadChannelSetupPluginRegistrySnapshotForChannel).mockReturnValue(
      createTestRegistry([
        {
          pluginId: "@vendor/external-chat-plugin",
          plugin: scopedPlugin,
          source: "test",
        },
      ]),
    );

    await expect(
      channelsRemoveCommand({ channel: "external-chat", account, delete: true }, runtime, {
        hasFlags: true,
      }),
    ).rejects.toThrow("--account must not be blank");

    expect(scopedPlugin.config.deleteAccount).not.toHaveBeenCalled();
    expect(configMocks.writeConfigFile).not.toHaveBeenCalled();
    expect(runtime.log).not.toHaveBeenCalled();
  });

  function installWorkAccountChannel() {
    configMocks.readConfigFileSnapshot.mockResolvedValue(
      createTestConfigSnapshot({
        channels: {
          "external-chat": {
            enabled: true,
            accounts: { work: { enabled: true, token: "token-1" } },
          },
        },
      }),
    );
    catalogMocks.listChannelPluginCatalogEntries.mockReturnValue([
      createExternalChatCatalogEntry(),
    ]);
    const sectionKey = "external-chat";
    const scopedPlugin: ChannelPlugin = {
      ...createExternalChatDeletePlugin(),
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
    vi.mocked(loadChannelSetupPluginRegistrySnapshotForChannel).mockReturnValue(
      createTestRegistry([
        {
          pluginId: "@vendor/external-chat-plugin",
          plugin: scopedPlugin,
          source: "test",
        },
      ]),
    );
    return scopedPlugin;
  }

  function expectNoRemoval(message: string) {
    expect(gatewayMocks.callGateway).not.toHaveBeenCalled();
    expect(configMocks.writeConfigFile).not.toHaveBeenCalled();
    expect(runtime.log).not.toHaveBeenCalled();
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining(message));
    expect(runtime.exit).toHaveBeenCalledWith(1);
  }

  it.each([
    { deleteConfig: true, label: "delete" },
    { deleteConfig: false, label: "disable" },
  ])("rejects an unknown --account before $label mutates config", async ({ deleteConfig }) => {
    const plugin = installWorkAccountChannel();
    const onAccountRemoved = vi.fn();
    const onAccountConfigChanged = vi.fn();
    plugin.lifecycle = { onAccountRemoved, onAccountConfigChanged };
    plugin.gateway = { startAccount: vi.fn() };

    await channelsRemoveCommand(
      { channel: "external-chat", account: "ghost", delete: deleteConfig },
      runtime,
      { hasFlags: true },
    );

    expectNoRemoval('external-chat has no account "ghost" to remove.');
    expect(plugin.config.deleteAccount).not.toHaveBeenCalled();
    expect(plugin.config.setAccountEnabled).not.toHaveBeenCalled();
    expect(onAccountRemoved).not.toHaveBeenCalled();
    expect(onAccountConfigChanged).not.toHaveBeenCalled();
  });

  it("disables a listed default without authored config and runs its lifecycle hook", async () => {
    const plugin = installWorkAccountChannel();
    plugin.config.listAccountIds = () => ["default", "work"];
    const onAccountConfigChanged = vi.fn();
    plugin.lifecycle = { onAccountConfigChanged };

    await channelsRemoveCommand({ channel: "external-chat" }, runtime, { hasFlags: true });

    expect(firstWrittenChannelsConfig()?.channels?.["external-chat"]).toEqual({
      enabled: true,
      accounts: {
        work: { enabled: true, token: "token-1" },
        default: { enabled: false },
      },
    });
    expect(onAccountConfigChanged).toHaveBeenCalledExactlyOnceWith({
      prevCfg: {
        channels: {
          "external-chat": {
            enabled: true,
            accounts: { work: { enabled: true, token: "token-1" } },
          },
        },
      },
      nextCfg: firstWrittenChannelsConfig(),
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
    plugin.gateway = { startAccount: vi.fn() };
    const onAccountRemoved = vi.fn();
    plugin.lifecycle = { onAccountRemoved };
    configMocks.readConfigFileSnapshot.mockResolvedValue(createTestConfigSnapshot({}));

    await channelsRemoveCommand({ channel: "external-chat", delete: true }, runtime, {
      hasFlags: true,
    });

    expect(plugin.config.deleteAccount).toHaveBeenCalledExactlyOnceWith({
      cfg: {},
      accountId: "default",
    });
    expectNoRemoval('external-chat account "default" has no configuration to delete.');
    expect(onAccountRemoved).not.toHaveBeenCalled();
  });

  it("rejects an omitted --account when the channel has no default account", async () => {
    installWorkAccountChannel();

    await channelsRemoveCommand({ channel: "external-chat" }, runtime, { hasFlags: true });

    expectNoRemoval("external-chat has no default account to remove.");
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("Known accounts: work."));
  });

  it("rejects an unknown --account on a channel that cannot delete accounts", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue(
      createTestConfigSnapshot({
        channels: {
          "external-chat": {
            enabled: true,
            accounts: { work: { enabled: true, token: "token-1" } },
          },
        },
      }),
    );
    catalogMocks.listChannelPluginCatalogEntries.mockReturnValue([
      createExternalChatCatalogEntry(),
    ]);
    const setAccountEnabled = vi.fn(
      (params: { cfg: OpenClawConfig; accountId: string; enabled: boolean }) =>
        setAccountEnabledInConfigSection({
          ...params,
          sectionKey: "external-chat",
          allowTopLevel: true,
        }),
    );
    const scopedPlugin: ChannelPlugin = {
      ...createExternalChatDeletePlugin(),
      config: {
        listAccountIds: () => ["work"],
        resolveAccount: () => ({}),
        setAccountEnabled,
      },
    };
    vi.mocked(loadChannelSetupPluginRegistrySnapshotForChannel).mockReturnValue(
      createTestRegistry([
        { pluginId: "@vendor/external-chat-plugin", plugin: scopedPlugin, source: "test" },
      ]),
    );

    await channelsRemoveCommand({ channel: "external-chat", account: "ghost" }, runtime, {
      hasFlags: true,
    });

    expect(setAccountEnabled).not.toHaveBeenCalled();
    expectNoRemoval('external-chat has no account "ghost" to remove.');
  });

  it("normalizes a listed deletion before stopping runtime, running lifecycle, and persisting", async () => {
    const callOrder: string[] = [];
    const cfg = {
      channels: {
        "external-chat": {
          accounts: {
            default: { token: "default-token" },
            work: { token: "work-token" },
          },
        },
      },
    };
    const plugin = installWorkAccountChannel();
    configMocks.readConfigFileSnapshot.mockResolvedValue(createTestConfigSnapshot(cfg));
    plugin.config.listAccountIds = () => ["Default", "Work"];
    plugin.config.deleteAccount = vi.fn((params) => {
      callOrder.push("delete");
      return deleteAccountFromConfigSection({ ...params, sectionKey: "external-chat" });
    });
    plugin.gateway = { startAccount: vi.fn() };
    const onAccountRemoved = vi.fn(() => {
      callOrder.push("lifecycle");
    });
    plugin.lifecycle = { onAccountRemoved };
    gatewayMocks.callGateway.mockImplementationOnce(async () => {
      callOrder.push("stop");
      return { stopped: true };
    });
    configMocks.writeConfigFile.mockImplementationOnce(async () => {
      callOrder.push("persist");
    });
    runtime.log.mockImplementationOnce(() => {
      callOrder.push("output");
    });

    await channelsRemoveCommand(
      { channel: "external-chat", account: "Work", delete: true },
      runtime,
      { hasFlags: true },
    );

    expect(plugin.config.deleteAccount).toHaveBeenCalledExactlyOnceWith({ cfg, accountId: "work" });
    expect(gatewayMocks.callGateway).toHaveBeenCalledWith({
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
    expect(firstWrittenChannelsConfig()?.channels?.["external-chat"]).toEqual({
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
      plugin.gateway = { startAccount: vi.fn() };
      const onAccountRemoved = vi.fn();
      const onAccountConfigChanged = vi.fn();
      plugin.lifecycle = { onAccountRemoved, onAccountConfigChanged };

      await channelsRemoveCommand(
        { channel: "external-chat", account: "work", delete: deleteConfig },
        runtime,
        { hasFlags: true },
      );

      expectNoRemoval(`Channel "external-chat" does not support ${action}.`);
      expect(onAccountRemoved).not.toHaveBeenCalled();
      expect(onAccountConfigChanged).not.toHaveBeenCalled();
    },
  );

  it("channelsRemoveCommand refuses a colliding delete before runtime, lifecycle, or config effects", async () => {
    const plugin = installWorkAccountChannel();
    const cfg = {
      channels: {
        "external-chat": {
          accounts: { "Work Phone": { account: "shadow" }, "work-phone": { account: "selected" } },
        },
      },
    };
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
    plugin.config.deleteAccount = (params) =>
      deleteAccountFromConfigSection({
        ...params,
        sectionKey: "external-chat",
      });
    plugin.gateway = { startAccount: vi.fn() };
    const onAccountRemoved = vi.fn();
    plugin.lifecycle = { onAccountRemoved };

    await expect(
      withPluginCache(createPluginCache(), () =>
        channelsRemoveCommand(
          { channel: "external-chat", account: "work-phone", delete: true },
          runtime,
          { hasFlags: true },
        ),
      ),
    ).rejects.toThrow('stored keys "work-phone" and "Work Phone"');
    expect(gatewayMocks.callGateway).not.toHaveBeenCalled();
    expect(onAccountRemoved).not.toHaveBeenCalled();
    expect(configMocks.writeConfigFile).not.toHaveBeenCalled();
    expect(runtime.log).not.toHaveBeenCalled();
    expect(Object.keys(cfg.channels["external-chat"].accounts)).toEqual([
      "Work Phone",
      "work-phone",
    ]);
  });
});
