// Channel setup tests cover setup flow prompts and config output.
import { expectDefined } from "@openclaw/normalization-core/expect";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

type ChannelSetupPlugin = import("../channels/plugins/setup-wizard-types.js").ChannelSetupPlugin;

function externalChatCatalogEntry() {
  return makeCatalogEntry("external-chat", "External Chat", {
    pluginId: "@vendor/external-chat-plugin",
    install: { npmSpec: "@vendor/external-chat-plugin" },
  });
}

function callArg<T>(mock: { mock: { calls: unknown[][] } }, index = 0, _type?: (value: T) => T): T {
  const call = expectDefined(mock.mock.calls[index], `mock call ${index}`);
  return call[0] as T;
}

function expectExternalCatalogInstallCall(index = 0) {
  const input = callArg<{
    entry?: { id?: string; install?: { npmSpec?: string } };
    autoConfirmSingleSource?: boolean;
  }>(ensureChannelSetupPluginInstalled, index);
  expect(input.entry?.id).toBe("external-chat");
  expect(input.entry?.install?.npmSpec).toBe("@vendor/external-chat-plugin");
  expect(input.autoConfirmSingleSource).toBe(true);
}

const {
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
  listTrustedChannelPluginCatalogEntries,
  getTrustedChannelPluginCatalogEntry,
  getChannelSetupPlugin,
  listChannelSetupPlugins,
  listActiveChannelSetupPlugins,
  loadChannelSetupPluginRegistrySnapshotForChannel,
  ensureChannelSetupPluginInstalled,
  resolveChannelSetupEntries,
  collectChannelStatus,
  resolveChannelSetupWorkspaceDir,
  isChannelConfigured,
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
  return setupChannels(
    cfg,
    {} as never,
    {
      confirm: vi.fn(async () => true),
      note: vi.fn(async () => undefined),
      ...prompter,
    } as never,
    options,
  );
}

