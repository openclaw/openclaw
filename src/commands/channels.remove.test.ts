import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPluginCatalogEntry } from "../channels/plugins/catalog.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  ensureChannelSetupPluginInstalled,
  loadChannelSetupPluginRegistrySnapshotForChannel,
} from "./channel-setup/plugin-install.js";
import { configMocks } from "./channels.mock-harness.js";
import { baseConfigSnapshot, createTestRuntime } from "./test-runtime-config-helpers.js";

const catalogMocks = vi.hoisted(() => ({
  listChannelPluginCatalogEntries: vi.fn((): ChannelPluginCatalogEntry[] => []),
}));

vi.mock("../channels/plugins/catalog.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../channels/plugins/catalog.js")>();
  return {
    ...actual,
    listChannelPluginCatalogEntries: catalogMocks.listChannelPluginCatalogEntries,
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
let channelsRemoveCommand: typeof import("./channels.js").channelsRemoveCommand;

describe("channelsRemoveCommand", () => {
  beforeAll(async () => {
    ({ channelsRemoveCommand } = await import("./channels.js"));
  });

  beforeEach(() => {
    configMocks.readConfigFileSnapshot.mockClear();
    configMocks.writeConfigFile.mockClear();
    runtime.log.mockClear();
    runtime.error.mockClear();
    runtime.exit.mockClear();
    catalogMocks.listChannelPluginCatalogEntries.mockClear();
    catalogMocks.listChannelPluginCatalogEntries.mockReturnValue([]);
    vi.mocked(ensureChannelSetupPluginInstalled).mockClear();
    vi.mocked(ensureChannelSetupPluginInstalled).mockImplementation(async ({ cfg }) => ({
      cfg,
      installed: true,
    }));
    vi.mocked(loadChannelSetupPluginRegistrySnapshotForChannel).mockClear();
    vi.mocked(loadChannelSetupPluginRegistrySnapshotForChannel).mockReturnValue(
      createTestRegistry(),
    );
    setActivePluginRegistry(createTestRegistry());
  });

  it("removes an external channel account after installing its plugin on demand", async () => {
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      ...baseConfigSnapshot,
      config: {
        channels: {
          msteams: {
            enabled: true,
            tenantId: "tenant-1",
          },
        },
      },
    });
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
    const scopedPlugin = {
      ...createChannelTestPluginBase({
        id: "msteams",
        label: "Microsoft Teams",
        docsPath: "/channels/msteams",
      }),
      config: {
        ...createChannelTestPluginBase({
          id: "msteams",
          label: "Microsoft Teams",
          docsPath: "/channels/msteams",
        }).config,
        deleteAccount: vi.fn(({ cfg }: { cfg: Record<string, unknown> }) => {
          const channels = (cfg.channels as Record<string, unknown> | undefined) ?? {};
          const nextChannels = { ...channels };
          delete nextChannels.msteams;
          return {
            ...cfg,
            channels: nextChannels,
          };
        }),
      },
    };
    vi.mocked(loadChannelSetupPluginRegistrySnapshotForChannel)
      .mockReturnValueOnce(createTestRegistry())
      .mockReturnValueOnce(
        createTestRegistry([
          {
            pluginId: "@openclaw/msteams-plugin",
            plugin: scopedPlugin,
            source: "test",
          },
        ]),
      );

    await channelsRemoveCommand(
      {
        channel: "msteams",
        account: "default",
        delete: true,
      },
      runtime,
      { hasFlags: true },
    );

    expect(ensureChannelSetupPluginInstalled).toHaveBeenCalledWith(
      expect.objectContaining({
        entry: catalogEntry,
      }),
    );
    expect(loadChannelSetupPluginRegistrySnapshotForChannel).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "msteams",
        pluginId: "@openclaw/msteams-plugin",
      }),
    );
    expect(configMocks.writeConfigFile).toHaveBeenCalledWith(
      expect.not.objectContaining({
        channels: expect.objectContaining({
          msteams: expect.anything(),
        }),
      }),
    );
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
  });
});
