import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";

const mocks = vi.hoisted(() => ({
  listPotentialConfiguredChannelIds: vi.fn(),
  resolveConfiguredChannelPluginIds:
    vi.fn<typeof import("./channel-plugin-ids.js").resolveConfiguredChannelPluginIds>(),
  loadManifestMetadataSnapshot:
    vi.fn<typeof import("./manifest-contract-eligibility.js").loadManifestMetadataSnapshot>(),
}));

// mock-isolation: explicit auto-enable results isolate effective-id selection from discovery.
vi.mock("../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: ({ config }: { config?: OpenClawConfig }) => ({
    config: config ?? {},
    changes: [],
    autoEnabledReasons: {},
  }),
}));

vi.mock("../channels/config-presence.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../channels/config-presence.js")>()),
  listExplicitlyDisabledChannelIdsForConfig: () => [],
  listPotentialConfiguredChannelIds: mocks.listPotentialConfiguredChannelIds,
}));

vi.mock("./channel-presence-policy.js", () => ({
  listExplicitConfiguredChannelIdsForConfig: () => [],
}));

// mock-isolation: fixture channel inventories avoid loading installed plugin metadata.
vi.mock("./channel-plugin-ids.js", () => ({
  listExplicitConfiguredChannelIdsForConfig: () => [],
  loadGatewayStartupPluginPlan: () => ({ channelPluginIds: [], pluginIds: [] }),
  resolveConfiguredChannelPluginIds: mocks.resolveConfiguredChannelPluginIds,
}));

// mock-isolation: each case owns its manifest snapshot instead of reading installed plugins.
vi.mock("./manifest-contract-eligibility.js", () => ({
  loadManifestMetadataSnapshot: mocks.loadManifestMetadataSnapshot,
}));

import { resolveEffectivePluginIds } from "./effective-plugin-ids.js";
import { collectConfiguredStartupChannelIds } from "./gateway-startup-plugin-config.js";

function resolve(config: OpenClawConfig): string[] {
  return resolveEffectivePluginIds({ config, env: {}, workspaceDir: "/workspace" });
}

describe("resolveEffectivePluginIds", () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.listPotentialConfiguredChannelIds.mockReturnValue([]);
    mocks.resolveConfiguredChannelPluginIds.mockReturnValue([]);
    mocks.loadManifestMetadataSnapshot.mockReturnValue(createPluginMetadataSnapshotFixture());
  });

  it("does not activate channels from persisted auth", () => {
    mocks.listPotentialConfiguredChannelIds.mockImplementation((_config, _env, options) =>
      options?.includePersistedAuthState === false ? [] : ["credential-only"],
    );
    expect(collectConfiguredStartupChannelIds({ configs: [{}, {}], env: {} })).toEqual([]);
  });

  it("keeps the selected slot but rechecks bundled owner policy after channel callbacks", () => {
    mocks.listPotentialConfiguredChannelIds.mockReturnValue(["test-channel"]);
    mocks.loadManifestMetadataSnapshot.mockReturnValue(
      createPluginMetadataSnapshotFixture({
        plugins: [
          { id: "early-context" },
          { id: "bundled-channel-owner", channels: ["test-channel"] },
        ],
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

  it("preloads the declared owner, not the engine identifier", () => {
    mocks.loadManifestMetadataSnapshot.mockReturnValue(
      createPluginMetadataSnapshotFixture({
        plugins: [{ id: "vendor-plugin", contextEngineIds: ["Canonical-Engine"] }],
      }),
    );
    expect(resolve({ plugins: { slots: { contextEngine: "Canonical-Engine" } } })).toEqual([]);
    expect(
      resolve({
        plugins: { allow: ["vendor-plugin"], slots: { contextEngine: "Canonical-Engine" } },
      }),
    ).toEqual(["vendor-plugin"]);
  });

  it.each([
    ["selected without explicit allow or entry", {}, ["lossless-claw"]],
    ["built-in legacy", { slots: { contextEngine: "legacy" } }, []],
    ["plugins disabled", { enabled: false }, []],
    ["denylisted", { deny: ["lossless-claw"] }, []],
    ["entry disabled", { entries: { "lossless-claw": { enabled: false } } }, []],
  ] satisfies Array<[string, NonNullable<OpenClawConfig["plugins"]>, string[]]>)(
    "preloads the expected context-engine slot: %s",
    (_name, policy, expected) => {
      mocks.loadManifestMetadataSnapshot.mockReturnValue(
        createPluginMetadataSnapshotFixture({ plugins: [{ id: "lossless-claw" }] }),
      );
      expect(
        resolve({ plugins: { slots: { contextEngine: "lossless-claw" }, ...policy } }),
      ).toStrictEqual(expected);
    },
  );
});
