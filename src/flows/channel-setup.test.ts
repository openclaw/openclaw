import { expectDefined } from "@openclaw/normalization-core/expect";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { applyAccountNameToChannelSection } from "../channels/plugins/setup-helpers.js";
import type { ChannelOnboardingPostWriteHook } from "../channels/plugins/setup-wizard-types.js";
import { createTestRuntime } from "../commands/test-runtime-config-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withPluginMetadataSnapshotScope } from "../plugins/current-plugin-metadata-snapshot.js";
import { createPluginCache, getPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { PluginInstance } from "../plugins/plugin-instance.js";
import { hasPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import * as pluginMetadata from "../plugins/plugin-metadata-snapshot.js";
import { createInstallAccountPolicyFixture } from "../plugins/test-helpers/install-account-policy.test-support.js";
import { resolveChannelAccountEntry } from "../routing/account-lookup.js";
import { WizardCancelledError, WizardNavigationError } from "../wizard/prompts.js";
import {
  externalChatSetupEntries,
  makeCatalogEntry,
  makeChannelSetupEntries,
  makeExternalChatSetupPlugin,
  makeMeta,
  makePluginRegistry,
  makeSetupPlugin,
} from "./channel-setup.test-helpers.js";

function externalChatCatalogEntry() {
  return makeCatalogEntry("external-chat", "External Chat", {
    pluginId: "@vendor/external-chat-plugin",
    install: { npmSpec: "@vendor/external-chat-plugin" },
  });
}

function discoverExternal(bucket: "installed" | "installable") {
  const entry =
    bucket === "installed"
      ? externalChatCatalogEntry()
      : makeCatalogEntry("external-chat", "External Chat", {
          pluginId: "@vendor/external-chat-plugin",
        });
  discoverChannels.mockReturnValue(
    externalChatSetupEntries(
      bucket === "installed"
        ? {
            installedCatalogEntries: [entry],
            installedCatalogById: new Map([["external-chat", entry]]),
          }
        : {
            installableCatalogEntries: [entry],
            installableCatalogById: new Map([["external-chat", entry]]),
          },
    ),
  );
}

function externalRegistry(
  plugin: ReturnType<typeof makeExternalChatSetupPlugin>,
  setupOnly = true,
) {
  const entry = { pluginId: "@vendor/external-chat-plugin", source: "global" as const, plugin };
  return setupOnly
    ? makePluginRegistry({ channelSetups: [{ ...entry, enabled: true }] })
    : makePluginRegistry({ channels: [entry] });
}

function useActiveExternal(setupWizard: Parameters<typeof makeExternalChatSetupPlugin>[0]) {
  const plugin = makeExternalChatSetupPlugin(setupWizard);
  discoverChannels.mockReturnValue(externalChatSetupEntries());
  activePlugins.mockReturnValue([plugin]);
}

function installResult(
  cfg: OpenClawConfig = {},
  installed = true,
  pluginId = "@vendor/external-chat-plugin",
) {
  return { cfg, installed, pluginId, status: installed ? "installed" : "skipped" };
}

function configuredExternalStatus() {
  return vi.fn(async () => ({ channel: "external-chat", configured: true, statusLines: [] }));
}

function selectExternal() {
  return vi.fn().mockResolvedValueOnce("external-chat").mockResolvedValueOnce("__done__");
}

function callArg<T>(mock: { mock: { calls: [T, ...unknown[]][] } }, index = 0): T {
  const call = expectDefined(mock.mock.calls[index], `mock call ${index}`);
  return call[0];
}

function expectExternalCatalogInstallCall(index = 0) {
  expect(callArg(installPlugin, index)).toMatchObject({
    entry: { id: "external-chat", install: { npmSpec: "@vendor/external-chat-plugin" } },
    autoConfirmSingleSource: true,
  });
}

const {
  listTrustedChannelPluginCatalogEntries: trustedCatalog,
  getTrustedChannelPluginCatalogEntry: catalogEntry,
  listChannelSetupPlugins: allSetupPlugins,
  listActiveChannelSetupPlugins: activePlugins,
  loadChannelSetupPluginRegistrySnapshotForChannel: loadSetupRegistry,
  ensureChannelSetupPluginInstalled: installPlugin,
  resolveChannelSetupEntries: discoverChannels,
  collectChannelStatus: collectStatus,
  isChannelConfigured: channelConfigured,
  reset,
  factories,
} = await vi.hoisted(async () => {
  const { createChannelSetupMocks } = await import("./channel-setup.test-helpers.js");
  return createChannelSetupMocks();
});

vi.mock("../agents/agent-scope.js", factories.agentScope);
vi.mock("../channels/plugins/setup-registry.js", factories.setupRegistry);
vi.mock("../channels/registry.js", factories.channels);
vi.mock("../commands/channel-setup/discovery.js", factories.discovery);
vi.mock("../commands/channel-setup/plugin-install.js", factories.pluginInstall);
vi.mock("../commands/channel-setup/registry.js", factories.registry);
vi.mock("../commands/channel-setup/trusted-catalog.js", factories.trustedCatalog);
vi.mock("../config/channel-configured.js", factories.configured);
vi.mock("./channel-setup.prompts.js", factories.prompts);
vi.mock("./channel-setup.status.js", factories.status);

import { setupChannels } from "./channel-setup.js";

const disabledExternalPluginConfig = {
  plugins: { entries: { "external-chat": { enabled: false } } },
  channels: { "external-chat": { enabled: true, appId: "999999", clientSecret: "stale" } },
};

const DEFERRED_CHANNEL_SETUP_OPTIONS = {
  deferStatusUntilSelection: true,
  skipConfirm: true,
  skipDmPolicyPrompt: true,
} satisfies NonNullable<Parameters<typeof setupChannels>[3]>;

const QUICKSTART_CHANNEL_SETUP_OPTIONS = {
  quickstartDefaults: true,
  skipConfirm: true,
  skipDmPolicyPrompt: true,
} satisfies NonNullable<Parameters<typeof setupChannels>[3]>;

const TARGETED_CHANNEL_SETUP_OPTIONS = {
  initialSelection: ["external-chat"],
  finishAfterInitialSelection: true,
  deferStatusUntilSelection: true,
  skipDmPolicyPrompt: true,
} satisfies NonNullable<Parameters<typeof setupChannels>[3]>;

function runChannelSetup(
  cfg: OpenClawConfig,
  prompter: Record<string, unknown>,
  options?: Parameters<typeof setupChannels>[3],
) {
  const prompts = {
    confirm: vi.fn(async () => true),
    note: vi.fn(async () => undefined),
    ...prompter,
  };
  return setupChannels(cfg, {} as never, prompts as never, options);
}

function runDeferred(
  cfg: OpenClawConfig,
  prompter: Record<string, unknown>,
  options?: Parameters<typeof setupChannels>[3],
) {
  return runChannelSetup(cfg, prompter, { ...DEFERRED_CHANNEL_SETUP_OPTIONS, ...options });
}

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(reset);

it("keeps trusted workspace overrides eligible during preload", async () => {
  trustedCatalog.mockReturnValue([
    { id: "external-chat", pluginId: "trusted-external-chat-shadow", origin: "workspace" },
  ]);

  const cfg = { plugins: { enabled: true, allow: ["trusted-external-chat-shadow"] } };
  await runChannelSetup(cfg, { confirm: vi.fn(async () => false) });

  expect(trustedCatalog).toHaveBeenCalledWith({
    cfg,
    workspaceDir: "/tmp/openclaw-workspace",
  });
  expect(callArg(loadSetupRegistry)).toMatchObject({
    channel: "external-chat",
    pluginId: "trusted-external-chat-shadow",
    workspaceDir: "/tmp/openclaw-workspace",
  });
});

it("keeps already-active setup plugins in the deferred picker without registry fallback", async () => {
  const activePlugin = makeSetupPlugin({ id: "custom-chat", label: "Custom Chat" });
  activePlugins.mockReturnValue([activePlugin]);
  const select = vi.fn(async () => "__done__");

  await runChannelSetup(
    {},
    { select },
    {
      deferStatusUntilSelection: true,
      skipConfirm: true,
    },
  );

  expect(callArg<{ installedPlugins?: unknown[] }>(discoverChannels).installedPlugins).toEqual([
    activePlugin,
  ]);
  expect(allSetupPlugins).not.toHaveBeenCalled();
  expect(collectStatus).not.toHaveBeenCalled();
});

it("enables an explicitly selected active plugin in eager setup", async () => {
  trustedCatalog.mockReturnValue([]);
  const setupWizard = {
    channel: "custom-chat",
    getStatus: vi.fn(async () => ({
      channel: "custom-chat",
      configured: false,
      statusLines: [],
    })),
    configure: vi.fn(async ({ cfg }: { cfg: Record<string, unknown> }) => ({
      cfg: {
        ...cfg,
        channels: { "custom-chat": { token: "secret" } },
      },
    })),
  };
  const activePlugin = makeSetupPlugin({
    id: "custom-chat",
    label: "Custom Chat",
    setupWizard,
  });
  activePlugins.mockReturnValue([activePlugin]);
  discoverChannels.mockReturnValue(
    makeChannelSetupEntries({
      entries: [
        {
          id: "custom-chat",
          meta: makeMeta("custom-chat", "Custom Chat"),
        },
      ],
    }),
  );
  const select = vi.fn().mockResolvedValueOnce("custom-chat").mockResolvedValueOnce("__done__");

  const next = await runDeferred(
    {},
    { select },
    {
      deferStatusUntilSelection: false,
    },
  );

  expect(loadSetupRegistry).not.toHaveBeenCalled();
  const enabled = { plugins: { entries: { "custom-chat": { enabled: true } } } };
  expect(callArg<{ cfg?: unknown }>(setupWizard.configure).cfg).toEqual(enabled);
  expect(next).toEqual({ ...enabled, channels: { "custom-chat": { token: "secret" } } });
});

it("returns to quickstart selection when install-on-demand is skipped", async () => {
  const configure = vi.fn(async ({ cfg }: { cfg: Record<string, unknown> }) => ({ cfg }));
  const externalChatPlugin = makeExternalChatSetupPlugin({ configure });
  discoverExternal("installable");
  installPlugin
    .mockResolvedValueOnce(installResult({}, false))
    .mockResolvedValueOnce(installResult({}, true));
  loadSetupRegistry.mockReturnValue(externalRegistry(externalChatPlugin));
  let quickstartSelectionCount = 0;
  const select = vi.fn(async ({ message }: { message: string }) => {
    if (message === "Select channel (QuickStart)") {
      quickstartSelectionCount += 1;
      return "external-chat";
    }
    return "__done__";
  });

  await runChannelSetup({}, { select }, QUICKSTART_CHANNEL_SETUP_OPTIONS);

  expect(quickstartSelectionCount).toBe(2);
  expect(installPlugin).toHaveBeenCalledTimes(2);
  expect(configure).toHaveBeenCalledTimes(1);
});

it("returns the installed-catalog reinstall confirmation to channel selection", async () => {
  discoverExternal("installed");
  loadSetupRegistry.mockReturnValue(makePluginRegistry());
  installPlugin.mockImplementationOnce(async ({ cfg, prompter }) => {
    await prompter.confirm({
      message: "Reinstall External Chat?",
      initialValue: true,
    });
    return installResult(cfg);
  });
  const confirm = vi.fn(async () => {
    throw new WizardNavigationError("back");
  });
  const cfg = { channels: { "external-chat": { token: "keep" } } } as OpenClawConfig;

  const result = await runDeferred(cfg, {
    confirm,
    select: selectExternal(),
  });

  expect(confirm).toHaveBeenCalledWith(
    expect.objectContaining({
      message: "Reinstall External Chat?",
      navigation: { canGoBack: true, canGoForward: false },
    }),
  );
  expect(result).toEqual(cfg);
});

it("fails visibly when configured channel setup has no post-write hook sink", async () => {
  const externalChatPlugin = makeExternalChatSetupPlugin({
    configure: vi.fn(),
    configureInteractive: vi.fn(async ({ cfg }) => ({
      cfg: {
        ...cfg,
        channels: { ...cfg.channels, "external-chat": { token: "configured" } },
      },
      accountId: "external-account",
    })),
    afterConfigWritten: vi.fn(async () => {}),
  });
  discoverChannels.mockReturnValue(externalChatSetupEntries());
  activePlugins.mockReturnValue([externalChatPlugin]);

  await expect(
    runChannelSetup({}, { select: vi.fn(async () => "__done__") }, TARGETED_CHANNEL_SETUP_OPTIONS),
  ).rejects.toThrow(/post-write hook.*transaction sink/i);
});

it("keeps completed setup when the follow-up status refresh fails", async () => {
  const getStatus = vi
    .fn()
    .mockResolvedValueOnce({
      channel: "external-chat",
      configured: false,
      statusLines: [],
    })
    .mockRejectedValue(new Error("controlled status failure"));
  useActiveExternal({
    getStatus,
    configure: vi.fn(async ({ cfg }) => ({
      cfg: {
        ...cfg,
        channels: { ...cfg.channels, "external-chat": { token: "configured" } },
      },
      accountId: "external-account",
    })),
  });
  const note = vi.fn(async () => undefined);

  const result = await runChannelSetup(
    {},
    { note, select: vi.fn(async () => "__done__") },
    TARGETED_CHANNEL_SETUP_OPTIONS,
  );

  expect(result).toMatchObject({ channels: { "external-chat": { token: "configured" } } });
  expect(note).toHaveBeenCalledWith(
    "Status unavailable (controlled status failure).\n" +
      "Retry: openclaw channels status --channel external-chat",
    "Channel status",
  );
});

it("returns targeted channel setup Back navigation to the channel picker", async () => {
  const promptOrder: string[] = [];
  const configureInteractive = vi.fn(async ({ prompter }) => {
    promptOrder.push("channel setup");
    await prompter.text({ message: "External Chat token" });
    return {
      cfg: { channels: { "external-chat": { token: "should-not-apply" } } } as OpenClawConfig,
      accountId: "external-account",
    };
  });
  useActiveExternal({
    configure: vi.fn(),
    configureInteractive,
  });
  const select = vi.fn(async () => {
    promptOrder.push("channel picker");
    return "__done__";
  });
  const cfg = { channels: { telegram: { botToken: "keep" } } } as OpenClawConfig;
  const text = vi.fn(async () => {
    throw new WizardNavigationError("back");
  });

  const result = await runChannelSetup(cfg, { select, text }, TARGETED_CHANNEL_SETUP_OPTIONS);

  expect(promptOrder).toEqual(["channel setup", "channel picker"]);
  expect(configureInteractive).toHaveBeenCalledTimes(1);
  expect(text).toHaveBeenCalledWith(
    expect.objectContaining({
      message: "External Chat token",
      navigation: { canGoBack: true, canGoForward: false },
    }),
  );
  expect(select).toHaveBeenCalledWith(expect.objectContaining({ message: "Select a channel" }));
  expect(result).toEqual(cfg);
});

it("returns configured channel actions to selection when their first prompt goes back", async () => {
  const configureWhenConfigured = vi.fn(async ({ cfg, prompter }) => {
    await prompter.select({
      message: "Configured channel action",
      options: [{ value: "update", label: "Update" }],
    });
    return {
      cfg: {
        ...cfg,
        channels: { ...cfg.channels, "external-chat": { token: "should-not-apply" } },
      },
    };
  });
  useActiveExternal({
    getStatus: configuredExternalStatus(),
    configure: vi.fn(),
    configureWhenConfigured,
  });
  const select = vi
    .fn()
    .mockResolvedValueOnce("external-chat")
    .mockRejectedValueOnce(new WizardNavigationError("back"))
    .mockResolvedValueOnce("__done__");
  const cfg = { channels: { "external-chat": { token: "keep" } } } as OpenClawConfig;

  const result = await runDeferred(cfg, { select });

  expect(configureWhenConfigured).toHaveBeenCalledTimes(1);
  expect(select).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({
      message: "Configured channel action",
      navigation: { canGoBack: true, canGoForward: false },
    }),
  );
  expect(result).toEqual(cfg);
});

it("preserves accepted external install metadata when later channel setup goes back", async () => {
  const configure = vi.fn(async ({ cfg, prompter }) => {
    await prompter.text({ message: "External Chat token" });
    return { cfg, accountId: "external-account" };
  });
  const externalChatPlugin = makeExternalChatSetupPlugin({ configure });
  discoverExternal("installable");
  loadSetupRegistry.mockReturnValue(externalRegistry(externalChatPlugin));
  installPlugin.mockImplementationOnce(async (params) => {
    await params.beforePersistentEffect?.();
    return {
      cfg: {
        ...params.cfg,
        plugins: {
          ...params.cfg.plugins,
          entries: {
            ...params.cfg.plugins?.entries,
            "@vendor/external-chat-plugin": { enabled: true },
          },
          installs: {
            ...params.cfg.plugins?.installs,
            "@vendor/external-chat-plugin": {
              source: "npm",
              spec: "@vendor/external-chat-plugin@1.0.0",
            },
          },
        },
      },
      installed: true,
      pluginId: "@vendor/external-chat-plugin",
      status: "installed",
    };
  });
  const select = selectExternal();
  const beforePersistentEffect = vi.fn(async () => undefined);

  const result = await runDeferred(
    { channels: { telegram: { botToken: "keep" } } } as OpenClawConfig,
    {
      select,
      text: vi.fn(async () => {
        throw new WizardNavigationError("back");
      }),
    },
    {
      beforePersistentEffect,
    },
  );

  expect(result.channels).toEqual({ telegram: { botToken: "keep" } });
  expect(result.plugins?.entries?.["@vendor/external-chat-plugin"]?.enabled).toBe(true);
  expect(result.plugins?.installs?.["@vendor/external-chat-plugin"]?.spec).toBe(
    "@vendor/external-chat-plugin@1.0.0",
  );
  expect(beforePersistentEffect).toHaveBeenCalledTimes(1);
});

it("replays earlier prompts when Back is used inside channel setup", async () => {
  const configure = vi.fn(async ({ cfg, prompter }) => {
    const username = await prompter.text({ message: "Username" });
    const token = await prompter.text({ message: "Token" });
    return {
      cfg: { ...cfg, channels: { ...cfg.channels, "external-chat": { username, token } } },
    };
  });
  useActiveExternal({ configure });
  const text = vi
    .fn()
    .mockResolvedValueOnce("old-name")
    .mockRejectedValueOnce(new WizardNavigationError("back"))
    .mockResolvedValueOnce("new-name")
    .mockResolvedValueOnce("secret-token");

  const result = await runDeferred(
    {},
    {
      select: selectExternal(),
      text,
    },
  );

  expect(configure).toHaveBeenCalledTimes(2);
  expect(result.channels?.["external-chat"]).toEqual({
    username: "new-name",
    token: "secret-token",
  });
  expect(text.mock.calls[2]?.[0]).toMatchObject({
    initialValue: "old-name",
    navigation: { canGoBack: true, canGoForward: true },
  });
});

it("disables Back after a channel declares a persistent effect boundary", async () => {
  const configure = vi.fn(async ({ cfg, prompter, options }) => {
    await prompter.text({ message: "Before effect" });
    await options.beforePersistentEffect?.();
    await prompter.text({ message: "After effect" });
    return { cfg };
  });
  useActiveExternal({ configure });
  const navigationError = new WizardNavigationError("back");
  const text = vi.fn().mockResolvedValueOnce("ready").mockRejectedValueOnce(navigationError);
  const beforePersistentEffect = vi.fn(async () => undefined);

  await expect(
    runDeferred(
      {},
      {
        select: vi.fn().mockResolvedValueOnce("external-chat"),
        text,
      },
      {
        beforePersistentEffect,
      },
    ),
  ).rejects.toBe(navigationError);

  expect(beforePersistentEffect).toHaveBeenCalledTimes(1);
  expect(text.mock.calls[1]?.[0]).toMatchObject({
    navigation: { canGoBack: false, canGoForward: false },
  });
});

it("propagates Ctrl-C cancellation from channel setup", async () => {
  const cancelled = new WizardCancelledError();
  const configure = vi.fn(async ({ prompter }) => {
    await prompter.text({ message: "Token" });
    return { cfg: {} as OpenClawConfig };
  });
  useActiveExternal({ configure });

  await expect(
    runDeferred(
      {},
      {
        select: vi.fn().mockResolvedValueOnce("external-chat"),
        text: vi.fn(async () => {
          throw cancelled;
        }),
      },
    ),
  ).rejects.toBe(cancelled);
});

it("keeps an explicitly disabled channel unchanged when setup resume is declined", async () => {
  const configure = vi.fn();
  const externalChatPlugin = makeExternalChatSetupPlugin({
    getStatus: configuredExternalStatus(),
    configure,
  });
  discoverChannels.mockReturnValue(externalChatSetupEntries());
  activePlugins.mockReturnValue([externalChatPlugin]);
  const select = selectExternal();
  const confirm = vi.fn(async () => false);
  const cfg = { channels: { "external-chat": { enabled: false, token: "secret" } } };

  const next = await runDeferred(cfg as never, { confirm, select });

  expect(loadSetupRegistry).not.toHaveBeenCalled();
  expect(confirm).toHaveBeenCalledWith({
    message: "external-chat is disabled. Enable it and continue setup now?",
    initialValue: true,
  });
  expect(configure).not.toHaveBeenCalled();
  expect(next).toEqual({ channels: { "external-chat": { enabled: false, token: "secret" } } });
});

it.each(["channel", "plugin"] as const)(
  "resumes a disabled %s without replacing channel config",
  async (disabled) => {
    const configure = vi.fn(async ({ cfg }: { cfg: OpenClawConfig }) => ({
      cfg,
      accountId: "default",
    }));
    useActiveExternal({ getStatus: configuredExternalStatus(), configure });
    const confirm = vi.fn(async () => true);
    const onSelection = vi.fn();
    const cfg = {
      channels: { "external-chat": { enabled: disabled === "plugin", token: "saved-secret" } },
      ...(disabled === "plugin"
        ? { plugins: { entries: { "external-chat": { enabled: false } } } }
        : {}),
    };
    const next = await runDeferred(cfg, { confirm, select: selectExternal() }, { onSelection });
    if (disabled === "channel") {
      const expected = {
        channels: { "external-chat": { enabled: true, token: "saved-secret" } },
        plugins: { entries: { "external-chat": { enabled: true } } },
      };
      expect(configure).toHaveBeenCalledWith(expect.objectContaining({ cfg: expected }));
      expect(onSelection).toHaveBeenCalledWith(["external-chat"]);
      expect(next).toEqual(expected);
    } else {
      expect(confirm).toHaveBeenCalledWith({
        message: "external-chat plugin is disabled. Enable it and continue setup now?",
        initialValue: true,
      });
      expect(configure).toHaveBeenCalledOnce();
      expect(next).toMatchObject({
        plugins: { entries: { "external-chat": { enabled: true } } },
        channels: { "external-chat": { enabled: true } },
      });
    }
  },
);

it("returns paused setup state without marking the channel configured", async () => {
  const pausedConfig = {
    channels: {
      "external-chat": {
        enabled: false,
        relayUrl: "wss://relay.example.com",
        privateKey: "saved-secret",
      },
    },
  };
  useActiveExternal({
    configure: vi.fn(async () => ({
      cfg: pausedConfig,
      completion: "paused" as const,
    })),
  });
  const select = vi.fn().mockResolvedValue("external-chat");
  const onSelection = vi.fn();

  const next = await runDeferred({}, { select }, { onSelection });

  expect(select).toHaveBeenCalledOnce();
  expect(onSelection).toHaveBeenCalledWith([]);
  expect(next).toBe(pausedConfig);
});

it("honors global plugin disablement before lazy channel setup loads plugins", async () => {
  discoverChannels.mockReturnValue(externalChatSetupEntries());
  const select = selectExternal();
  const note = vi.fn(async () => undefined);
  const cfg = {
    plugins: { enabled: false },
    channels: { "external-chat": { enabled: true, token: "secret" } },
  };

  await runDeferred(cfg as never, { note, select });

  expect(loadSetupRegistry).not.toHaveBeenCalled();
  expect(note).toHaveBeenCalledWith(
    "external-chat cannot be configured while plugins disabled. Enable it before setup.",
    "Channel setup",
  );
});

it("reinstalls stale external config with fresh account policy and lifecycle hooks", async () => {
  // Reinstall must refresh account policy and retain the post-write lifecycle boundary.
  const fixture = createInstallAccountPolicyFixture(
    tempDirs.make("openclaw-wizard-install-policy-"),
    "external-chat",
  );
  const cfg = fixture.config;
  const beforeInstall = fixture.readMetadata();
  const resolveMetadata = vi
    .spyOn(pluginMetadata, "resolvePluginMetadataSnapshot")
    .mockImplementation(({ config, workspaceDir }) => fixture.readMetadata(config, workspaceDir));
  const readAccount = (config: OpenClawConfig) =>
    resolveChannelAccountEntry(
      asOptionalRecord(asOptionalRecord(config.channels?.["external-chat"])?.accounts),
      "work-phone",
      "external-chat",
    );
  const statusAccounts: unknown[] = [];
  const postWriteAccounts: unknown[] = [];
  const hooks: ChannelOnboardingPostWriteHook[] = [];
  const configure = vi.fn(async ({ cfg: current }: { cfg: OpenClawConfig }) => ({
    cfg: applyAccountNameToChannelSection({
      cfg: current,
      channelKey: "external-chat",
      accountId: "work-phone",
      name: "Work calls",
    }),
    accountId: "work-phone",
  }));

  discoverExternal("installed");
  // The runtime only becomes available after reinstall.
  loadSetupRegistry.mockReturnValueOnce(makePluginRegistry()).mockImplementation(() => {
    const instance = new PluginInstance("installed-channel");
    getPluginCache().instances.add(instance);
    const externalChatPlugin = makeExternalChatSetupPlugin({
      configure,
      configureInteractive: instance.wrap(configure),
      getStatus: instance.wrap(async ({ cfg: current }) => {
        const account = readAccount(current);
        statusAccounts.push(account);
        return { channel: "external-chat", configured: Boolean(account), statusLines: [] };
      }),
      afterConfigWritten: instance.wrap(({ cfg: current }) => {
        expect(hasPluginLifecycleLease()).toBe(false);
        postWriteAccounts.push(readAccount(current));
      }),
    });
    return externalRegistry(externalChatPlugin, false);
  });
  installPlugin.mockImplementationOnce(async () => {
    expect(hasPluginLifecycleLease()).toBe(true);
    fixture.installPolicy();
    return installResult(cfg);
  });
  channelConfigured.mockReturnValue(false);
  const note = vi.fn(async () => undefined);
  const select = selectExternal();

  try {
    await using cache = createPluginCache();
    await withPluginCache(cache, async () => {
      const next = await withPluginMetadataSnapshotScope(beforeInstall, () => {
        expect(readAccount(cfg)).toBeUndefined();
        return runDeferred(
          cfg,
          { note, select },
          {
            onPostWriteHook: (hook) => hooks.push(hook),
          },
        );
      });
      const account = { account: "+12025550123", name: "Work calls" };
      expect(next.channels?.["external-chat"]).toEqual({ accounts: { "Work Phone": account } });
      expect(statusAccounts.at(-1)).toEqual(account);
      expect(hooks).toHaveLength(1);
      await withPluginMetadataSnapshotScope(fixture.readMetadata(next), () =>
        expectDefined(hooks[0], "collected setup hook").run({
          cfg: next,
          runtime: createTestRuntime(),
        }),
      );
      expect(postWriteAccounts).toEqual([account]);
    });
    expect(installPlugin).toHaveBeenCalledTimes(1);
    expectExternalCatalogInstallCall();
    expect(note).not.toHaveBeenCalledWith("external-chat plugin not available.", "Channel setup");
    expect(configure).toHaveBeenCalledTimes(1);
  } finally {
    resolveMetadata.mockRestore();
  }
});

it("auto-installs stale channel config from empty discovery buckets", async () => {
  // Stale config excludes the channel from installable entries; its missing plugin
  // also excludes it from installed entries, so setup must consult the catalog.
  const configure = vi.fn(async ({ cfg }: { cfg: Record<string, unknown> }) => ({
    cfg: { ...cfg, channels: { "external-chat": { token: "secret" } } },
  }));
  const externalChatPlugin = makeExternalChatSetupPlugin({ configure });
  discoverChannels.mockReturnValue(externalChatSetupEntries());
  const fallbackCatalogEntry = externalChatCatalogEntry();
  catalogEntry.mockReturnValue(fallbackCatalogEntry);
  installPlugin.mockResolvedValueOnce(installResult({}, true));
  loadSetupRegistry.mockReturnValue(externalRegistry(externalChatPlugin, false));
  channelConfigured.mockReturnValue(false);
  const note = vi.fn(async () => undefined);
  const select = selectExternal();

  await runDeferred({}, { note, select });

  expect(catalogEntry.mock.calls[0]).toMatchObject([
    "external-chat",
    { workspaceDir: "/tmp/openclaw-workspace" },
  ]);
  expect(installPlugin).toHaveBeenCalledTimes(1);
  expectExternalCatalogInstallCall();
  expect(note).not.toHaveBeenCalledWith("external-chat plugin not available.", "Channel setup");
  expect(configure).toHaveBeenCalledTimes(1);
});

it("returns to selection when catalog-fallback installation is declined", async () => {
  discoverChannels.mockReturnValue(externalChatSetupEntries());
  const fallbackCatalogEntry = externalChatCatalogEntry();
  catalogEntry.mockReturnValue(fallbackCatalogEntry);
  installPlugin.mockResolvedValueOnce(installResult({}, false));
  channelConfigured.mockReturnValue(false);
  let quickstartSelectionCount = 0;
  const select = vi.fn(async ({ message }: { message: string }) => {
    if (message === "Select channel (QuickStart)") {
      quickstartSelectionCount += 1;
      if (quickstartSelectionCount === 1) {
        return "external-chat";
      }
    }
    return "__skip__";
  });
  const note = vi.fn(async () => undefined);

  await runChannelSetup({}, { note, select }, QUICKSTART_CHANNEL_SETUP_OPTIONS);

  expect(installPlugin).toHaveBeenCalledTimes(1);
  expect(quickstartSelectionCount).toBe(2);
  expect(note).not.toHaveBeenCalledWith("external-chat plugin not available.", "Channel setup");
});

it("fails closed when the catalog-fallback install guard rejects", async () => {
  discoverChannels.mockReturnValue(externalChatSetupEntries());
  const fallbackCatalogEntry = externalChatCatalogEntry();
  catalogEntry.mockReturnValue(fallbackCatalogEntry);
  channelConfigured.mockReturnValue(false);
  const guardError = new Error("verified inference owner changed");
  const beforePersistentEffect = vi.fn(async () => {
    throw guardError;
  });
  installPlugin.mockImplementationOnce(async (params) => {
    await params.beforePersistentEffect?.();
    return installResult(params.cfg, true, params.entry.pluginId);
  });
  const select = vi.fn().mockResolvedValueOnce("external-chat");

  await expect(
    runDeferred(
      {},
      { select },
      {
        beforePersistentEffect,
      },
    ),
  ).rejects.toBe(guardError);

  expect(installPlugin).toHaveBeenCalledTimes(1);
  expect(beforePersistentEffect).toHaveBeenCalledTimes(1);
});

it.each(["empty discovery", "installed catalog"] as const)(
  "refuses disabled-plugin fallback from %s",
  async (source) => {
    // Eager mode reaches each install fallback guard, not the deferred-picker guard.
    if (source === "installed catalog") {
      discoverExternal("installed");
      loadSetupRegistry.mockReturnValue(makePluginRegistry());
      channelConfigured.mockReturnValue(false);
    } else {
      discoverChannels.mockReturnValue(externalChatSetupEntries());
      catalogEntry.mockReturnValue(externalChatCatalogEntry());
    }
    const note = vi.fn(async () => undefined);
    await runChannelSetup(
      disabledExternalPluginConfig,
      { note, select: selectExternal() },
      {
        skipConfirm: true,
        skipDmPolicyPrompt: true,
      },
    );
    expect(installPlugin).not.toHaveBeenCalled();
    expect(note).toHaveBeenCalledWith(
      "external-chat cannot be configured while plugin disabled. Enable it before setup.",
      "Channel setup",
    );
  },
);
