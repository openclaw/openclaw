// Channels remove tests cover config mutation, plugin catalog repair hints, and account removal behavior.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createChannelIngressQueue,
  purgeChannelIngressQueueAccount,
} from "../channels/message/ingress-queue.js";
import type { ChannelPluginCatalogEntry } from "../channels/plugins/catalog.js";
import {
  deleteAccountFromConfigSection,
  setAccountEnabledInConfigSection,
} from "../channels/plugins/config-helpers.js";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import type { OpenClawConfig } from "../config/config.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
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

const ingressMocks = vi.hoisted(() => ({
  purgeFailure: null as Error | null,
  onPurge: null as (() => void) | null,
}));

// The command maps a channel to the plugin whose queue holds its rows by reading plugin
// manifests. Driving that list here pins all three shapes: a channel served by its own
// plugin, one served by a plugin under a different id, and one plugin serving several.
const manifestMocks = vi.hoisted(() => ({
  plugins: [{ id: "external-chat", channels: ["external-chat"] }] as Array<{
    id: string;
    channels: string[];
  }>,
  // A plugin installed into an agent's workspace is only discoverable when the caller
  // supplies that exact scope, which is what pins the purge lookup to the operation
  // owner rather than to any workspace at all.
  workspaceScoped: false,
  workspaceDir: "/tmp/ops-workspace",
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

vi.mock("../plugins/plugin-registry.js", async () => {
  const actual = await vi.importActual<typeof import("../plugins/plugin-registry.js")>(
    "../plugins/plugin-registry.js",
  );
  return {
    ...actual,
    loadPluginManifestRegistryForPluginRegistry: (params?: { workspaceDir?: string }) => ({
      plugins:
        manifestMocks.workspaceScoped && params?.workspaceDir !== manifestMocks.workspaceDir
          ? []
          : manifestMocks.plugins,
    }),
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

vi.mock("../channels/message/ingress-queue.js", async () => {
  const actual = await vi.importActual<typeof import("../channels/message/ingress-queue.js")>(
    "../channels/message/ingress-queue.js",
  );
  return {
    ...actual,
    // Real purge unless a test arms a failure, so the state store stays authoritative.
    purgeChannelIngressQueueAccount: (
      params: Parameters<typeof actual.purgeChannelIngressQueueAccount>[0],
    ) => {
      ingressMocks.onPurge?.();
      if (ingressMocks.purgeFailure) {
        throw ingressMocks.purgeFailure;
      }
      return actual.purgeChannelIngressQueueAccount(params);
    },
  };
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

// The ingress cases all delete one configured external-chat account; they differ only in
// the plugin the registry resolves for it and the id that plugin is registered under.
function armExternalChatRemoval(
  registered: { pluginId?: string; plugin?: ChannelPlugin } = {},
  cfg: OpenClawConfig = { channels: { "external-chat": { enabled: true, token: "token-1" } } },
) {
  configMocks.readConfigFileSnapshot.mockResolvedValue(createTestConfigSnapshot(cfg));
  catalogMocks.listChannelPluginCatalogEntries.mockReturnValue([createExternalChatCatalogEntry()]);
  vi.mocked(loadChannelSetupPluginRegistrySnapshotForChannel).mockReturnValue(
    createTestRegistry([
      {
        pluginId: registered.pluginId ?? "@vendor/external-chat-plugin",
        plugin: registered.plugin ?? createExternalChatDeletePlugin(),
        source: "test",
      },
    ]),
  );
}

function deleteExternalChatAccount() {
  return channelsRemoveCommand(
    { channel: "external-chat", account: "default", delete: true },
    runtime,
    { hasFlags: true },
  );
}

describe("channelsRemoveCommand", () => {
  beforeAll(async () => {
    ({ channelsRemoveCommand } = await import("./channels.js"));
  });

  // Every case owns its state directory. Closing the handle is not isolation — it
  // releases the connection and clears the cache but deletes nothing, so a case that
  // seeded without draining stayed readable by the next one. The shared fixture is
  // what provides the directory, the env, and a removal that retries: these files are
  // held open on Windows, and a plain `fs.rm` loses that race.
  let state: OpenClawTestState;

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    await state.cleanup();
  });

  beforeEach(async () => {
    state = await createOpenClawTestState({
      prefix: "openclaw-channels-remove-",
      layout: "state-only",
    });
    resetPluginRuntimeStateForTest();
    manifestMocks.plugins = [{ id: "external-chat", channels: ["external-chat"] }];
    manifestMocks.workspaceScoped = false;
    manifestMocks.workspaceDir = "/tmp/ops-workspace";
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
    // A test that declines the confirmation must not leak that answer into the next.
    prompterMocks.confirm.mockResolvedValue(true);
    gatewayMocks.callGateway.mockResolvedValue({ stopped: true });
    ingressMocks.purgeFailure = null;
    ingressMocks.onPurge = null;
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
    expect(runtime.log).toHaveBeenCalledWith(
      'Deleted external-chat account "default". Discarded no stored ingress events.',
    );
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

  it("discards the ingress rows a deleted account owned and reports the unanswered ones", async () => {
    const callOrder: string[] = [];
    armExternalChatRemoval();
    // The runtime opens the queue under the plugin id, not the channel id it serves,
    // so an external plugin's rows are only found when removal resolves that owner.
    const queue = createChannelIngressQueue<{ text: string }>({
      channelId: "external-chat",
      accountId: "default",
    });
    await queue.enqueue("inbound-1", { text: "never answered" });
    await queue.enqueue("inbound-2", { text: "already answered" });
    await queue.complete("inbound-2");
    configMocks.writeConfigFile.mockImplementationOnce(async () => {
      callOrder.push("persist");
    });
    ingressMocks.onPurge = () => {
      callOrder.push("discard");
    };
    runtime.log.mockImplementationOnce(() => {
      callOrder.push("output");
    });

    await deleteExternalChatAccount();

    expect(runtime.log).toHaveBeenCalledWith(
      'Deleted external-chat account "default". Discarded 2 stored ingress events, including 1 never answered.',
    );
    // Discarding after the config write means a failed write cannot drop inbound work
    // for an account that is still configured.
    expect(callOrder).toEqual(["persist", "discard", "output"]);
    expect(
      purgeChannelIngressQueueAccount({
        channelId: "external-chat",
        accountId: "default",
      }),
    ).toEqual({ discarded: 0, undelivered: 0, recoverable: 0 });
  });

  it("keeps the ingress rows of a disabled account so re-enabling it drains them", async () => {
    const deletePlugin = createExternalChatDeletePlugin();
    armExternalChatRemoval({
      plugin: {
        ...deletePlugin,
        config: {
          ...deletePlugin.config,
          setAccountEnabled: ({ cfg }) => cfg,
        },
      },
    });
    // Seed under the id a discard would actually target, so this stays a real negative
    // control: seeding under the channel id would survive even if the disable path
    // started discarding.
    const queue = createChannelIngressQueue<{ text: string }>({
      channelId: "external-chat",
      accountId: "default",
    });
    await queue.enqueue("inbound-1", { text: "waiting for the account to come back" });

    await channelsRemoveCommand(
      {
        channel: "external-chat",
        account: "default",
      },
      runtime,
      { hasFlags: true },
    );

    expect(runtime.log).toHaveBeenCalledWith('Disabled external-chat account "default".');
    // The account can be re-enabled, so its queued work is still deliverable. Reading it
    // back through the purge both proves it survived and leaves the worker state clean.
    expect(
      purgeChannelIngressQueueAccount({
        channelId: "external-chat",
        accountId: "default",
      }),
    ).toEqual({ discarded: 1, undelivered: 1, recoverable: 0 });
  });

  it("keeps the ingress rows when the config write fails, so nothing is dropped for a still-configured account", async () => {
    armExternalChatRemoval();
    const queue = createChannelIngressQueue<{ text: string }>({
      channelId: "external-chat",
      accountId: "default",
    });
    await queue.enqueue("inbound-1", { text: "account is still configured" });
    configMocks.writeConfigFile.mockRejectedValueOnce(new Error("disk full"));

    await expect(deleteExternalChatAccount()).rejects.toThrow("disk full");

    // The account is still in config, so its queued work must still be there to drain.
    expect(
      purgeChannelIngressQueueAccount({
        channelId: "external-chat",
        accountId: "default",
      }),
    ).toEqual({ discarded: 1, undelivered: 1, recoverable: 0 });
  });

  it("still reports the deletion when the ingress discard fails", async () => {
    armExternalChatRemoval();
    // The config write has already landed by then, so the account is gone either way.
    ingressMocks.purgeFailure = new Error("state database is owned by another process");

    await deleteExternalChatAccount();

    expect(runtime.log).toHaveBeenCalledWith(
      'Deleted external-chat account "default". Its stored ingress events could not be discarded: state database is owned by another process',
    );
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("reports a discard with no unanswered work without calling it lost", async () => {
    armExternalChatRemoval();
    const queue = createChannelIngressQueue<{ text: string }>({
      channelId: "external-chat",
      accountId: "default",
    });
    await queue.enqueue("inbound-1", { text: "answered before removal" });
    await queue.complete("inbound-1");

    await deleteExternalChatAccount();

    // Every row was settled, so the summary must not describe lost inbound work.
    expect(runtime.log).toHaveBeenCalledWith(
      'Deleted external-chat account "default". Discarded 1 stored ingress event.',
    );
  });

  it("counts a discarded dead letter as work, not as routine cleanup", async () => {
    armExternalChatRemoval();
    const queue = createChannelIngressQueue<{ text: string }>({
      channelId: "external-chat",
      accountId: "default",
    });
    await queue.enqueue("inbound-1", { text: "failed once" });
    const claim = await queue.claim("inbound-1", { ownerId: "worker" });
    if (!claim) {
      throw new Error("Expected a claimed ingress event");
    }
    await queue.fail(claim, { reason: "handler-error" });

    await deleteExternalChatAccount();

    // `channels dead-letters resubmit` could have replayed this row until now, so the
    // deletion has to name it rather than fold it into the total.
    expect(runtime.log).toHaveBeenCalledWith(
      'Deleted external-chat account "default". Discarded 1 stored ingress event, including 1 awaiting resubmission.',
    );
  });

  it("discards the rows under the plugin id when that is not the channel id", async () => {
    // An installed plugin whose package id is not the channel it serves: the runtime
    // stored its rows under the package id, so addressing the channel id finds nothing.
    manifestMocks.plugins = [{ id: "@vendor/external-chat-plugin", channels: ["external-chat"] }];
    armExternalChatRemoval();
    const queue = createChannelIngressQueue<{ text: string }>({
      channelId: "@vendor/external-chat-plugin",
      accountId: "default",
    });
    await queue.enqueue("inbound-1", { text: "never answered" });

    await deleteExternalChatAccount();

    expect(runtime.log).toHaveBeenCalledWith(
      'Deleted external-chat account "default". Discarded 1 stored ingress event, including 1 never answered.',
    );
  });

  it("keeps the ingress rows when the channel is the multi-channel plugin's own id", async () => {
    // `channelPluginIdBelongsToManifest` accepts a channel whose id IS the plugin id even
    // when `channels` does not list it, so this shape is absent from the declared list and
    // must not be read as "no manifest claims this channel" - the queue is still shared.
    manifestMocks.plugins = [
      { id: "external-chat", channels: ["external-chat-text", "external-chat-voice"] },
    ];
    armExternalChatRemoval({ pluginId: "external-chat" });
    const queue = createChannelIngressQueue<{ text: string }>({
      channelId: "external-chat",
      accountId: "default",
    });
    await queue.enqueue("inbound-1", { text: "belongs to a sibling channel too" });

    await deleteExternalChatAccount();

    expect(runtime.log).toHaveBeenCalledWith(
      'Deleted external-chat account "default". Kept its stored ingress events: plugin "external-chat" serves more than one channel and its stored events do not record which.',
    );
    await expect(queue.claimNext({ ownerId: "worker" })).resolves.toMatchObject({
      id: "inbound-1",
    });
  });

  it("keeps the ingress rows when one plugin serves several channels", async () => {
    // One plugin, two channels, one queue between them: the rows record no channel of
    // their own, so this account's removal cannot tell its rows from its sibling's.
    manifestMocks.plugins = [
      { id: "@vendor/external-chat-plugin", channels: ["external-chat", "external-chat-voice"] },
    ];
    armExternalChatRemoval();
    const queue = createChannelIngressQueue<{ text: string }>({
      channelId: "@vendor/external-chat-plugin",
      accountId: "default",
    });
    await queue.enqueue("inbound-1", { text: "belongs to a sibling channel too" });

    await deleteExternalChatAccount();

    expect(runtime.log).toHaveBeenCalledWith(
      'Deleted external-chat account "default". Kept its stored ingress events: plugin "@vendor/external-chat-plugin" serves more than one channel and its stored events do not record which.',
    );
    // The sibling's unanswered event is still claimable, which is the whole point.
    await expect(queue.claimNext({ ownerId: "worker" })).resolves.toMatchObject({
      id: "inbound-1",
    });
  });

  // The shared-queue guard only fires when discovery finds the manifest. A plugin
  // installed into the operation owner's workspace is invisible to a lookup scoped
  // anywhere else, and the no-manifest branch below it purges the queue its channels
  // share. No --agent here on purpose: the owner is the sole configured agent, so a
  // lookup that assumes the default agent id resolves the wrong workspace.
  it("keeps a workspace-installed plugin's sibling rows when one of its channels is deleted", async () => {
    armExternalChatRemoval(
      { pluginId: "external-chat" },
      {
        agents: {
          ownership: "explicit",
          entries: { ops: { workspace: "/tmp/ops-workspace" } },
        },
        channels: { "external-chat": { enabled: true, token: "token-1" } },
      },
    );
    manifestMocks.workspaceScoped = true;
    manifestMocks.plugins = [
      { id: "external-chat", channels: ["external-chat", "external-chat-voice"] },
    ];
    const queue = createChannelIngressQueue<{ text: string }>({
      channelId: "external-chat",
      accountId: "default",
    });
    await queue.enqueue("inbound-1", { text: "belongs to a sibling channel too" });

    await deleteExternalChatAccount();

    expect(runtime.log).toHaveBeenCalledWith(
      'Deleted external-chat account "default". Kept its stored ingress events: plugin "external-chat" serves more than one channel and its stored events do not record which.',
    );
    await expect(queue.claimNext({ ownerId: "worker" })).resolves.toMatchObject({
      id: "inbound-1",
    });
  });
});
