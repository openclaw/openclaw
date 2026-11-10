import { afterEach, expect, it, vi } from "vitest";
import * as workspaceDirs from "../agents/workspace-dirs.js";
import { createDoctorPluginMetadataSnapshotScope } from "../commands/doctor/shared/plugin-metadata-snapshot-scope.js";
import { getCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { resolveInstalledPluginIndexPolicyHash } from "../plugins/installed-plugin-index-policy.js";
import { createPluginCache, getPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import {
  resolveConfigWidePluginMetadataSnapshot,
  resolveConfigWidePluginMetadataSnapshotAsync,
} from "./io.plugin-metadata.js";

const { loadRegistry } = vi.hoisted(() => ({ loadRegistry: vi.fn() }));

vi.mock("../plugins/plugin-registry-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/plugin-registry-snapshot.js")>()),
  loadPluginRegistrySnapshotWithMetadata: loadRegistry,
  preparePluginRegistrySnapshotReader:
    (params: Record<string, unknown>) => (workspaceDir: string | undefined) =>
      loadRegistry({ ...params, workspaceDir }),
}));

afterEach(() => {
  loadRegistry.mockClear();
  vi.restoreAllMocks();
  clearPluginMetadataLifecycleCaches();
});

it("bounds Doctor workspace snapshots without repeatedly rebuilding the fleet registry", async () => {
  const source = createPluginMetadataSnapshotFixture({ plugins: [{ id: "shared" }] });
  loadRegistry.mockClear();
  loadRegistry.mockImplementation(({ workspaceDir, config }) => ({
    snapshot: {
      ...source.index,
      workspaceDir,
      policyHash: resolveInstalledPluginIndexPolicyHash(config, {}),
    },
    source: "derived",
    diagnostics: [],
    manifestRegistry: source.manifestRegistry,
  }));
  const workspaces = Array.from({ length: 200 }, (_, index) => `/fleet/agent-${index}`);
  const config = {
    agents: {
      ownership: "explicit" as const,
      entries: Object.fromEntries(
        workspaces.map((workspace, index) => [`a${index}`, { workspace }]),
      ),
    },
  };
  await using scope = createDoctorPluginMetadataSnapshotScope({ env: {} });
  const read = (workspaceDir: string) =>
    scope.run({ config, workspaceDir }, () => {
      expect(getPluginCache().metadata.snapshots.size).toBeLessThanOrEqual(64);
      return getCurrentPluginMetadataSnapshot({ config, workspaceDir, env: {} });
    });
  const first = read(workspaces[0]!);
  for (const workspace of workspaces.slice(1)) {
    expect(read(workspace)?.plugins.map((plugin) => plugin.id)).toEqual(["shared"]);
  }
  expect(read(workspaces.at(-1)!)).toBe(read(workspaces.at(-1)!));
  expect(read(workspaces[0]!)).not.toBe(first);
  expect(first?.plugins.map((plugin) => plugin.id)).toEqual(["shared"]);
  // The fleet merge reuses its first workspace; reloading it adds one read, not a fleet scan.
  expect(loadRegistry).toHaveBeenCalledTimes(workspaces.length * 2);
});

it.each(["sync", "async"] as const)(
  "materializes %s shared plugin metadata once across the fleet and retains its prepared facts",
  async (mode) => {
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
    await withTempDir("openclaw-metadata-fleet-", async (stateDir) =>
      withPluginCache(createPluginCache(), async () => {
        const params = {
          config,
          env: { OPENCLAW_STATE_DIR: stateDir },
          installRecords: {},
          allowCurrent: false,
        };
        const selectWorkspaces = vi.spyOn(workspaceDirs, "listAgentWorkspaceDirs");
        const read =
          mode === "async"
            ? resolveConfigWidePluginMetadataSnapshotAsync
            : resolveConfigWidePluginMetadataSnapshot;
        const snapshot = await read(params);
        expect(snapshot.plugins.map((plugin) => plugin.id)).toEqual(["shared"]);
        expect(snapshot.owners.providers.get("shared")).toEqual(["shared"]);
        expect(snapshot.registryIndex.workspaceDir).toBe("/fleet/first");
        expect(snapshot.manifestRegistry.plugins[0]?.configSchema).toBe(configSchema);
        expect(Object.isFrozen(source.index)).toBe(false);
        expect(selectWorkspaces).toHaveBeenCalledTimes(1);
        expect(await read(params)).toBe(snapshot);
        expect(selectWorkspaces).toHaveBeenCalledTimes(2);
        expect(loadRegistry).toHaveBeenCalledTimes(3);
      }),
    );
  },
);
