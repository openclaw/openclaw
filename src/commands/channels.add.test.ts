import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPluginCatalogEntry } from "../channels/plugins/catalog.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  ensureChannelSetupPluginInstalled,
  loadChannelSetupPluginRegistrySnapshotForChannel,
} from "./channel-setup/plugin-install.js";
import { setDefaultChannelPluginRegistryForTests } from "./channel-test-helpers.js";
import { configMocks, offsetMocks } from "./channels.mock-harness.js";
import { baseConfigSnapshot, createTestRuntime } from "./test-runtime-config-helpers.js";

const catalogMocks = vi.hoisted(() => ({
  listChannelPluginCatalogEntries: vi.fn((): ChannelPluginCatalogEntry[] => []),
}));

const manifestRegistryMocks = vi.hoisted(() => ({
  loadPluginManifestRegistry: vi.fn(() => ({ plugins: [], diagnostics: [] })),
}));

vi.mock("../channels/plugins/catalog.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../channels/plugins/catalog.js")>();
  return {
    ...actual,
    listChannelPluginCatalogEntries: catalogMocks.listChannelPluginCatalogEntries,
  };
});

vi.mock("../plugins/manifest-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/manifest-registry.js")>();
  return {
    ...actual,
    loadPluginManifestRegistry: manifestRegistryMocks.loadPluginManifestRegistry,
  };
});

vi.mock("./channel-setup/plugin-install.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./channel-setup/plugin-install.js")>();
  return {
    ...actual,
    ensureChannelSetupPluginInstalled: vi.fn(async ({ cfg }) => ({ cfg, installed: true })),
    loadChannelSetupPluginRegistrySnapshotForChannel: vi.fn(() => createTestRegistry()),
  };
});

const runtime = createTestRuntime();
let channelsAddCommand: typeof import("./channels.js").channelsAddCommand;

