/** Tests dynamic channel env-var discovery from plugin/channel metadata. */
import { beforeEach, describe, expect, it, vi } from "vitest";

type MockSnapshot = {
  plugins: Array<{
    id: string;
    origin: string;
    packageChannel: {
      id: string;
      configuredState: { env: { anyOf: string[] } };
    };
  }>;
  manifestRegistry: { plugins: unknown[]; diagnostics: unknown[] };
};

const pluginRegistryMocks = vi.hoisted(() => ({
  loadPluginMetadataSnapshot: vi.fn<(_params?: unknown) => MockSnapshot>(),
  resolvePluginMetadataSnapshot: vi.fn<(params: unknown) => MockSnapshot>(),
}));

vi.mock("../plugins/plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: pluginRegistryMocks.loadPluginMetadataSnapshot,
  resolvePluginMetadataSnapshot: pluginRegistryMocks.resolvePluginMetadataSnapshot,
}));

describe("channel env vars dynamic package metadata", () => {
  beforeEach(() => {
    vi.resetModules();
    pluginRegistryMocks.loadPluginMetadataSnapshot.mockReset();
    pluginRegistryMocks.resolvePluginMetadataSnapshot.mockReset();
  });

  it("reuses published channel metadata without rescanning manifests", async () => {
    pluginRegistryMocks.resolvePluginMetadataSnapshot.mockReturnValue({
      plugins: [
        {
          id: "external-mattermost",
          origin: "global",
          packageChannel: {
            id: "mattermost",
            configuredState: { env: { anyOf: ["MATTERMOST_BOT_TOKEN"] } },
          },
        },
      ],
      manifestRegistry: { plugins: [], diagnostics: [] },
    });
    const mod = await import("./channel-env-vars.js");

    expect(mod.getChannelEnvVars("mattermost")).toEqual(["MATTERMOST_BOT_TOKEN"]);
    expect(mod.listKnownChannelEnvVarNames()).toEqual(["MATTERMOST_BOT_TOKEN"]);
    expect(pluginRegistryMocks.loadPluginMetadataSnapshot).not.toHaveBeenCalled();
    expect(pluginRegistryMocks.resolvePluginMetadataSnapshot).toHaveBeenCalledTimes(2);
    expect(pluginRegistryMocks.resolvePluginMetadataSnapshot).toHaveBeenCalledWith({
      config: undefined,
      workspaceDir: undefined,
      env: process.env,
    });
  });
});
