/** Tests manifest contract runtime resolution across bundled and installed plugin metadata. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const loadPluginMetadataSnapshot = vi.hoisted(() => vi.fn());

vi.mock("./plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./plugin-metadata-snapshot.js")>()),
  resolvePluginMetadataSnapshotAsync: (...args: unknown[]) => loadPluginMetadataSnapshot(...args),
}));

import { resolveManifestContractRuntimePluginResolution } from "./manifest-contract-runtime.js";

describe("resolveManifestContractRuntimePluginResolution", () => {
  beforeEach(() => {
    loadPluginMetadataSnapshot.mockReset();
    loadPluginMetadataSnapshot.mockReturnValue({
      index: { plugins: [] },
      plugins: [],
    });
  });

  it("resolves contract plugins from the shared metadata snapshot", async () => {
    loadPluginMetadataSnapshot.mockReturnValue({
      index: {
        plugins: [
          {
            pluginId: "bundled-search",
            origin: "bundled",
            enabled: true,
            enabledByDefault: true,
          },
          {
            pluginId: "external-search",
            origin: "global",
            enabled: true,
            enabledByDefault: true,
          },
        ],
      },
      plugins: [
        {
          id: "bundled-search",
          origin: "bundled",
          contracts: { webSearchProviders: ["search"] },
        },
        {
          id: "external-search",
          origin: "global",
          contracts: { webSearchProviders: ["search"] },
        },
      ],
    });

    expect(
      await resolveManifestContractRuntimePluginResolution({
        cfg: {},
        contract: "webSearchProviders",
        value: "search",
      }),
    ).toMatchObject({
      pluginIds: ["bundled-search", "external-search"],
      bundledCompatPluginIds: ["bundled-search"],
    });
    expect(loadPluginMetadataSnapshot).toHaveBeenCalledWith({
      config: {},
      env: process.env,
    });
  });
});
