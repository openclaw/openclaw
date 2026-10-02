// Channel setup fallback tests cover catalog fallback reuse of loaded plugins.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelSetupPlugin } from "../channels/plugins/setup-wizard-types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withEnvAsync } from "../test-utils/env.js";
import { setupChannels } from "./channel-setup.js";
import {
  externalChatSetupEntries,
  makeCatalogEntry,
  makeChannelSetupEntries,
  makeExternalChatSetupPlugin,
  makeMeta,
  makePluginRegistry,
  makeSetupPlugin,
} from "./channel-setup.test-helpers.js";

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

describe("setupChannels status and catalog fallback plugin reuse", () => {
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
    getTrustedChannelPluginCatalogEntry.mockReturnValue(
      makeCatalogEntry("external-chat", "External Chat", {
        pluginId: "@vendor/external-chat-plugin",
        install: { npmSpec: "@vendor/external-chat-plugin" },
      }),
    );
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

  it("localizes the channel status note title in the setup flow", async () => {
    const note = vi.fn(async () => undefined);
    collectChannelStatus.mockResolvedValue({
      installedPlugins: [],
      catalogEntries: [],
      installedCatalogEntries: [],
      statusByChannel: new Map(),
      statusLines: ["Discord: configured"],
    });

    await withEnvAsync({ OPENCLAW_LOCALE: "zh-CN" }, () =>
      runChannelSetup({}, { note, confirm: vi.fn(async () => false) }),
    );

    expect(note).toHaveBeenCalledWith("Discord: configured", "频道状态");
  });

  it(
    "reuses an already-loaded catalog plugin instead of driving the " +
      "catalog-fallback reinstall",
    async () => {
      // Regression for #149672: a catalog-backed channel whose plugin is
      // already loaded (sms installed + enabled + listed by the gateway) is
      // excluded from BOTH discovery buckets — installedCatalogEntries and
      // installableCatalogEntries both filter out ids present in
      // installedPlugins. The catalog fallback must not read the empty pair
      // as "plugin missing": before the fix it drove
      // ensureChannelSetupPluginInstalled unconditionally, rewriting
      // plugins.installs.<id>.installPath and restarting the gateway under
      // the page that asked for the install.
      const configure = vi.fn(async ({ cfg }: { cfg: Record<string, unknown> }) => ({
        cfg: { ...cfg, channels: { "external-chat": { token: "secret" } } },
      }));
      const loadedPlugin = makeExternalChatSetupPlugin({ configure });
      listActiveChannelSetupPlugins.mockReturnValue([loadedPlugin]);
      // Discovery returns the channel in `entries` but keeps both catalog
      // buckets empty, which is exactly how resolveChannelSetupEntries treats
      // a loaded catalog-backed plugin.
      resolveChannelSetupEntries.mockReturnValue(
        externalChatSetupEntries({
          installedCatalogEntries: [],
          installableCatalogEntries: [],
          installedCatalogById: new Map(),
          installableCatalogById: new Map(),
        }),
      );
      getTrustedChannelPluginCatalogEntry.mockReturnValue(
        makeCatalogEntry("external-chat", "External Chat", {
          pluginId: "@vendor/external-chat-plugin",
          install: { npmSpec: "@vendor/external-chat-plugin" },
        }),
      );
      isChannelConfigured.mockReturnValue(false);
      const note = vi.fn(async () => undefined);
      const select = vi
        .fn()
        .mockResolvedValueOnce("external-chat")
        .mockResolvedValueOnce("__done__");

      await runChannelSetup({}, { note, select }, TARGETED_CHANNEL_SETUP_OPTIONS);

      // The loaded plugin is reused: no reinstall, no "plugin not available"
      // dead-end, and the channel's own configure step still runs.
      expect(ensureChannelSetupPluginInstalled).not.toHaveBeenCalled();
      expect(note).not.toHaveBeenCalledWith("external-chat plugin not available.", "Channel setup");
      expect(configure).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    { label: "unrestricted", allow: undefined },
    { label: "owner-only allowlist", allow: ["workspace-chat"] },
  ])("preserves loaded catalog plugin settings with $label", async ({ allow }) => {
    const configure = vi.fn(async ({ cfg }: { cfg: OpenClawConfig }) => ({
      cfg: { ...cfg, channels: { "custom-chat": { token: "fixture-token" } } },
    }));
    const loadedPlugin = makeSetupPlugin({
      id: "custom-chat",
      label: "Custom Chat",
      setupWizard: {
        channel: "custom-chat",
        getStatus: vi.fn(async () => ({
          channel: "custom-chat",
          configured: false,
          statusLines: [],
        })),
        configure,
      } as ChannelSetupPlugin["setupWizard"],
    });
    listActiveChannelSetupPlugins.mockReturnValue([loadedPlugin]);
    resolveChannelSetupEntries.mockReturnValue(
      makeChannelSetupEntries({
        entries: [{ id: "custom-chat", meta: makeMeta("custom-chat", "Custom Chat") }],
      }),
    );
    getTrustedChannelPluginCatalogEntry.mockReturnValue(
      makeCatalogEntry("custom-chat", "Custom Chat", {
        pluginId: "workspace-chat",
        install: { npmSpec: "workspace-chat" },
      }),
    );
    isChannelConfigured.mockReturnValue(false);
    const cfg: OpenClawConfig = {
      plugins: {
        ...(allow ? { allow } : {}),
        entries: { "workspace-chat": { enabled: true, config: { mode: "existing" } } },
      },
    };
    const note = vi.fn(async () => undefined);
    const next = await runChannelSetup(
      cfg,
      { note },
      { ...TARGETED_CHANNEL_SETUP_OPTIONS, initialSelection: ["custom-chat"] },
    );

    expect(ensureChannelSetupPluginInstalled).not.toHaveBeenCalled();
    expect(configure).toHaveBeenCalledTimes(1);
    expect(next).toEqual({
      ...cfg,
      channels: { "custom-chat": { token: "fixture-token" } },
    });
    expect(note).not.toHaveBeenCalled();
  });

  it("keeps the disabled-policy guard when reusing a loaded plugin", async () => {
    // The reuse path preserves the same operator-disabled guard the catalog
    // fallback and bundled-enable paths enforce: an explicitly disabled
    // channel must stop with the "Enable it before setup." note even though
    // its plugin is loaded.
    const configure = vi.fn(async ({ cfg }: { cfg: Record<string, unknown> }) => ({ cfg }));
    const loadedPlugin = makeExternalChatSetupPlugin({ configure });
    listActiveChannelSetupPlugins.mockReturnValue([loadedPlugin]);
    resolveChannelSetupEntries.mockReturnValue(
      externalChatSetupEntries({
        installedCatalogEntries: [],
        installableCatalogEntries: [],
        installedCatalogById: new Map(),
        installableCatalogById: new Map(),
      }),
    );
    isChannelConfigured.mockReturnValue(false);
    const note = vi.fn(async () => undefined);
    const select = vi.fn().mockResolvedValueOnce("external-chat").mockResolvedValueOnce("__done__");

    await runChannelSetup(
      { channels: { "external-chat": { enabled: false } } } as never,
      { note, select },
      // No deferStatusUntilSelection: bypass the top-level deferred guard so
      // the empty-buckets branch guard is what fires.
      { skipConfirm: true, skipDmPolicyPrompt: true },
    );

    expect(ensureChannelSetupPluginInstalled).not.toHaveBeenCalled();
    expect(configure).not.toHaveBeenCalled();
    expect(note).toHaveBeenCalledWith(
      "external-chat cannot be configured while disabled. Enable it before setup.",
      "Channel setup",
    );
  });
});