describe("channelsAddCommand", () => {
  beforeAll(async () => {
    ({ channelsAddCommand } = await import("./channels.js"));
  });

  beforeEach(async () => {
    configMocks.readConfigFileSnapshot.mockClear();
    configMocks.writeConfigFile.mockClear();
    offsetMocks.deleteTelegramUpdateOffset.mockClear();
    runtime.log.mockClear();
    runtime.error.mockClear();
    runtime.exit.mockClear();
    catalogMocks.listChannelPluginCatalogEntries.mockClear();
    catalogMocks.listChannelPluginCatalogEntries.mockReturnValue([]);
    manifestRegistryMocks.loadPluginManifestRegistry.mockClear();
    manifestRegistryMocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [],
      diagnostics: [],
    });
    vi.mocked(ensureChannelSetupPluginInstalled).mockClear();
    vi.mocked(ensureChannelSetupPluginInstalled).mockImplementation(async ({ cfg }) => ({
      cfg,
      installed: true,
    }));
    vi.mocked(loadChannelSetupPluginRegistrySnapshotForChannel).mockClear();
    vi.mocked(loadChannelSetupPluginRegistrySnapshotForChannel).mockReturnValue(
      createTestRegistry(),
    );
    setDefaultChannelPluginRegistryForTests();
  });

  it("clears telegram update offsets when the token changes", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {
        channels: {
          telegram: { botToken: "old-token", enabled: true },
        },
      },
    });

    await channelsAddCommand(
      { channel: "telegram", account: "default", token: "new-token" },
      runtime,
      { hasFlags: true },
    );

    expect(offsetMocks.deleteTelegramUpdateOffset).toHaveBeenCalledTimes(1);
    expect(offsetMocks.deleteTelegramUpdateOffset).toHaveBeenCalledWith({ accountId: "default" });
  });

  it("does not clear telegram update offsets when the token is unchanged", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {
        channels: {
          telegram: { botToken: "same-token", enabled: true },
        },
      },
    });

    await channelsAddCommand(
      { channel: "telegram", account: "default", token: "same-token" },
      runtime,
      { hasFlags: true },
    );

    expect(offsetMocks.deleteTelegramUpdateOffset).not.toHaveBeenCalled();
  });

  it("falls back to a scoped snapshot after installing an external channel plugin", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({ ...baseConfigSnapshot });
    setActivePluginRegistry(createTestRegistry());
    const catalogEntry: ChannelPluginCatalogEntry = {
      id: "msteams",
      pluginId: "@openclaw/msteams-plugin",
      meta: {
        id: "msteams",
        label: "Microsoft Teams",
        selectionLabel: "Microsoft Teams",
        docsPath: "/channels/msteams",
        blurb: "teams channel",
      },
      install: {
        npmSpec: "@openclaw/msteams",
      },
    };
    catalogMocks.listChannelPluginCatalogEntries.mockReturnValue([catalogEntry]);
    const scopedMSTeamsPlugin = {
      ...createChannelTestPluginBase({
        id: "msteams",
        label: "Microsoft Teams",
        docsPath: "/channels/msteams",
      }),
      setup: {
        applyAccountConfig: vi.fn(({ cfg, input }) => ({
          ...cfg,
          channels: {
            ...cfg.channels,
            msteams: {
              enabled: true,
              tenantId: input.token,
            },
          },
        })),
      },
    };
    vi.mocked(loadChannelSetupPluginRegistrySnapshotForChannel)
      .mockReturnValueOnce(createTestRegistry())
      .mockReturnValueOnce(
        createTestRegistry([{ pluginId: "msteams", plugin: scopedMSTeamsPlugin, source: "test" }]),
      );

    await channelsAddCommand(
      {
        channel: "msteams",
        account: "default",
        token: "tenant-scoped",
      },
      runtime,
      { hasFlags: true },
    );

    expect(ensureChannelSetupPluginInstalled).toHaveBeenCalledWith(
      expect.objectContaining({ entry: catalogEntry }),
    );
    expect(loadChannelSetupPluginRegistrySnapshotForChannel).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "msteams",
        pluginId: "@openclaw/msteams-plugin",
      }),
    );
    expect(configMocks.writeConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        channels: {
          msteams: {
            enabled: true,
            tenantId: "tenant-scoped",
          },
        },
      }),
    );
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("uses the installed external channel snapshot without reinstalling", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({ ...baseConfigSnapshot });
    setActivePluginRegistry(createTestRegistry());
    const catalogEntry: ChannelPluginCatalogEntry = {
      id: "msteams",
      pluginId: "@openclaw/msteams-plugin",
      meta: {
        id: "msteams",
        label: "Microsoft Teams",
        selectionLabel: "Microsoft Teams",
        docsPath: "/channels/msteams",
        blurb: "teams channel",
      },
      install: {
        npmSpec: "@openclaw/msteams",
      },
    };
    catalogMocks.listChannelPluginCatalogEntries.mockReturnValue([catalogEntry]);
    manifestRegistryMocks.loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "@openclaw/msteams-plugin",
          channels: ["msteams"],
        } as never,
      ],
      diagnostics: [],
    });
    const scopedMSTeamsPlugin = {
      ...createChannelTestPluginBase({
        id: "msteams",
        label: "Microsoft Teams",
        docsPath: "/channels/msteams",
      }),
      setup: {
        applyAccountConfig: vi.fn(({ cfg, input }) => ({
          ...cfg,
          channels: {
            ...cfg.channels,
            msteams: {
              enabled: true,
              tenantId: input.token,
            },
          },
        })),
      },
    };
    vi.mocked(loadChannelSetupPluginRegistrySnapshotForChannel).mockReturnValue(
      createTestRegistry([{ pluginId: "msteams", plugin: scopedMSTeamsPlugin, source: "test" }]),
    );

    await channelsAddCommand(
      {
        channel: "msteams",
        account: "default",
        token: "tenant-installed",
      },
      runtime,
      { hasFlags: true },
    );

    expect(ensureChannelSetupPluginInstalled).not.toHaveBeenCalled();
    expect(loadChannelSetupPluginRegistrySnapshotForChannel).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "msteams",
        pluginId: "@openclaw/msteams-plugin",
      }),
    );
    expect(configMocks.writeConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        channels: {
          msteams: {
            enabled: true,
            tenantId: "tenant-installed",
          },
        },
      }),
    );
  });

  it("uses the installed plugin id when channel and plugin ids differ", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({ ...baseConfigSnapshot });
    setActivePluginRegistry(createTestRegistry());
    const catalogEntry: ChannelPluginCatalogEntry = {
      id: "msteams",
      pluginId: "@openclaw/msteams-plugin",
      meta: {
        id: "msteams",
        label: "Microsoft Teams",
        selectionLabel: "Microsoft Teams",
        docsPath: "/channels/msteams",
        blurb: "teams channel",
      },
      install: {
        npmSpec: "@openclaw/msteams",
      },
    };
    catalogMocks.listChannelPluginCatalogEntries.mockReturnValue([catalogEntry]);
    vi.mocked(ensureChannelSetupPluginInstalled).mockImplementation(async ({ cfg }) => ({
      cfg,
      installed: true,
      pluginId: "@vendor/teams-runtime",
    }));
    vi.mocked(loadChannelSetupPluginRegistrySnapshotForChannel)
      .mockReturnValueOnce(createTestRegistry())
      .mockReturnValueOnce(
        createTestRegistry([
          {
            pluginId: "@vendor/teams-runtime",
            plugin: {
              ...createChannelTestPluginBase({
                id: "msteams",
                label: "Microsoft Teams",
                docsPath: "/channels/msteams",
              }),
              setup: {
                applyAccountConfig: vi.fn(({ cfg, input }) => ({
                  ...cfg,
                  channels: {
                    ...cfg.channels,
                    msteams: {
                      enabled: true,
                      tenantId: input.token,
                    },
                  },
                })),
              },
            },
            source: "test",
          },
        ]),
      );

    await channelsAddCommand(
      {
        channel: "msteams",
        account: "default",
        token: "tenant-scoped",
      },
      runtime,
      { hasFlags: true },
    );

    expect(loadChannelSetupPluginRegistrySnapshotForChannel).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "msteams",
        pluginId: "@vendor/teams-runtime",
      }),
    );
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
  });
});
