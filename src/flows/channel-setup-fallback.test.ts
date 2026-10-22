import { beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withEnvAsync } from "../test-utils/env.js";
import { setupChannels } from "./channel-setup.js";
import {
  makeCatalogEntry,
  makeChannelSetupEntries,
  makeMeta,
  makeSetupPlugin,
} from "./channel-setup.test-helpers.js";

const {
  getTrustedChannelPluginCatalogEntry: catalogEntry,
  listActiveChannelSetupPlugins: activePlugins,
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

beforeEach(() => {
  reset();
  catalogEntry.mockReturnValue(
    makeCatalogEntry("external-chat", "External Chat", {
      pluginId: "@vendor/external-chat-plugin",
      install: { npmSpec: "@vendor/external-chat-plugin" },
    }),
  );
});

it("localizes the channel status note title in the setup flow", async () => {
  const note = vi.fn(async () => undefined);
  collectStatus.mockResolvedValue({
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
    activePlugins.mockReturnValue([
      makeSetupPlugin({
        id: channel,
        label,
        setupWizard: {
          channel,
          getStatus: vi.fn(async () => ({ channel, configured: false, statusLines: [] })),
          configure,
        },
      }),
    ]);
    // Loaded plugins are absent from both catalog discovery buckets (#149672).
    discoverChannels.mockReturnValue(
      makeChannelSetupEntries({ entries: [{ id: channel, meta: makeMeta(channel, label) }] }),
    );
    if (custom) {
      catalogEntry.mockReturnValue(
        makeCatalogEntry(channel, label, {
          pluginId: "workspace-chat",
          install: { npmSpec: "workspace-chat" },
        }),
      );
    }
    channelConfigured.mockReturnValue(false);
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
        : {
            initialSelection: [channel],
            finishAfterInitialSelection: true,
            deferStatusUntilSelection: true,
            skipDmPolicyPrompt: true,
          },
    );

    expect(installPlugin).not.toHaveBeenCalled();
    if (policy === "disabled") {
      expect(configure).not.toHaveBeenCalled();
      expect(note).toHaveBeenCalledWith(
        "external-chat cannot be configured while disabled. Enable it before setup.",
        "Channel setup",
      );
      expect(next).toEqual(cfg);
    } else {
      expect(configure).toHaveBeenCalledTimes(1);
      expect(note).not.toHaveBeenCalledWith("external-chat plugin not available.", "Channel setup");
      expect(next).toEqual({ ...cfg, channels: { [channel]: { token: "fixture-token" } } });
      if (custom) {
        expect(note).not.toHaveBeenCalled();
      }
    }
  },
);