describe("setupChannels workspace shadow exclusion", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  beforeEach(() => {
    vi.clearAllMocks();
    resolveAgentWorkspaceDir.mockReturnValue("/tmp/openclaw-workspace");
    resolveDefaultAgentId.mockReturnValue("default");
    resolveChannelSetupWorkspaceDir.mockReturnValue("/tmp/openclaw-workspace");
    listTrustedChannelPluginCatalogEntries.mockReturnValue([
      {
        id: "external-chat",
        pluginId: "@vendor/external-chat-plugin",
        origin: "bundled",
      },
    ]);
    getTrustedChannelPluginCatalogEntry.mockReturnValue(undefined);
    getChannelSetupPlugin.mockReturnValue(undefined);
    listActiveChannelSetupPlugins.mockReturnValue([]);
    listChannelSetupPlugins.mockReturnValue([]);
    loadChannelSetupPluginRegistrySnapshotForChannel.mockReturnValue(makePluginRegistry());
    ensureChannelSetupPluginInstalled.mockImplementation(async ({ cfg, entry }) => ({
      cfg,
      installed: true,
      pluginId: entry?.pluginId,
      status: "installed",
    }));
    resolveChannelSetupEntries.mockReturnValue(makeChannelSetupEntries());
    collectChannelStatus.mockResolvedValue({
      installedPlugins: [],
      catalogEntries: [],
      installedCatalogEntries: [],
      statusByChannel: new Map(),
      statusLines: [],
    });
    isChannelConfigured.mockReturnValue(true);
  });

  it("resolves plugin discovery through the channel setup workspace owner", async () => {
    const cfg = {
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "main" } },
        entries: { main: {}, helper: {}, third: {} },
      },
    } as unknown as OpenClawConfig;
    resolveDefaultAgentId.mockImplementationOnce(() => {
      throw new Error("legacy default resolver must not own channel setup");
    });

    await runChannelSetup(cfg, { confirm: vi.fn(async () => false) });

    expect(resolveChannelSetupWorkspaceDir).toHaveBeenCalledWith(cfg);
  });

  it("does not load or probe channels when optional deferred setup is declined", async () => {
    const cfg = { agents: { ownership: "explicit" as const, entries: { alpha: {}, beta: {} } } };

    const result = await runChannelSetup(
      cfg,
      { confirm: vi.fn(async () => false) },
      { workspaceDir: "/tmp/beta-workspace", deferStatusUntilSelection: true },
    );

    expect(result).toBe(cfg);
    expect(collectChannelStatus).not.toHaveBeenCalled();
    expect(listTrustedChannelPluginCatalogEntries).not.toHaveBeenCalled();
    expect(loadChannelSetupPluginRegistrySnapshotForChannel).not.toHaveBeenCalled();
  });

  it("keeps trusted workspace overrides eligible during preload", async () => {
    listTrustedChannelPluginCatalogEntries.mockReturnValue([
      { id: "external-chat", pluginId: "trusted-external-chat-shadow", origin: "workspace" },
    ]);

    const cfg = { plugins: { enabled: true, allow: ["trusted-external-chat-shadow"] } };
    await runChannelSetup(cfg, { confirm: vi.fn(async () => false) });

    expect(listTrustedChannelPluginCatalogEntries).toHaveBeenCalledWith({
      cfg,
      workspaceDir: "/tmp/openclaw-workspace",
    });
    const registryInput = callArg<{
      channel?: string;
      pluginId?: string;
      workspaceDir?: string;
    }>(loadChannelSetupPluginRegistrySnapshotForChannel);
    expect(registryInput.channel).toBe("external-chat");
    expect(registryInput.pluginId).toBe("trusted-external-chat-shadow");
    expect(registryInput.workspaceDir).toBe("/tmp/openclaw-workspace");
  });

  it("defers status and setup-plugin loads until a channel is selected", async () => {
    resolveChannelSetupEntries.mockReturnValue(externalChatSetupEntries());
    const select = vi.fn(async () => "__done__");

    await runChannelSetup(
      {},
      { select },
      {
        deferStatusUntilSelection: true,
        skipConfirm: true,
      },
    );

    expect(callArg<{ message?: string }>(select).message).toBe("Select a channel");
    expect(collectChannelStatus).not.toHaveBeenCalled();
    expect(listTrustedChannelPluginCatalogEntries).not.toHaveBeenCalled();
    expect(listChannelSetupPlugins).not.toHaveBeenCalled();
    expect(getChannelSetupPlugin).not.toHaveBeenCalled();
    expect(loadChannelSetupPluginRegistrySnapshotForChannel).not.toHaveBeenCalled();
  });

  it("puts skip first and selected by default in QuickStart channel selection", async () => {
    resolveChannelSetupEntries.mockReturnValue(externalChatSetupEntries());
    const select = vi.fn(async () => "__skip__");

    await runChannelSetup(
      {},
      { select },
      {
        deferStatusUntilSelection: true,
        quickstartDefaults: true,
        skipConfirm: true,
      },
    );

    const prompt = callArg<{
      message?: string;
      options?: Array<{ value: string; label: string }>;
      initialValue?: string;
      searchable?: boolean;
    }>(select);
    expect(prompt.message).toBe("Select channel (QuickStart)");
    expect(prompt.options?.[0]).toEqual(
      expect.objectContaining({
        value: "__skip__",
        label: "Skip for now",
      }),
    );
    expect(prompt.initialValue).toBe("__skip__");
    expect(prompt.searchable).toBe(true);
  });

  it("keeps already-active setup plugins in the deferred picker without registry fallback", async () => {
    const activePlugin = {
      ...makeSetupPlugin({ id: "custom-chat", label: "Custom Chat" }),
    };
    listActiveChannelSetupPlugins.mockReturnValue([activePlugin]);
    resolveChannelSetupEntries.mockImplementation(() => ({
      entries: [],
      installedCatalogEntries: [],
      installableCatalogEntries: [],
      installedCatalogById: new Map(),
      installableCatalogById: new Map(),
    }));
    const select = vi.fn(async () => "__done__");

    await runChannelSetup(
      {},
      { select },
      {
        deferStatusUntilSelection: true,
        skipConfirm: true,
      },
    );

    expect(
      callArg<{ installedPlugins?: unknown[] }>(resolveChannelSetupEntries).installedPlugins,
    ).toEqual([activePlugin]);
    expect(listChannelSetupPlugins).not.toHaveBeenCalled();
    expect(collectChannelStatus).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "enables an active setup plugin when explicitly selected (deferred=%s)",
    async (deferStatusUntilSelection) => {
      listTrustedChannelPluginCatalogEntries.mockReturnValue([]);
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
            channels: {
              "custom-chat": { token: "secret" },
            },
          },
        })),
      };
      const activePlugin = makeSetupPlugin({
        id: "custom-chat",
        label: "Custom Chat",
        setupWizard,
      });
      listActiveChannelSetupPlugins.mockReturnValue([activePlugin]);
      resolveChannelSetupEntries.mockReturnValue(
        makeChannelSetupEntries({
          entries: [
            {
              id: "custom-chat",
              meta: makeMeta("custom-chat", "Custom Chat"),
            },
          ],
          installedCatalogEntries: [],
          installableCatalogEntries: [],
          installedCatalogById: new Map(),
          installableCatalogById: new Map(),
        }),
      );
      const select = vi.fn().mockResolvedValueOnce("custom-chat").mockResolvedValueOnce("__done__");

      const next = await runChannelSetup(
        {},
        { select },
        {
          ...DEFERRED_CHANNEL_SETUP_OPTIONS,
          deferStatusUntilSelection,
        },
      );

      expect(loadChannelSetupPluginRegistrySnapshotForChannel).not.toHaveBeenCalled();
      expect(callArg<{ cfg?: unknown }>(setupWizard.configure).cfg).toEqual({
        plugins: {
          entries: {
            "custom-chat": { enabled: true },
          },
        },
      });
      expect(next).toEqual({
        plugins: {
          entries: {
            "custom-chat": { enabled: true },
          },
        },
        channels: {
          "custom-chat": { token: "secret" },
        },
      });
    },
  );

  it("normalizes official external compatibility output from interactive setup", async () => {
    const setupWizard = {
      channel: "qqbot",
      getStatus: vi.fn(async () => ({
        channel: "qqbot",
        configured: false,
        statusLines: [],
      })),
      configure: vi.fn(async () => ({
        cfg: {
          channels: {
            qqbot: {
              appId: "app-id",
              clientSecret: "secret",
              allowFrom: ["*"],
            },
          },
        },
      })),
    };
    const activePlugin = makeSetupPlugin({ id: "qqbot", label: "QQ Bot", setupWizard });
    listActiveChannelSetupPlugins.mockReturnValue([activePlugin]);
    resolveChannelSetupEntries.mockReturnValue(
      makeChannelSetupEntries({
        entries: [{ id: "qqbot", meta: makeMeta("qqbot", "QQ Bot") }],
      }),
    );
    const select = vi.fn().mockResolvedValueOnce("qqbot").mockResolvedValueOnce("__done__");

    const next = await runChannelSetup({}, { select }, DEFERRED_CHANNEL_SETUP_OPTIONS);

    expect(next.channels?.qqbot).toMatchObject({
      dmPolicy: "open",
      allowFrom: ["openclaw:approval-disabled"],
    });
  });

  it("allowlists ClickClack when it is explicitly selected for setup", async () => {
    const setupWizard = {
      channel: "clickclack",
      getStatus: vi.fn(async () => ({
        channel: "clickclack",
        configured: false,
        statusLines: [],
      })),
      configure: vi.fn(async ({ cfg }: { cfg: OpenClawConfig }) => ({
        cfg: {
          ...cfg,
          channels: {
            ...cfg.channels,
            clickclack: {
              ...cfg.channels?.clickclack,
              token: "secret",
            },
          },
        },
      })),
    };
    const clickClackPlugin = makeSetupPlugin({
      id: "clickclack",
      label: "ClickClack",
      setupWizard,
    });
    resolveChannelSetupEntries.mockReturnValue(
      makeChannelSetupEntries({
        entries: [
          {
            id: "clickclack",
            meta: makeMeta("clickclack", "ClickClack"),
          },
        ],
      }),
    );
    loadChannelSetupPluginRegistrySnapshotForChannel.mockReturnValue(
      makePluginRegistry({
        channelSetups: [
          {
            pluginId: "clickclack",
            source: "bundled",
            enabled: true,
            plugin: clickClackPlugin,
          },
        ],
      }),
    );
    const select = vi.fn().mockResolvedValueOnce("clickclack").mockResolvedValueOnce("__done__");

    const next = await runChannelSetup(
      {
        plugins: {
          allow: ["memory-core"],
        },
      } as never,
      { select },
      DEFERRED_CHANNEL_SETUP_OPTIONS,
    );

    expect(next.plugins?.allow).toEqual(["memory-core", "clickclack"]);
    expect(next.plugins?.entries?.clickclack?.enabled).toBe(true);
    expect(next.channels?.clickclack).toEqual({
      enabled: true,
      token: "secret",
    });
  });

  it("loads the selected bundled catalog plugin without writing explicit plugin enablement", async () => {
    const configure = vi.fn(async ({ cfg }: { cfg: Record<string, unknown> }) => ({
      cfg: {
        ...cfg,
        channels: {
          "external-chat": { token: "secret" },
        },
      } as never,
    }));
    const externalChatPlugin = makeExternalChatSetupPlugin({ configure });
    const installedCatalogEntry = makeCatalogEntry("external-chat", "External Chat", {
      pluginId: "external-chat",
      origin: "bundled",
    });
    resolveChannelSetupEntries.mockReturnValue(
      externalChatSetupEntries({
        installedCatalogEntries: [installedCatalogEntry],
        installedCatalogById: new Map([["external-chat", installedCatalogEntry]]),
      }),
    );
    loadChannelSetupPluginRegistrySnapshotForChannel.mockReturnValue(
      makePluginRegistry({
        channels: [
          {
            pluginId: "external-chat",
            source: "bundled",
            plugin: externalChatPlugin,
          },
        ],
      }),
    );
    const select = vi.fn().mockResolvedValueOnce("external-chat").mockResolvedValueOnce("__done__");

    const next = await runChannelSetup({}, { select }, DEFERRED_CHANNEL_SETUP_OPTIONS);

    expect(loadChannelSetupPluginRegistrySnapshotForChannel).toHaveBeenCalledTimes(2);
    const firstRegistryInput = callArg<{
      channel?: string;
      pluginId?: string;
      workspaceDir?: string;
      forceSetupOnlyChannelPlugins?: boolean;
    }>(loadChannelSetupPluginRegistrySnapshotForChannel, 0);
    expect(firstRegistryInput.channel).toBe("external-chat");
    expect(firstRegistryInput.pluginId).toBe("external-chat");
    expect(firstRegistryInput.workspaceDir).toBe("/tmp/openclaw-workspace");
    expect(firstRegistryInput.forceSetupOnlyChannelPlugins).toBe(true);
    const secondRegistryInput = callArg<{
      channel?: string;
      workspaceDir?: string;
      forceSetupOnlyChannelPlugins?: boolean;
    }>(loadChannelSetupPluginRegistrySnapshotForChannel, 1);
    expect(secondRegistryInput.channel).toBe("external-chat");
    expect(secondRegistryInput.workspaceDir).toBe("/tmp/openclaw-workspace");
    expect(secondRegistryInput.forceSetupOnlyChannelPlugins).toBe(true);
    expect(getChannelSetupPlugin).not.toHaveBeenCalled();
    expect(collectChannelStatus).not.toHaveBeenCalled();
    expect(callArg<{ cfg?: unknown }>(configure).cfg).toEqual({});
    expect(next).toEqual({
      channels: {
        "external-chat": { token: "secret" },
      },
    });
  });

  it("returns to quickstart selection when install-on-demand is skipped", async () => {
    const configure = vi.fn(async ({ cfg }: { cfg: Record<string, unknown> }) => ({ cfg }));
    const externalChatPlugin = makeExternalChatSetupPlugin({ configure });
    const installableCatalogEntry = makeCatalogEntry("external-chat", "External Chat", {
      pluginId: "@vendor/external-chat-plugin",
    });
    resolveChannelSetupEntries.mockReturnValue(
      externalChatSetupEntries({
        installableCatalogEntries: [installableCatalogEntry],
        installableCatalogById: new Map([["external-chat", installableCatalogEntry]]),
      }),
    );
    ensureChannelSetupPluginInstalled
      .mockResolvedValueOnce({
        cfg: {},
        installed: false,
        pluginId: "@vendor/external-chat-plugin",
        status: "skipped",
      })
      .mockResolvedValueOnce({
        cfg: {},
        installed: true,
        pluginId: "@vendor/external-chat-plugin",
        status: "installed",
      });
    loadChannelSetupPluginRegistrySnapshotForChannel.mockReturnValue(
      makePluginRegistry({
        channelSetups: [
          {
            pluginId: "@vendor/external-chat-plugin",
            source: "global",
            enabled: true,
            plugin: externalChatPlugin,
          },
        ],
      }),
    );
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
    expect(ensureChannelSetupPluginInstalled).toHaveBeenCalledTimes(2);
    expect(configure).toHaveBeenCalledTimes(1);
  });

  it("returns an external install confirmation to channel selection before installing", async () => {
    const installableCatalogEntry = makeCatalogEntry("external-chat", "External Chat", {
      pluginId: "@vendor/external-chat-plugin",
    });
    resolveChannelSetupEntries.mockReturnValue(
      externalChatSetupEntries({
        installableCatalogEntries: [installableCatalogEntry],
        installableCatalogById: new Map([["external-chat", installableCatalogEntry]]),
      }),
    );
    ensureChannelSetupPluginInstalled.mockImplementationOnce(async ({ cfg, prompter }) => {
      await prompter.confirm({
        message: "Install External Chat?",
        initialValue: true,
      });
      return {
        cfg,
        installed: true,
        pluginId: "@vendor/external-chat-plugin",
        status: "installed",
      };
    });
    const select = vi.fn().mockResolvedValueOnce("external-chat").mockResolvedValueOnce("__done__");
    const confirm = vi.fn(async () => {
      throw new WizardNavigationError("back");
    });
    const cfg = { channels: { telegram: { botToken: "keep" } } } as OpenClawConfig;

    const result = await runChannelSetup(cfg, { confirm, select }, DEFERRED_CHANNEL_SETUP_OPTIONS);

    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Install External Chat?",
        navigation: { canGoBack: true, canGoForward: false },
      }),
    );
    expect(loadChannelSetupPluginRegistrySnapshotForChannel).not.toHaveBeenCalled();
    expect(result).toEqual(cfg);
  });

  it.each(["installed-catalog", "trusted-catalog-fallback"] as const)(
    "returns the %s reinstall confirmation to channel selection",
    async (source) => {
      const catalogEntry = externalChatCatalogEntry();
      resolveChannelSetupEntries.mockReturnValue(
        source === "installed-catalog"
          ? externalChatSetupEntries({
              installedCatalogEntries: [catalogEntry],
              installedCatalogById: new Map([["external-chat", catalogEntry]]),
            })
          : externalChatSetupEntries(),
      );
      if (source === "trusted-catalog-fallback") {
        getTrustedChannelPluginCatalogEntry.mockReturnValue(catalogEntry);
      }
      loadChannelSetupPluginRegistrySnapshotForChannel.mockReturnValue(makePluginRegistry());
      ensureChannelSetupPluginInstalled.mockImplementationOnce(async ({ cfg, prompter }) => {
        await prompter.confirm({
          message: "Reinstall External Chat?",
          initialValue: true,
        });
        return {
          cfg,
          installed: true,
          pluginId: "@vendor/external-chat-plugin",
          status: "installed",
        };
      });
      const confirm = vi.fn(async () => {
        throw new WizardNavigationError("back");
      });
      const cfg = { channels: { "external-chat": { token: "keep" } } } as OpenClawConfig;

      const result = await runChannelSetup(
        cfg,
        {
          confirm,
          select: vi.fn().mockResolvedValueOnce("external-chat").mockResolvedValueOnce("__done__"),
        },
        DEFERRED_CHANNEL_SETUP_OPTIONS,
      );

      expect(confirm).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Reinstall External Chat?",
          navigation: { canGoBack: true, canGoForward: false },
        }),
      );
      expect(result).toEqual(cfg);
    },
  );

  it("enters an explicitly targeted channel before the generic setup prompts", async () => {
    const promptOrder: string[] = [];
    const configureInteractive = vi.fn(async ({ cfg }) => {
      promptOrder.push("channel setup");
      return {
        cfg: {
          ...cfg,
          channels: { ...cfg.channels, "external-chat": { token: "configured" } },
        },
        accountId: "external-account",
      };
    });
    const externalChatPlugin = makeExternalChatSetupPlugin({
      configure: vi.fn(),
      configureInteractive,
    });
    resolveChannelSetupEntries.mockReturnValue(externalChatSetupEntries());
    listActiveChannelSetupPlugins.mockReturnValue([externalChatPlugin]);
    const confirm = vi.fn(async () => {
      promptOrder.push("setup confirmation");
      return true;
    });
    const select = vi.fn(async () => {
      promptOrder.push("channel picker");
      return "__done__";
    });

    const result = await runChannelSetup({}, { confirm, select }, TARGETED_CHANNEL_SETUP_OPTIONS);

    expect(promptOrder).toEqual(["channel setup"]);
    expect(confirm).not.toHaveBeenCalled();
    expect(configureInteractive).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      channels: { "external-chat": { token: "configured" } },
      plugins: { entries: { "external-chat": { enabled: true } } },
    });
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
    resolveChannelSetupEntries.mockReturnValue(externalChatSetupEntries());
    listActiveChannelSetupPlugins.mockReturnValue([externalChatPlugin]);

    await expect(
      runChannelSetup(
        {},
        {
          select: vi.fn(async () => "__done__"),
        },
        TARGETED_CHANNEL_SETUP_OPTIONS,
      ),
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
    const externalChatPlugin = makeExternalChatSetupPlugin({
      getStatus,
      configure: vi.fn(async ({ cfg }) => ({
        cfg: {
          ...cfg,
          channels: { ...cfg.channels, "external-chat": { token: "configured" } },
        },
        accountId: "external-account",
      })),
    });
    resolveChannelSetupEntries.mockReturnValue(externalChatSetupEntries());
    listActiveChannelSetupPlugins.mockReturnValue([externalChatPlugin]);
    const note = vi.fn(async () => undefined);

    const result = await runChannelSetup(
      {},
      { note, select: vi.fn(async () => "__done__") },
      TARGETED_CHANNEL_SETUP_OPTIONS,
    );

    expect(result).toMatchObject({
      channels: { "external-chat": { token: "configured" } },
    });
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
        cfg: {
          channels: { "external-chat": { token: "should-not-apply" } },
        } as OpenClawConfig,
        accountId: "external-account",
      };
    });
    const externalChatPlugin = makeExternalChatSetupPlugin({
      configure: vi.fn(),
      configureInteractive,
    });
    resolveChannelSetupEntries.mockReturnValue(externalChatSetupEntries());
    listActiveChannelSetupPlugins.mockReturnValue([externalChatPlugin]);
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
    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Select a channel",
      }),
    );
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
    const externalChatPlugin = makeExternalChatSetupPlugin({
      getStatus: vi.fn(async () => ({
        channel: "external-chat",
        configured: true,
        statusLines: [],
      })),
      configure: vi.fn(),
      configureWhenConfigured,
    });
    resolveChannelSetupEntries.mockReturnValue(externalChatSetupEntries());
    listActiveChannelSetupPlugins.mockReturnValue([externalChatPlugin]);
    const select = vi
      .fn()
      .mockResolvedValueOnce("external-chat")
      .mockRejectedValueOnce(new WizardNavigationError("back"))
      .mockResolvedValueOnce("__done__");
    const cfg = {
      channels: { "external-chat": { token: "keep" } },
    } as OpenClawConfig;

    const result = await runChannelSetup(cfg, { select }, DEFERRED_CHANNEL_SETUP_OPTIONS);

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

  it("rolls back reversible plugin enablement when channel setup goes back", async () => {
    const configure = vi.fn(async ({ cfg, prompter }) => {
      await prompter.text({ message: "ClickClack token" });
      return { cfg };
    });
    const clickClackPlugin = makeSetupPlugin({
      id: "clickclack",
      label: "ClickClack",
      setupWizard: {
        channel: "clickclack",
        getStatus: vi.fn(async () => ({
          channel: "clickclack",
          configured: false,
          statusLines: [],
        })),
        configure,
      } as ChannelSetupPlugin["setupWizard"],
    });
    resolveChannelSetupEntries.mockReturnValue(
      makeChannelSetupEntries({
        entries: [{ id: "clickclack", meta: makeMeta("clickclack", "ClickClack") }],
      }),
    );
    loadChannelSetupPluginRegistrySnapshotForChannel.mockReturnValue(
      makePluginRegistry({
        channelSetups: [
          {
            pluginId: "clickclack",
            source: "bundled",
            enabled: true,
            plugin: clickClackPlugin,
          },
        ],
      }),
    );
    const select = vi.fn().mockResolvedValueOnce("clickclack").mockResolvedValueOnce("__done__");
    const text = vi.fn(async () => {
      throw new WizardNavigationError("back");
    });
    const cfg = { plugins: { allow: ["memory-core"] } } as OpenClawConfig;

    const result = await runChannelSetup(cfg, { select, text }, DEFERRED_CHANNEL_SETUP_OPTIONS);

    expect(configure).toHaveBeenCalledTimes(1);
    expect(text).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "ClickClack token",
        navigation: { canGoBack: true, canGoForward: false },
      }),
    );
    expect(select).toHaveBeenCalledTimes(2);
    expect(result).toEqual(cfg);
    expect(result.plugins?.allow).toEqual(["memory-core"]);
    expect(result.plugins?.entries?.clickclack).toBeUndefined();
  });

  it("preserves accepted external install metadata when later channel setup goes back", async () => {
    const configure = vi.fn(async ({ cfg, prompter }) => {
      await prompter.text({ message: "External Chat token" });
      return { cfg, accountId: "external-account" };
    });
    const externalChatPlugin = makeExternalChatSetupPlugin({ configure });
    const installableCatalogEntry = makeCatalogEntry("external-chat", "External Chat", {
      pluginId: "@vendor/external-chat-plugin",
    });
    resolveChannelSetupEntries.mockReturnValue(
      externalChatSetupEntries({
        installableCatalogEntries: [installableCatalogEntry],
        installableCatalogById: new Map([["external-chat", installableCatalogEntry]]),
      }),
    );
    loadChannelSetupPluginRegistrySnapshotForChannel.mockReturnValue(
      makePluginRegistry({
        channelSetups: [
          {
            pluginId: "@vendor/external-chat-plugin",
            source: "global",
            enabled: true,
            plugin: externalChatPlugin,
          },
        ],
      }),
    );
    ensureChannelSetupPluginInstalled.mockImplementationOnce(async (params) => {
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
    const select = vi.fn().mockResolvedValueOnce("external-chat").mockResolvedValueOnce("__done__");
    const beforePersistentEffect = vi.fn(async () => undefined);

    const result = await runChannelSetup(
      { channels: { telegram: { botToken: "keep" } } } as OpenClawConfig,
      {
        select,
        text: vi.fn(async () => {
          throw new WizardNavigationError("back");
        }),
      },
      {
        beforePersistentEffect,
        ...DEFERRED_CHANNEL_SETUP_OPTIONS,
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
    const externalChatPlugin = makeExternalChatSetupPlugin({ configure });
    resolveChannelSetupEntries.mockReturnValue(externalChatSetupEntries());
    listActiveChannelSetupPlugins.mockReturnValue([externalChatPlugin]);
    const text = vi
      .fn()
      .mockResolvedValueOnce("old-name")
      .mockRejectedValueOnce(new WizardNavigationError("back"))
      .mockResolvedValueOnce("new-name")
      .mockResolvedValueOnce("secret-token");

    const result = await runChannelSetup(
      {},
      {
        select: vi.fn().mockResolvedValueOnce("external-chat").mockResolvedValueOnce("__done__"),
        text,
      },
      DEFERRED_CHANNEL_SETUP_OPTIONS,
    );

    expect(configure).toHaveBeenCalledTimes(2);
    expect(result.channels?.["external-chat"]).toEqual({
      username: "new-name",
      token: "secret-token",
    });
    expect(expectDefined(text.mock.calls[2], "third text prompt call")[0]).toEqual(
      expect.objectContaining({
        initialValue: "old-name",
        navigation: { canGoBack: true, canGoForward: true },
      }),
    );
  });

  it("disables Back after a channel declares a persistent effect boundary", async () => {
    const configure = vi.fn(async ({ cfg, prompter, options }) => {
      await prompter.text({ message: "Before effect" });
      await options.beforePersistentEffect?.();
      await prompter.text({ message: "After effect" });
      return { cfg };
    });
    const externalChatPlugin = makeExternalChatSetupPlugin({ configure });
    resolveChannelSetupEntries.mockReturnValue(externalChatSetupEntries());
    listActiveChannelSetupPlugins.mockReturnValue([externalChatPlugin]);
    const navigationError = new WizardNavigationError("back");
    const text = vi.fn().mockResolvedValueOnce("ready").mockRejectedValueOnce(navigationError);
    const beforePersistentEffect = vi.fn(async () => undefined);

    await expect(
      runChannelSetup(
        {},
        {
          select: vi.fn().mockResolvedValueOnce("external-chat"),
          text,
        },
        {
          ...DEFERRED_CHANNEL_SETUP_OPTIONS,
          beforePersistentEffect,
        },
      ),
    ).rejects.toBe(navigationError);

    expect(beforePersistentEffect).toHaveBeenCalledTimes(1);
    expect(expectDefined(text.mock.calls[1], "second text prompt call")[0]).toEqual(
      expect.objectContaining({
        navigation: { canGoBack: false, canGoForward: false },
      }),
    );
  });

  it("propagates Ctrl-C cancellation from channel setup", async () => {
    const cancelled = new WizardCancelledError();
    const configure = vi.fn(async ({ prompter }) => {
      await prompter.text({ message: "Token" });
      return { cfg: {} as OpenClawConfig };
    });
    const externalChatPlugin = makeExternalChatSetupPlugin({ configure });
    resolveChannelSetupEntries.mockReturnValue(externalChatSetupEntries());
    listActiveChannelSetupPlugins.mockReturnValue([externalChatPlugin]);

    await expect(
      runChannelSetup(
        {},
        {
          select: vi.fn().mockResolvedValueOnce("external-chat"),
          text: vi.fn(async () => {
            throw cancelled;
          }),
        },
        DEFERRED_CHANNEL_SETUP_OPTIONS,
      ),
    ).rejects.toBe(cancelled);
  });

  it("keeps an explicitly disabled channel unchanged when setup resume is declined", async () => {
    const configure = vi.fn();
    const externalChatPlugin = makeExternalChatSetupPlugin({
      getStatus: vi.fn(async () => ({
        channel: "external-chat",
        configured: true,
        statusLines: [],
      })),
      configure,
    });
    resolveChannelSetupEntries.mockReturnValue(externalChatSetupEntries());
    listActiveChannelSetupPlugins.mockReturnValue([externalChatPlugin]);
    const select = vi.fn().mockResolvedValueOnce("external-chat").mockResolvedValueOnce("__done__");
    const confirm = vi.fn(async () => false);
    const cfg = {
      channels: {
        "external-chat": { enabled: false, token: "secret" },
      },
    };

    const next = await runChannelSetup(
      cfg as never,
      { confirm, select },
      DEFERRED_CHANNEL_SETUP_OPTIONS,
    );

    expect(loadChannelSetupPluginRegistrySnapshotForChannel).not.toHaveBeenCalled();
    expect(confirm).toHaveBeenCalledWith({
      message: "external-chat is disabled. Enable it and continue setup now?",
      initialValue: true,
    });
    expect(configure).not.toHaveBeenCalled();
    expect(next).toEqual({
      channels: {
        "external-chat": { enabled: false, token: "secret" },
      },
    });
  });

  it("resumes an explicitly selected disabled channel without replacing its config", async () => {
    const configure = vi.fn(async ({ cfg }: { cfg: OpenClawConfig }) => ({
      cfg,
      accountId: "default",
    }));
    const externalChatPlugin = makeExternalChatSetupPlugin({
      getStatus: vi.fn(async () => ({
        channel: "external-chat",
        configured: true,
        statusLines: [],
      })),
      configure,
    });
    resolveChannelSetupEntries.mockReturnValue(externalChatSetupEntries());
    listActiveChannelSetupPlugins.mockReturnValue([externalChatPlugin]);
    const onSelection = vi.fn();
    const cfg = {
      channels: {
        "external-chat": { enabled: false, token: "saved-secret" },
      },
    };

    const next = await runChannelSetup(
      cfg as never,
      { select: vi.fn().mockResolvedValueOnce("external-chat").mockResolvedValueOnce("__done__") },
      { ...DEFERRED_CHANNEL_SETUP_OPTIONS, onSelection },
    );

    expect(configure).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: {
          channels: {
            "external-chat": { enabled: true, token: "saved-secret" },
          },
          plugins: {
            entries: {
              "external-chat": { enabled: true },
            },
          },
        },
      }),
    );
    expect(onSelection).toHaveBeenCalledWith(["external-chat"]);
    expect(next).toEqual({
      channels: {
        "external-chat": { enabled: true, token: "saved-secret" },
      },
      plugins: {
        entries: {
          "external-chat": { enabled: true },
        },
      },
    });
  });

  it("enables an explicitly selected disabled plugin and continues setup", async () => {
    const configure = vi.fn(async ({ cfg }: { cfg: OpenClawConfig }) => ({
      cfg,
      accountId: "default",
    }));
    const externalChatPlugin = makeExternalChatSetupPlugin({
      getStatus: vi.fn(async () => ({
        channel: "external-chat",
        configured: true,
        statusLines: [],
      })),
      configure,
    });
    resolveChannelSetupEntries.mockReturnValue(externalChatSetupEntries());
    listActiveChannelSetupPlugins.mockReturnValue([externalChatPlugin]);
    const confirm = vi.fn(async () => true);

    const next = await runChannelSetup(
      {
        channels: {
          "external-chat": { enabled: true, token: "saved-secret" },
        },
        plugins: {
          entries: {
            "external-chat": { enabled: false },
          },
        },
      } as never,
      {
        confirm,
        select: vi.fn().mockResolvedValueOnce("external-chat").mockResolvedValueOnce("__done__"),
      },
      DEFERRED_CHANNEL_SETUP_OPTIONS,
    );

    expect(confirm).toHaveBeenCalledWith({
      message: "external-chat plugin is disabled. Enable it and continue setup now?",
      initialValue: true,
    });
    expect(configure).toHaveBeenCalledOnce();
    expect(next.plugins?.entries?.["external-chat"]?.enabled).toBe(true);
    expect(next.channels?.["external-chat"]?.enabled).toBe(true);
  });

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
    const externalChatPlugin = makeExternalChatSetupPlugin({
      configure: vi.fn(async () => ({
        cfg: pausedConfig,
        completion: "paused" as const,
      })),
    });
    resolveChannelSetupEntries.mockReturnValue(externalChatSetupEntries());
    listActiveChannelSetupPlugins.mockReturnValue([externalChatPlugin]);
    const select = vi.fn().mockResolvedValue("external-chat");
    const onSelection = vi.fn();

    const next = await runChannelSetup(
      {},
      { select },
      { ...DEFERRED_CHANNEL_SETUP_OPTIONS, onSelection },
    );

    expect(select).toHaveBeenCalledOnce();
    expect(onSelection).toHaveBeenCalledWith([]);
    expect(next).toBe(pausedConfig);
  });

  it("honors global plugin disablement before lazy channel setup loads plugins", async () => {
    resolveChannelSetupEntries.mockReturnValue(externalChatSetupEntries());
    const select = vi.fn().mockResolvedValueOnce("external-chat").mockResolvedValueOnce("__done__");
    const note = vi.fn(async () => undefined);
    const cfg = {
      plugins: { enabled: false },
      channels: {
        "external-chat": { enabled: true, token: "secret" },
      },
    };

    await runChannelSetup(cfg as never, { note, select }, DEFERRED_CHANNEL_SETUP_OPTIONS);

    expect(loadChannelSetupPluginRegistrySnapshotForChannel).not.toHaveBeenCalled();
    expect(note).toHaveBeenCalledWith(
      "external-chat cannot be configured while plugins disabled. Enable it before setup.",
      "Channel setup",
    );
  });

  it(
    "setupChannels reinstalls the external plugin via catalog when a stale channel config " +
      "declares an already-installed plugin whose runtime cannot be loaded",
    async () => {
      // Regression: users who uninstalled an externalized channel plugin
      // (qqbot / imessage / discord / ...) while a non-empty
      // `channels.<id>` entry remained in their config got dead-ended with
      // "<channel> plugin not available" because the installed-catalog
      // branch did not fall back to the catalog install flow.
      const fixture = createInstallAccountPolicyFixture(
        tempDirs.make("openclaw-wizard-install-policy-"),
        "external-chat",
      );
      const cfg = fixture.config;
      const beforeInstall = fixture.readMetadata();
      const resolveMetadata = vi
        .spyOn(pluginMetadata, "resolvePluginMetadataSnapshot")
        .mockImplementation(({ config, workspaceDir }) =>
          fixture.readMetadata(config, workspaceDir),
        );
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

      const installedCatalogEntry = makeCatalogEntry("external-chat", "External Chat", {
        pluginId: "@vendor/external-chat-plugin",
        install: { npmSpec: "@vendor/external-chat-plugin" },
      });
      resolveChannelSetupEntries.mockReturnValue(
        externalChatSetupEntries({
          installedCatalogEntries: [installedCatalogEntry],
          installedCatalogById: new Map([["external-chat", installedCatalogEntry]]),
        }),
      );
      // The runtime only becomes available after reinstall.
      loadChannelSetupPluginRegistrySnapshotForChannel
        .mockReturnValueOnce(makePluginRegistry())
        .mockImplementation(() => {
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
          return makePluginRegistry({
            channels: [
              {
                pluginId: "@vendor/external-chat-plugin",
                source: "global",
                plugin: externalChatPlugin,
              },
            ],
          });
        });
      ensureChannelSetupPluginInstalled.mockImplementationOnce(async () => {
        expect(hasPluginLifecycleLease()).toBe(true);
        fixture.installPolicy();
        return {
          cfg,
          installed: true,
          pluginId: "@vendor/external-chat-plugin",
          status: "installed",
        };
      });
      isChannelConfigured.mockReturnValue(false);
      const note = vi.fn(async () => undefined);
      const select = vi
        .fn()
        .mockResolvedValueOnce("external-chat")
        .mockResolvedValueOnce("__done__");

      try {
        await using cache = createPluginCache();
        await withPluginCache(cache, async () => {
          const next = await withPluginMetadataSnapshotScope(beforeInstall, () => {
            expect(readAccount(cfg)).toBeUndefined();
            return runChannelSetup(
              cfg,
              { note, select },
              {
                ...DEFERRED_CHANNEL_SETUP_OPTIONS,
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
        expect(ensureChannelSetupPluginInstalled).toHaveBeenCalledTimes(1);
        expectExternalCatalogInstallCall();
        expect(note).not.toHaveBeenCalledWith(
          "external-chat plugin not available.",
          "Channel setup",
        );
        expect(configure).toHaveBeenCalledTimes(1);
      } finally {
        resolveMetadata.mockRestore();
      }
    },
  );

  it(
    "returns to channel selection when catalog-fallback install is declined " +
      "from the installed-catalog branch",
    async () => {
      const installedCatalogEntry = externalChatCatalogEntry();
      resolveChannelSetupEntries.mockReturnValue(
        externalChatSetupEntries({
          installedCatalogEntries: [installedCatalogEntry],
          installedCatalogById: new Map([["external-chat", installedCatalogEntry]]),
        }),
      );
      loadChannelSetupPluginRegistrySnapshotForChannel.mockReturnValue(makePluginRegistry());
      ensureChannelSetupPluginInstalled.mockResolvedValueOnce({
        cfg: {},
        installed: false,
        pluginId: "@vendor/external-chat-plugin",
        status: "skipped",
      });
      isChannelConfigured.mockReturnValue(false);
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

      expect(ensureChannelSetupPluginInstalled).toHaveBeenCalledTimes(1);
      expect(quickstartSelectionCount).toBe(2);
      expect(note).not.toHaveBeenCalledWith("external-chat plugin not available.", "Channel setup");
    },
  );

  it(
    "auto-installs external plugin from catalog when both discovery buckets " +
      "are empty due to a stale `channels.<id>` config entry",
    async () => {
      // Stale config excludes the channel from installable entries; its missing plugin
      // also excludes it from installed entries, so setup must consult the catalog.
      const configure = vi.fn(async ({ cfg }: { cfg: Record<string, unknown> }) => ({
        cfg: { ...cfg, channels: { "external-chat": { token: "secret" } } },
      }));
      const externalChatPlugin = makeExternalChatSetupPlugin({ configure });
      resolveChannelSetupEntries.mockReturnValue(
        externalChatSetupEntries({
          installedCatalogEntries: [],
          installableCatalogEntries: [],
          installedCatalogById: new Map(),
          installableCatalogById: new Map(),
        }),
      );
      const fallbackCatalogEntry = externalChatCatalogEntry();
      getTrustedChannelPluginCatalogEntry.mockReturnValue(fallbackCatalogEntry);
      ensureChannelSetupPluginInstalled.mockResolvedValueOnce({
        cfg: {},
        installed: true,
        pluginId: "@vendor/external-chat-plugin",
        status: "installed",
      });
      loadChannelSetupPluginRegistrySnapshotForChannel.mockReturnValue(
        makePluginRegistry({
          channels: [
            {
              pluginId: "@vendor/external-chat-plugin",
              source: "global",
              plugin: externalChatPlugin,
            },
          ],
        }),
      );
      isChannelConfigured.mockReturnValue(false);
      const note = vi.fn(async () => undefined);
      const select = vi
        .fn()
        .mockResolvedValueOnce("external-chat")
        .mockResolvedValueOnce("__done__");

      await runChannelSetup({}, { note, select }, DEFERRED_CHANNEL_SETUP_OPTIONS);

      const catalogLookupCall = expectDefined(
        getTrustedChannelPluginCatalogEntry.mock.calls[0],
        "catalog lookup call",
      ) as [string, { workspaceDir?: string } | undefined];
      expect(catalogLookupCall[0]).toBe("external-chat");
      expect(catalogLookupCall[1]?.workspaceDir).toBe("/tmp/openclaw-workspace");
      expect(ensureChannelSetupPluginInstalled).toHaveBeenCalledTimes(1);
      expectExternalCatalogInstallCall();
      expect(note).not.toHaveBeenCalledWith("external-chat plugin not available.", "Channel setup");
      expect(configure).toHaveBeenCalledTimes(1);
    },
  );

  it(
    "returns to channel selection when the catalog-fallback install is " +
      "declined from the bundled-enable branch",
    async () => {
      resolveChannelSetupEntries.mockReturnValue(externalChatSetupEntries());
      const fallbackCatalogEntry = externalChatCatalogEntry();
      getTrustedChannelPluginCatalogEntry.mockReturnValue(fallbackCatalogEntry);
      ensureChannelSetupPluginInstalled.mockResolvedValueOnce({
        cfg: {},
        installed: false,
        pluginId: "@vendor/external-chat-plugin",
        status: "skipped",
      });
      isChannelConfigured.mockReturnValue(false);
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

      expect(ensureChannelSetupPluginInstalled).toHaveBeenCalledTimes(1);
      expect(quickstartSelectionCount).toBe(2);
      expect(note).not.toHaveBeenCalledWith("external-chat plugin not available.", "Channel setup");
    },
  );

  it("fails closed when the catalog-fallback install guard rejects", async () => {
    resolveChannelSetupEntries.mockReturnValue(externalChatSetupEntries());
    const fallbackCatalogEntry = externalChatCatalogEntry();
    getTrustedChannelPluginCatalogEntry.mockReturnValue(fallbackCatalogEntry);
    isChannelConfigured.mockReturnValue(false);
    const guardError = new Error("verified inference owner changed");
    const beforePersistentEffect = vi.fn(async () => {
      throw guardError;
    });
    ensureChannelSetupPluginInstalled.mockImplementationOnce(async (params) => {
      await params.beforePersistentEffect?.();
      return {
        cfg: params.cfg,
        installed: true,
        pluginId: params.entry.pluginId,
        status: "installed",
      };
    });
    const select = vi.fn().mockResolvedValueOnce("external-chat");

    await expect(
      runChannelSetup(
        {},
        { select },
        {
          ...DEFERRED_CHANNEL_SETUP_OPTIONS,
          beforePersistentEffect,
        },
      ),
    ).rejects.toBe(guardError);

    expect(ensureChannelSetupPluginInstalled).toHaveBeenCalledTimes(1);
    expect(beforePersistentEffect).toHaveBeenCalledTimes(1);
  });

  it(
    "refuses catalog-fallback install from empty discovery buckets when the " +
      "channel is explicitly disabled in config",
    async () => {
      // Omit deferred mode to isolate the fallback guard from the earlier picker guard.
      resolveChannelSetupEntries.mockReturnValue(externalChatSetupEntries());
      const fallbackCatalogEntry = externalChatCatalogEntry();
      getTrustedChannelPluginCatalogEntry.mockReturnValue(fallbackCatalogEntry);
      const select = vi
        .fn()
        .mockResolvedValueOnce("external-chat")
        .mockResolvedValueOnce("__done__");
      const note = vi.fn(async () => undefined);
      const cfg = {
        plugins: { entries: { "external-chat": { enabled: false } } },
        channels: {
          "external-chat": {
            enabled: true,
            appId: "999999",
            clientSecret: "stale",
          },
        },
      };

      await runChannelSetup(
        cfg as never,
        { note, select },
        {
          skipConfirm: true,
          skipDmPolicyPrompt: true,
        },
      );

      expect(ensureChannelSetupPluginInstalled).not.toHaveBeenCalled();
      expect(note).toHaveBeenCalledWith(
        "external-chat cannot be configured while plugin disabled. Enable it before setup.",
        "Channel setup",
      );
    },
  );

  it(
    "refuses the installed-catalog install fallback when the channel is " +
      "explicitly disabled in config",
    async () => {
      // Omit deferred mode to isolate the installed-catalog fallback guard.
      const installedCatalogEntry = externalChatCatalogEntry();
      resolveChannelSetupEntries.mockReturnValue(
        externalChatSetupEntries({
          installedCatalogEntries: [installedCatalogEntry],
          installedCatalogById: new Map([["external-chat", installedCatalogEntry]]),
        }),
      );
      loadChannelSetupPluginRegistrySnapshotForChannel.mockReturnValue(makePluginRegistry());
      isChannelConfigured.mockReturnValue(false);
      const select = vi
        .fn()
        .mockResolvedValueOnce("external-chat")
        .mockResolvedValueOnce("__done__");
      const note = vi.fn(async () => undefined);
      const cfg = {
        plugins: { entries: { "external-chat": { enabled: false } } },
        channels: {
          "external-chat": {
            enabled: true,
            appId: "999999",
            clientSecret: "stale",
          },
        },
      };

      await runChannelSetup(
        cfg as never,
        { note, select },
        {
          skipConfirm: true,
          skipDmPolicyPrompt: true,
        },
      );

      expect(ensureChannelSetupPluginInstalled).not.toHaveBeenCalled();
      expect(note).toHaveBeenCalledWith(
        "external-chat cannot be configured while plugin disabled. Enable it before setup.",
        "Channel setup",
      );
    },
  );
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
