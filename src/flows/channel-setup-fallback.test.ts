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
      statusByChannel: new Map(),
      statusLines: [],
    });
    isChannelConfigured.mockReturnValue(true);
  });

  it("localizes the channel status note title in the setup flow", async () => {
    const note = vi.fn(async () => undefined);
    collectChannelStatus.mockResolvedValue({
      statusByChannel: new Map(),
      statusLines: ["Discord: configured"],
    });

    await withEnvAsync({ OPENCLAW_LOCALE: "zh-CN" }, () =>
      runChannelSetup({}, { note, confirm: vi.fn(async () => false) }),
    );

    expect(note).toHaveBeenCalledWith("Discord: configured", "频道状态");
  });

  it.each(["loaded", "unrestricted", "owner-only", "disabled"] as const)(
    "reuses a loaded catalog plugin under %s policy without reinstalling it",
    async (policy) => {
      const custom = policy === "unrestricted" || policy === "owner-only";
      const channel = custom ? "custom-chat" : "external-chat";
      const label = custom ? "Custom Chat" : "External Chat";
      const configure = vi.fn(async ({ cfg }: { cfg: OpenClawConfig }) => ({
        cfg: { ...cfg, channels: { [channel]: { token: "fixture-token" } } },
      }));
      const loadedPlugin = custom
        ? makeSetupPlugin({
            id: channel,
            label,
            setupWizard: {
              channel,
              getStatus: vi.fn(async () => ({ channel, configured: false, statusLines: [] })),
              configure,
            } as ChannelSetupPlugin["setupWizard"],
          })
        : makeExternalChatSetupPlugin({ configure });
      listActiveChannelSetupPlugins.mockReturnValue([loadedPlugin]);
      // Loaded plugins are absent from both catalog discovery buckets (#149672).
      resolveChannelSetupEntries.mockReturnValue(
        custom
          ? makeChannelSetupEntries({ entries: [{ id: channel, meta: makeMeta(channel, label) }] })
          : externalChatSetupEntries(),
      );
      if (custom) {
        getTrustedChannelPluginCatalogEntry.mockReturnValue(
          makeCatalogEntry(channel, label, {
            pluginId: "workspace-chat",
            install: { npmSpec: "workspace-chat" },
          }),
        );
      }
      isChannelConfigured.mockReturnValue(false);
      const cfg: OpenClawConfig = custom
        ? {
            plugins: {
              ...(policy === "owner-only" ? { allow: ["workspace-chat"] } : {}),
              entries: { "workspace-chat": { enabled: true, config: { mode: "existing" } } },
            },
          }
        : policy === "disabled"
          ? { channels: { [channel]: { enabled: false } } }
          : {};
      const note = vi.fn(async () => undefined);
      const select = vi.fn().mockResolvedValueOnce(channel).mockResolvedValueOnce("__done__");
      const next = await runChannelSetup(
        cfg,
        { note, select },
        // Eager setup reaches the fallback guard without the earlier deferred guard.
        policy === "disabled"
          ? { skipConfirm: true, skipDmPolicyPrompt: true }
          : { ...TARGETED_CHANNEL_SETUP_OPTIONS, initialSelection: [channel] },
      );

      expect(ensureChannelSetupPluginInstalled).not.toHaveBeenCalled();
      if (policy === "disabled") {
        expect(configure).not.toHaveBeenCalled();
        expect(note).toHaveBeenCalledWith(
          "external-chat cannot be configured while disabled. Enable it before setup.",
          "Channel setup",
        );
        expect(next).toEqual(cfg);
      } else {
        expect(configure).toHaveBeenCalledTimes(1);
        expect(note).not.toHaveBeenCalledWith(
          "external-chat plugin not available.",
          "Channel setup",
        );
        expect(next).toEqual({ ...cfg, channels: { [channel]: { token: "fixture-token" } } });
        if (custom) {
          expect(note).not.toHaveBeenCalled();
        }
      }
    },
  );
});
