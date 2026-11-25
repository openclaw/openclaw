import { expect, it } from "vitest";
import type { InstalledPluginIndex } from "./installed-plugin-index.js";
import { resolveInstalledManifestRegistryIndexFingerprint } from "./manifest-registry-installed.js";
import { resolvePluginControlPlaneFingerprint } from "./plugin-control-plane-context.js";
import { createIndexFixture } from "./test-helpers/installed-plugin-index-fixture.js";

function createIndex(
  pluginId: string,
  plugin: Partial<InstalledPluginIndex["plugins"][number]> = {},
  generatedAtMs = 1,
): InstalledPluginIndex {
  return createIndexFixture({
    policyHash: "policy",
    generatedAtMs,
    plugins: [
      {
        pluginId,
        manifestPath: `/plugins/${pluginId}/openclaw.plugin.json`,
        manifestHash: `${pluginId}-manifest-hash`,
        packageBuild: { openclawVersion: "test", bundledDist: false },
        rootDir: `/plugins/${pluginId}`,
        origin: "global",
        enabled: true,
        startup: { sidecar: false, memory: false, agentHarnesses: [] },
        compat: [],
        ...plugin,
      },
    ],
  });
}

it("includes policy, inventory, and activation in one control-plane fingerprint", () => {
  const params = {
    config: { plugins: { allow: ["demo"] } },
    env: { HOME: "/home/a", OPENCLAW_HOME: "/openclaw/a" },
    index: createIndex("demo"),
    activationFingerprint: "activation-a",
  };
  const base = resolvePluginControlPlaneFingerprint(params);
  const fingerprint = (
    overrides: Partial<Parameters<typeof resolvePluginControlPlaneFingerprint>[0]>,
  ) => resolvePluginControlPlaneFingerprint({ ...params, ...overrides });
  expect(fingerprint({ index: createIndex("other") })).not.toBe(base);
  expect(fingerprint({ activationFingerprint: "activation-b" })).not.toBe(base);
  expect(fingerprint({ config: { plugins: { deny: ["demo"] } } })).not.toBe(base);
});

it("tracks doctor contract content but ignores index generation time", () => {
  const makeIndex = (plugin: Parameters<typeof createIndex>[1] = {}, time = 1) =>
    createIndex("demo", { doctorContractHash: "contract-a", ...plugin }, time);
  const baseIndex = makeIndex();
  const buildOnlyIndex = makeIndex({ packageBuild: { openclawVersion: "test" } });
  const withoutBuildIndex: InstalledPluginIndex = {
    ...buildOnlyIndex,
    plugins: buildOnlyIndex.plugins.map(({ packageBuild: _packageBuild, ...plugin }) => plugin),
  };
  const reorderedIndexSource = makeIndex();
  const { pluginId, ...reorderedPlugin } = reorderedIndexSource.plugins[0]!;
  const reorderedIndex: InstalledPluginIndex = {
    ...reorderedIndexSource,
    plugins: [{ ...reorderedPlugin, pluginId }],
  };
  const resolveControlPlaneFingerprint = (index: InstalledPluginIndex) =>
    resolvePluginControlPlaneFingerprint({
      config: { plugins: { allow: ["demo"] } },
      env: { HOME: "/home/a", OPENCLAW_HOME: "/openclaw/a" },
      index,
      activationFingerprint: "activation-a",
    });

  const fingerprints = (index: InstalledPluginIndex) => [
    resolveInstalledManifestRegistryIndexFingerprint(index),
    resolveControlPlaneFingerprint(index),
  ];
  const base = fingerprints(baseIndex);
  for (const [candidate, equal] of [
    [makeIndex({ doctorContractHash: "contract-b" }), false],
    [makeIndex({}, 2), true],
    [makeIndex({ doctorContractFile: { size: 10, mtimeMs: 20, ctimeMs: 30 } }), true],
    [makeIndex({ packageBuild: { openclawVersion: "next", bundledDist: false } }), true],
    [makeIndex({ packageBuild: { openclawVersion: "test", bundledDist: true } }), false],
    [reorderedIndex, true],
  ] as const) {
    expect(fingerprints(candidate).map((value, i) => value === base[i])).toEqual([equal, equal]);
  }
  expect(fingerprints(withoutBuildIndex)).toEqual(fingerprints(buildOnlyIndex));
});
