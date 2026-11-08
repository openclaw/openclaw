import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";

const mocks = vi.hoisted(() => ({
  listPotentialConfiguredChannelIds: vi.fn(),
  resolveConfiguredChannelPluginIds:
    vi.fn<typeof import("./channel-plugin-ids.js").resolveConfiguredChannelPluginIds>(),
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

// mock-isolation: fixture channel inventories avoid loading installed plugin metadata.
vi.mock("./channel-plugin-ids.js", () => ({
  listExplicitConfiguredChannelIdsForConfig: () => [],
  loadGatewayStartupPluginPlan: () => ({ channelPluginIds: [], pluginIds: [] }),
  resolveConfiguredChannelPluginIds: mocks.resolveConfiguredChannelPluginIds,
}));

import { resolveEffectivePluginIds } from "./effective-plugin-ids.js";

it.each([
  ["legacy", []],
  ["early-context", ["early-context"]],
] as const)("retains slot %s while rechecking owner policy after callbacks", (slot, expected) => {
  mocks.listPotentialConfiguredChannelIds.mockReturnValue(["test-channel"]);
  const metadataSnapshot = createPluginMetadataSnapshotFixture({
    plugins: [
      { id: "legacy" },
      { id: "early-context" },
      { id: "bundled-channel-owner", channels: ["test-channel"] },
    ],
  });
  mocks.resolveConfiguredChannelPluginIds.mockImplementation(({ config }) => {
    config.plugins = {
      deny: ["bundled-channel-owner"],
      slots: { contextEngine: "later-context" },
    };
    return [];
  });

  expect(
    resolveEffectivePluginIds({
      config: { plugins: { slots: { contextEngine: slot } } },
      env: {},
      workspaceDir: "/workspace",
      metadataSnapshot,
    }),
  ).toEqual(expected);
});
