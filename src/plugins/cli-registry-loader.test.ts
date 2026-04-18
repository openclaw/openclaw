import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const mocks = vi.hoisted(() => ({
  loadOpenClawPluginCliRegistry: vi.fn(),
  loadOpenClawPlugins: vi.fn(),
  resolveManifestActivationPluginIds: vi.fn(),
}));

vi.mock("./loader.js", () => ({
  loadOpenClawPluginCliRegistry: (...args: unknown[]) =>
    mocks.loadOpenClawPluginCliRegistry(...args),
  loadOpenClawPlugins: (...args: unknown[]) => mocks.loadOpenClawPlugins(...args),
}));

vi.mock("./activation-planner.js", () => ({
  resolveManifestActivationPluginIds: (...args: unknown[]) =>
    mocks.resolveManifestActivationPluginIds(...args),
}));

let resolvePrimaryCommandPluginIdsForCli: typeof import("./cli-registry-loader.js").resolvePrimaryCommandPluginIdsForCli;
let loadPluginCliMetadataEntries: typeof import("./cli-registry-loader.js").loadPluginCliMetadataEntries;

describe("plugins/cli-registry-loader", () => {
  beforeAll(async () => {
    ({ resolvePrimaryCommandPluginIdsForCli, loadPluginCliMetadataEntries } =
      await import("./cli-registry-loader.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveManifestActivationPluginIds.mockReturnValue([]);
    mocks.loadOpenClawPluginCliRegistry.mockResolvedValue({
      cliRegistrars: [
        {
          pluginId: "demo",
          commands: ["demo"],
          descriptors: [{ name: "demo", description: "Demo command", hasSubcommands: true }],
          register: vi.fn(),
        },
      ],
    });
  });

  it("resolves plugin ids for a primary command through manifest activation", () => {
    mocks.resolveManifestActivationPluginIds.mockReturnValue(["demo-plugin"]);

    const result = resolvePrimaryCommandPluginIdsForCli({
      cfg: {} as OpenClawConfig,
      primaryCommand: "demo",
    });

    expect(result).toEqual(["demo-plugin"]);
    expect(mocks.resolveManifestActivationPluginIds).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: { kind: "command", command: "demo" },
      }),
    );
  });

  it("loads metadata entries without forcing the full runtime loader", async () => {
    const entries = await loadPluginCliMetadataEntries({
      cfg: {} as OpenClawConfig,
      primaryCommand: "gateway",
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      pluginId: "demo",
      names: ["demo"],
    });
    expect(mocks.loadOpenClawPluginCliRegistry).toHaveBeenCalledTimes(1);
    expect(mocks.loadOpenClawPlugins).not.toHaveBeenCalled();
  });
});
