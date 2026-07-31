import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";

const mocks = vi.hoisted(() => ({
  resolveSnapshot: vi.fn(),
  workspaceDirs: [] as string[],
}));

vi.mock("../agents/workspace-dirs.js", () => ({
  listAgentWorkspaceDirs: () => mocks.workspaceDirs,
}));

vi.mock("../plugins/plugin-metadata-snapshot.js", () => ({
  resolvePluginMetadataSnapshot: (...args: unknown[]) => mocks.resolveSnapshot(...args),
}));

import { resolveConfigWidePluginMetadataSnapshot } from "./io.plugin-metadata.js";

function plugin(id: string, source: string): PluginManifestRecord {
  return {
    id,
    channels: [],
    providers: [],
    cliBackends: [],
    skills: [],
    hooks: [],
    origin: "workspace",
    rootDir: `/tmp/${id}`,
    source,
    manifestPath: `${source}/openclaw.plugin.json`,
  };
}

function snapshot(plugins: PluginManifestRecord[]): PluginMetadataSnapshot {
  return {
    normalizePluginId: (pluginId: string) => pluginId.toLowerCase(),
    plugins,
    diagnostics: [],
    manifestRegistry: { plugins, diagnostics: [] },
  } as unknown as PluginMetadataSnapshot;
}

describe("config validation plugin metadata snapshots", () => {
  beforeEach(() => {
    mocks.resolveSnapshot.mockReset();
    mocks.workspaceDirs = ["/tmp/ops", "/tmp/research"];
  });

  it("merges plugins discovered in distinct agent workspaces", () => {
    mocks.resolveSnapshot.mockImplementation(({ workspaceDir }: { workspaceDir: string }) =>
      workspaceDir === "/tmp/ops"
        ? snapshot([plugin("ops-plugin", "/tmp/ops/plugin")])
        : snapshot([plugin("research-plugin", "/tmp/research/plugin")]),
    );

    const merged = resolveConfigWidePluginMetadataSnapshot({ config: {} });

    expect(merged.manifestRegistry.plugins.map((entry) => entry.id)).toEqual([
      "ops-plugin",
      "research-plugin",
    ]);
  });

  it("rejects one plugin id discovered from different workspace sources", () => {
    mocks.resolveSnapshot.mockImplementation(({ workspaceDir }: { workspaceDir: string }) =>
      workspaceDir === "/tmp/ops"
        ? snapshot([plugin("shared", "/tmp/ops/shared")])
        : snapshot([plugin("shared", "/tmp/research/shared")]),
    );

    const merged = resolveConfigWidePluginMetadataSnapshot({ config: {} });

    expect(merged.manifestRegistry.plugins).toEqual([]);
    expect(merged.manifestRegistry.diagnostics).toContainEqual(
      expect.objectContaining({ level: "error", pluginId: "shared" }),
    );
  });
});
