/** Verifies effective plugin id resolution across config, manifests, and activation sources. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";

const mocks = vi.hoisted(() => ({
  applyPluginAutoEnable:
    vi.fn<typeof import("../config/plugin-auto-enable.js").applyPluginAutoEnable>(),
  listExplicitlyDisabledChannelIdsForConfig: vi.fn(),
  listPotentialConfiguredChannelIds: vi.fn(),
  listExplicitConfiguredChannelIdsForConfig: vi.fn(),
  loadGatewayStartupPluginPlan:
    vi.fn<typeof import("./channel-plugin-ids.js").loadGatewayStartupPluginPlan>(),
  resolveConfiguredChannelPluginIdsAsync:
    vi.fn<typeof import("./channel-plugin-ids.js").resolveConfiguredChannelPluginIdsAsync>(),
  resolvePluginMetadataSnapshotAsync:
    vi.fn<typeof import("./plugin-metadata-snapshot.js").resolvePluginMetadataSnapshotAsync>(),
  passesManifestOwnerBasePolicy:
    vi.fn<typeof import("./manifest-owner-policy.js").passesManifestOwnerBasePolicy>(),
}));

vi.mock("../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: (...args: Parameters<typeof mocks.applyPluginAutoEnable>) =>
    mocks.applyPluginAutoEnable(...args),
}));

vi.mock("../channels/config-presence.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../channels/config-presence.js")>()),
  listExplicitlyDisabledChannelIdsForConfig: (
    ...args: Parameters<typeof mocks.listExplicitlyDisabledChannelIdsForConfig>
  ) => mocks.listExplicitlyDisabledChannelIdsForConfig(...args),
  listPotentialConfiguredChannelIds: (
    ...args: Parameters<typeof mocks.listPotentialConfiguredChannelIds>
  ) => mocks.listPotentialConfiguredChannelIds(...args),
}));

vi.mock("./channel-presence-policy.js", () => ({
  listExplicitConfiguredChannelIdsForConfig: () => [],
}));

// mock-isolation: Fixture channel ids and startup plans replace persisted channel discovery.
vi.mock("./channel-plugin-ids.js", () => ({
  listExplicitConfiguredChannelIdsForConfig: (
    ...args: Parameters<typeof mocks.listExplicitConfiguredChannelIdsForConfig>
  ) => mocks.listExplicitConfiguredChannelIdsForConfig(...args),
  loadGatewayStartupPluginPlan: (...args: Parameters<typeof mocks.loadGatewayStartupPluginPlan>) =>
    mocks.loadGatewayStartupPluginPlan(...args),
  resolveConfiguredChannelPluginIdsAsync: (
    ...args: Parameters<typeof mocks.resolveConfiguredChannelPluginIdsAsync>
  ) => mocks.resolveConfiguredChannelPluginIdsAsync(...args),
}));

vi.mock("./plugin-metadata-snapshot.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./plugin-metadata-snapshot.js")>();
  return {
    ...actual,
    resolvePluginMetadataSnapshotAsync: (
      ...args: Parameters<typeof mocks.resolvePluginMetadataSnapshotAsync>
    ) => mocks.resolvePluginMetadataSnapshotAsync(...args),
  };
});

vi.mock("./manifest-owner-policy.js", () => ({
  passesManifestOwnerBasePolicy: (
    ...args: Parameters<typeof mocks.passesManifestOwnerBasePolicy>
  ) => mocks.passesManifestOwnerBasePolicy(...args),
}));

import { resolveEffectivePluginIdsAsync } from "./effective-plugin-ids.js";
import { collectConfiguredStartupChannelIds } from "./gateway-startup-plugin-config.js";

function resolve(config: OpenClawConfig): Promise<string[]> {
  return resolveEffectivePluginIdsAsync({
    config,
    env: {},
    workspaceDir: "/workspace",
  });
}

describe("resolveEffectivePluginIdsAsync", () => {
  beforeEach(() => {
    mocks.applyPluginAutoEnable.mockReset();
    mocks.listExplicitlyDisabledChannelIdsForConfig.mockReset();
    mocks.listPotentialConfiguredChannelIds.mockReset();
    mocks.listExplicitConfiguredChannelIdsForConfig.mockReset();
    mocks.loadGatewayStartupPluginPlan.mockReset();
    mocks.resolveConfiguredChannelPluginIdsAsync.mockReset();
    mocks.resolvePluginMetadataSnapshotAsync.mockReset();
    mocks.passesManifestOwnerBasePolicy.mockReset();

    mocks.applyPluginAutoEnable.mockImplementation((params) => ({
      config: params.config ?? {},
      changes: [],
      autoEnabledReasons: {},
    }));
    mocks.listExplicitlyDisabledChannelIdsForConfig.mockReturnValue([]);
    mocks.listPotentialConfiguredChannelIds.mockReturnValue([]);
    mocks.listExplicitConfiguredChannelIdsForConfig.mockReturnValue([]);
    mocks.loadGatewayStartupPluginPlan.mockReturnValue({
      channelPluginIds: [],
      pluginIds: [],
    });
    mocks.resolveConfiguredChannelPluginIdsAsync.mockResolvedValue([]);
    mocks.resolvePluginMetadataSnapshotAsync.mockResolvedValue(
      createPluginMetadataSnapshotFixture(),
    );
    mocks.passesManifestOwnerBasePolicy.mockReturnValue(true);
  });

  it("does not activate channels from persisted auth", () => {
    mocks.listPotentialConfiguredChannelIds.mockImplementation((_config, _env, options) =>
      options?.includePersistedAuthState === false ? [] : ["credential-only"],
    );
    expect(
      collectConfiguredStartupChannelIds({
        configs: [{}, {}],
        env: {},
      }),
    ).toEqual([]);
  });

  it("includes a selected context-engine slot even when omitted from explicit allow and entries", async () => {
    expect(
      await resolve({
        plugins: {
          slots: { contextEngine: "lossless-claw" },
        },
      }),
    ).toEqual(["lossless-claw"]);
  });

  it("keeps the built-in legacy context engine out of plugin preload ids", async () => {
    expect(
      await resolve({
        plugins: {
          slots: { contextEngine: "legacy" },
        },
      }),
    ).toStrictEqual([]);
  });

  it.each([
    {
      name: "plugins disabled",
      plugins: {
        enabled: false,
        slots: { contextEngine: "lossless-claw" },
      },
    },
    {
      name: "denylisted",
      plugins: {
        deny: ["lossless-claw"],
        slots: { contextEngine: "lossless-claw" },
      },
    },
    {
      name: "entry disabled",
      plugins: {
        entries: {
          "lossless-claw": { enabled: false },
        },
        slots: { contextEngine: "lossless-claw" },
      },
    },
  ] satisfies Array<{ name: string; plugins: NonNullable<OpenClawConfig["plugins"]> }>)(
    "does not preload a selected context-engine slot when $name",
    async ({ plugins }) => {
      expect(await resolve({ plugins })).toStrictEqual([]);
    },
  );
});
