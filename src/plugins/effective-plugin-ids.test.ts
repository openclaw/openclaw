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
  resolveConfiguredChannelPluginIds:
    vi.fn<typeof import("./channel-plugin-ids.js").resolveConfiguredChannelPluginIds>(),
  loadManifestMetadataSnapshot:
    vi.fn<typeof import("./manifest-contract-eligibility.js").loadManifestMetadataSnapshot>(),
  passesManifestOwnerBasePolicy:
    vi.fn<typeof import("./manifest-owner-policy.js").passesManifestOwnerBasePolicy>(),
}));

// mock-isolation: explicit auto-enable results isolate effective-id selection from discovery.
vi.mock("../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: mocks.applyPluginAutoEnable,
}));

vi.mock("../channels/config-presence.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../channels/config-presence.js")>()),
  listExplicitlyDisabledChannelIdsForConfig: mocks.listExplicitlyDisabledChannelIdsForConfig,
  listPotentialConfiguredChannelIds: mocks.listPotentialConfiguredChannelIds,
}));

vi.mock("./channel-presence-policy.js", () => ({
  listExplicitConfiguredChannelIdsForConfig: () => [],
}));

// mock-isolation: fixture channel inventories avoid loading installed plugin metadata.
vi.mock("./channel-plugin-ids.js", () => ({
  listExplicitConfiguredChannelIdsForConfig: mocks.listExplicitConfiguredChannelIdsForConfig,
  loadGatewayStartupPluginPlan: mocks.loadGatewayStartupPluginPlan,
  resolveConfiguredChannelPluginIds: mocks.resolveConfiguredChannelPluginIds,
}));

// mock-isolation: each case owns its manifest snapshot instead of reading installed plugins.
vi.mock("./manifest-contract-eligibility.js", () => ({
  loadManifestMetadataSnapshot: mocks.loadManifestMetadataSnapshot,
}));

// mock-isolation: cases control owner admission, opting into the real policy where needed.
vi.mock("./manifest-owner-policy.js", () => ({
  passesManifestOwnerBasePolicy: mocks.passesManifestOwnerBasePolicy,
}));

import { resolveEffectivePluginIds } from "./effective-plugin-ids.js";
import { collectConfiguredStartupChannelIds } from "./gateway-startup-plugin-config.js";

function resolve(config: OpenClawConfig): string[] {
  return resolveEffectivePluginIds({ config, env: {}, workspaceDir: "/workspace" });
}

describe("resolveEffectivePluginIds", () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
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
    mocks.resolveConfiguredChannelPluginIds.mockReturnValue([]);
    mocks.loadManifestMetadataSnapshot.mockReturnValue(createPluginMetadataSnapshotFixture());
    mocks.passesManifestOwnerBasePolicy.mockReturnValue(true);
  });

  it("does not activate channels from persisted auth", () => {
    mocks.listPotentialConfiguredChannelIds.mockImplementation((_config, _env, options) =>
      options?.includePersistedAuthState === false ? [] : ["credential-only"],
    );
    expect(collectConfiguredStartupChannelIds({ configs: [{}, {}], env: {} })).toEqual([]);
  });

  it("includes a selected context-engine slot even when omitted from explicit allow and entries", () => {
    expect(resolve({ plugins: { slots: { contextEngine: "lossless-claw" } } })).toEqual([
      "lossless-claw",
    ]);
  });

  it("keeps the selected slot but rechecks bundled owner policy after channel callbacks", async () => {
    const { passesManifestOwnerBasePolicy } = await vi.importActual<
      typeof import("./manifest-owner-policy.js")
    >("./manifest-owner-policy.js");
    mocks.passesManifestOwnerBasePolicy.mockImplementation(passesManifestOwnerBasePolicy);
    mocks.listPotentialConfiguredChannelIds.mockReturnValue(["test-channel"]);
    mocks.loadManifestMetadataSnapshot.mockReturnValue(
      createPluginMetadataSnapshotFixture({
        plugins: [{ id: "bundled-channel-owner", channels: ["test-channel"] }],
      }),
    );
    mocks.resolveConfiguredChannelPluginIds.mockImplementation(({ config }) => {
      config.plugins = {
        deny: ["bundled-channel-owner"],
        slots: { contextEngine: "later-context" },
      };
      return [];
    });

    expect(resolve({ plugins: { slots: { contextEngine: "early-context" } } })).toEqual([
      "early-context",
    ]);
  });

  it("keeps the built-in legacy context engine out of plugin preload ids", () => {
    expect(resolve({ plugins: { slots: { contextEngine: "legacy" } } })).toStrictEqual([]);
  });

  it.each([
    {
      name: "plugins disabled",
      policy: { enabled: false },
    },
    {
      name: "denylisted",
      policy: { deny: ["lossless-claw"] },
    },
    {
      name: "entry disabled",
      policy: { entries: { "lossless-claw": { enabled: false } } },
    },
  ] satisfies Array<{ name: string; policy: NonNullable<OpenClawConfig["plugins"]> }>)(
    "does not preload a selected context-engine slot when $name",
    ({ policy }) => {
      expect(
        resolve({ plugins: { ...policy, slots: { contextEngine: "lossless-claw" } } }),
      ).toStrictEqual([]);
    },
  );
});
