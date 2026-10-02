import { afterEach, expect, it, vi } from "vitest";
import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { resolveConfigWidePluginMetadataSnapshot } from "./io.plugin-metadata.js";

const { loadRegistry } = vi.hoisted(() => ({ loadRegistry: vi.fn() }));

vi.mock("../plugins/plugin-registry-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/plugin-registry-snapshot.js")>()),
  loadPluginRegistrySnapshotWithMetadata: loadRegistry,
  preparePluginRegistrySnapshotReader:
    (params: Record<string, unknown>) => (workspaceDir: string | undefined) =>
      loadRegistry({ ...params, workspaceDir }),
}));

afterEach(() => {
  vi.restoreAllMocks();
  clearPluginMetadataLifecycleCaches();
});

it("materializes shared plugin metadata once across the fleet and retains its immutable facts", () => {
  const configSchema = { type: "object", properties: { label: { type: "string" } } };
  const source = createPluginMetadataSnapshotFixture({
    plugins: [{ id: "shared", providers: ["shared"], configSchema }],
  });
  loadRegistry.mockImplementation(({ workspaceDir }: { workspaceDir: string }) => ({
    snapshot: { ...source.index, workspaceDir },
    source: "derived",
    diagnostics: [],
    manifestRegistry: source.manifestRegistry,
  }));
  const config = {
    agents: {
      ownership: "explicit" as const,
      entries: Object.fromEntries(
        ["first", "second", "third"].map((id) => [id, { workspace: `/fleet/${id}` }]),
      ),
    },
  };
  const freeze = vi.spyOn(Object, "freeze");
  withPluginCache(createPluginCache(), () => {
    const params = { config, env: {}, installRecords: {}, allowCurrent: false };
    const snapshot = resolveConfigWidePluginMetadataSnapshot(params);
    expect(snapshot.plugins.map((plugin) => plugin.id)).toEqual(["shared"]);
    expect(snapshot.owners.providers.get("shared")).toEqual(["shared"]);
    expect(snapshot.registryIndex.workspaceDir).toBe("/fleet/first");
    expect(snapshot.manifestRegistry.plugins[0]?.configSchema).toBe(configSchema);
    expect(freeze.mock.calls.filter(([value]) => value === configSchema)).toHaveLength(1);
    expect(Object.isFrozen(configSchema.properties.label)).toBe(true);
    expect(Object.isFrozen(source.index)).toBe(false);
    expect(() => {
      configSchema.properties.label.type = "number";
    }).toThrow();
    expect(resolveConfigWidePluginMetadataSnapshot(params)).toBe(snapshot);
    expect(freeze.mock.calls.filter(([value]) => value === configSchema)).toHaveLength(1);
    expect(loadRegistry).toHaveBeenCalledTimes(3);
  });
});
