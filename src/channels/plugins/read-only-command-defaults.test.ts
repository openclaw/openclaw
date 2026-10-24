import { beforeEach, describe, expect, it, vi } from "vitest";
import { STATE_DIR } from "../../config/paths.js";

const { loadPluginMetadataSnapshot, resolvePluginMetadataSnapshot } = vi.hoisted(() => ({
  loadPluginMetadataSnapshot: vi.fn(),
  resolvePluginMetadataSnapshot: vi.fn(),
}));

vi.mock("../../plugins/plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot,
  resolvePluginMetadataSnapshot,
}));

import { resolveReadOnlyChannelCommandDefaults } from "./read-only-command-defaults.js";

const commands = { nativeCommandsAutoEnabled: true, nativeSkillsAutoEnabled: false };
function metadata(pluginId: string) {
  return {
    index: {
      plugins: [{ pluginId, origin: "global", enabled: true, enabledByDefault: true }],
    },
    plugins: [
      {
        id: pluginId,
        origin: "global",
        channels: ["demo"],
        channelConfigs: { demo: { commands } },
      },
    ],
  };
}

describe("resolveReadOnlyChannelCommandDefaults", () => {
  beforeEach(() => {
    loadPluginMetadataSnapshot.mockReset();
    resolvePluginMetadataSnapshot.mockReset();
    loadPluginMetadataSnapshot.mockReturnValue({
      index: { plugins: [] },
      plugins: [],
    });
    resolvePluginMetadataSnapshot.mockImplementation(loadPluginMetadataSnapshot);
  });

  it.each([
    { name: "process", env: process.env, stateDir: STATE_DIR },
    {
      name: "custom",
      env: { HOME: "/home/demo", OPENCLAW_STATE_DIR: "/state" },
      stateDir: "/state",
    },
  ])("reuses published metadata for the $name state root without scanning", ({ env, stateDir }) => {
    const currentSnapshot = { index: { plugins: [] }, plugins: [] };
    resolvePluginMetadataSnapshot.mockImplementation((params) =>
      params.stateDir === undefined ? currentSnapshot : loadPluginMetadataSnapshot(params),
    );

    expect(resolveReadOnlyChannelCommandDefaults("demo", { config: {}, env, stateDir })).toBe(
      undefined,
    );
    expect(loadPluginMetadataSnapshot).not.toHaveBeenCalled();
  });

  it("resolves command defaults from the shared metadata snapshot", () => {
    const env = { HOME: "/home/demo" };
    loadPluginMetadataSnapshot.mockReturnValue(metadata("demo"));

    expect(
      resolveReadOnlyChannelCommandDefaults("demo", {
        config: {},
        env,
        stateDir: "/state",
        workspaceDir: "/workspace",
      }),
    ).toEqual(commands);
    expect(loadPluginMetadataSnapshot).toHaveBeenCalledWith({
      allowWorkspaceScopedCurrent: true,
      config: {},
      env,
      stateDir: "/state",
      workspaceDir: "/workspace",
    });
  });

  it("resolves command defaults for manifest channel aliases", () => {
    loadPluginMetadataSnapshot.mockReturnValue(metadata("vendor-demo-plugin"));

    expect(resolveReadOnlyChannelCommandDefaults("demo", { config: {} })).toEqual(commands);
  });
});
