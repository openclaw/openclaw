// Channels remove tests cover config mutation, plugin catalog repair hints, and account removal behavior.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPluginCatalogEntry } from "../channels/plugins/catalog.js";
import {
  deleteAccountFromConfigSection,
  setAccountEnabledInConfigSection,
} from "../channels/plugins/config-helpers.js";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import type { OpenClawConfig } from "../config/config.js";
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
    installWorkAccountChannel();

    await channelsRemoveCommand(
      { channel: "external-chat", account: "ghost", delete: deleteConfig },
      runtime,
      { hasFlags: true },
    );

    expectNoRemoval('external-chat has no account "ghost" to remove.');
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

  it("stops an active gateway channel runtime before deleting a runtime-backed account", async () => {
    const callOrder: string[] = [];
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
    const deletePlugin = createExternalChatDeletePlugin();
    const scopedPlugin = {
      ...deletePlugin,
      config: {
        ...deletePlugin.config,
        deleteAccount: vi.fn((params) => {
          callOrder.push("delete");
          return deletePlugin.config.deleteAccount!(params);
        }),
      },
      gateway: {
        startAccount: vi.fn(),
      },
      lifecycle: {
        onAccountRemoved: vi.fn(() => {
          callOrder.push("lifecycle");
        }),
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
      {
        channel: "external-chat",
        account: "default",
        delete: true,
      },
      runtime,
      { hasFlags: true },
    );

    expect(gatewayMocks.callGateway).toHaveBeenCalledWith({
      config: {
        channels: {
          "external-chat": {
            enabled: true,
            token: "token-1",
          },
        },
      },
      method: "channels.stop",
      params: {
        channel: "external-chat",
        accountId: "default",
      },
      mode: "backend",
      clientName: "gateway-client",
      deviceIdentity: null,
    });
    const writtenConfig = firstWrittenChannelsConfig();
    expect(writtenConfig?.channels?.["external-chat"]).toBeUndefined();
    expect(callOrder).toEqual(["stop", "delete", "lifecycle", "persist", "output"]);
  });

  it("stops a runtime-backed account before reporting an unsupported delete", async () => {
    const callOrder: string[] = [];
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
    const scopedPlugin = {
      ...deletePlugin,
      config: {
        ...deletePlugin.config,
        deleteAccount: undefined,
      },
      gateway: {
        startAccount: vi.fn(),
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
    gatewayMocks.callGateway.mockImplementationOnce(async () => {
      callOrder.push("stop");
      return { stopped: true };
    });
    runtime.error.mockImplementationOnce(() => {
      callOrder.push("error");
    });

    await channelsRemoveCommand(
      {
        channel: "external-chat",
        account: "default",
        delete: true,
      },
      runtime,
      { hasFlags: true },
    );

    expect(callOrder).toEqual(["stop", "error"]);
    expect(configMocks.writeConfigFile).not.toHaveBeenCalled();
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });
});
