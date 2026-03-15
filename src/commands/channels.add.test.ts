import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPluginCatalogEntry } from "../channels/plugins/catalog.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { setDefaultChannelPluginRegistryForTests } from "./channel-test-helpers.js";
import { configMocks, offsetMocks } from "./channels.mock-harness.js";
import {
  ensureOnboardingPluginInstalled,
  loadOnboardingPluginRegistrySnapshotForChannel,
} from "./onboarding/plugin-install.js";
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

vi.mock("./onboarding/plugin-install.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./onboarding/plugin-install.js")>();
  return {
    ...actual,
    ensureOnboardingPluginInstalled: vi.fn(async ({ cfg }) => ({ cfg, installed: true })),
    loadOnboardingPluginRegistrySnapshotForChannel: vi.fn(() => createTestRegistry()),
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
    vi.mocked(ensureOnboardingPluginInstalled).mockClear();
    vi.mocked(ensureOnboardingPluginInstalled).mockImplementation(async ({ cfg }) => ({
      cfg,
      installed: true,
    }));
    vi.mocked(loadOnboardingPluginRegistrySnapshotForChannel).mockClear();
    vi.mocked(loadOnboardingPluginRegistrySnapshotForChannel).mockReturnValue(createTestRegistry());
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
    vi.mocked(loadOnboardingPluginRegistrySnapshotForChannel).mockReturnValue(
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

    expect(ensureOnboardingPluginInstalled).toHaveBeenCalledWith(
      expect.objectContaining({ entry: catalogEntry }),
    );
    expect(loadOnboardingPluginRegistrySnapshotForChannel).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "msteams" }),
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
});
