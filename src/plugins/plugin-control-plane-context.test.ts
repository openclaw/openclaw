import { describe, expect, it } from "vitest";
import type { InstalledPluginIndex } from "./installed-plugin-index.js";
import { resolveInstalledManifestRegistryIndexFingerprint } from "./manifest-registry-installed.js";
import { resolvePluginControlPlaneFingerprint } from "./plugin-control-plane-context.js";

function createIndex(
  pluginId: string,
  options: {
    doctorContractFile?: InstalledPluginIndex["plugins"][number]["doctorContractFile"];
    doctorContractHash?: string;
    generatedAtMs?: number;
    packageBuild?: InstalledPluginIndex["plugins"][number]["packageBuild"];
  } = {},
): InstalledPluginIndex {
  return {
    version: 1,
    hostContractVersion: "test",
    compatRegistryVersion: "test",
    migrationVersion: 1,
    policyHash: "policy",
    generatedAtMs: options.generatedAtMs ?? 1,
    installRecords: {},
    diagnostics: [],
    plugins: [
      {
        pluginId,
        manifestPath: `/plugins/${pluginId}/openclaw.plugin.json`,
        manifestHash: `${pluginId}-manifest-hash`,
        ...(options.doctorContractHash ? { doctorContractHash: options.doctorContractHash } : {}),
        ...(options.doctorContractFile ? { doctorContractFile: options.doctorContractFile } : {}),
        packageBuild: options.packageBuild ?? {
          openclawVersion: "test",
          bundledDist: false,
        },
        rootDir: `/plugins/${pluginId}`,
        origin: "global",
        enabled: true,
        startup: {
          sidecar: false,
          memory: false,
          agentHarnesses: [],
        },
        compat: [],
      },
    ],
  };
}

describe("plugin control-plane context", () => {
  it("includes policy, inventory, and activation in one control-plane fingerprint", () => {
    const params = {
      config: { plugins: { allow: ["demo"] } },
      env: { HOME: "/home/a", OPENCLAW_HOME: "/openclaw/a" },
      index: createIndex("demo"),
      activationFingerprint: "activation-a",
    };
    const base = resolvePluginControlPlaneFingerprint(params);
    const fingerprint = (overrides: Partial<typeof params>) =>
      resolvePluginControlPlaneFingerprint({ ...params, ...overrides });
    expect(fingerprint({ index: createIndex("other") })).not.toBe(base);
    expect(fingerprint({ activationFingerprint: "activation-b" })).not.toBe(base);
    expect(
      resolvePluginControlPlaneFingerprint({
        ...params,
        config: { plugins: { deny: ["demo"] } },
      }),
    ).not.toBe(base);
  });

  it("tracks doctor contract content but ignores index generation time", () => {
    const makeIndex = (options: Parameters<typeof createIndex>[1] = {}) =>
      createIndex("demo", { doctorContractHash: "contract-a", ...options });
    const baseIndex = makeIndex();
    const changedContractIndex = makeIndex({ doctorContractHash: "contract-b" });
    const regeneratedIndex = makeIndex({ generatedAtMs: 2 });
    const retimedContractIndex = makeIndex({
      doctorContractFile: { size: 10, mtimeMs: 20, ctimeMs: 30 },
    });
    const rebuiltIndex = makeIndex({
      packageBuild: { openclawVersion: "next", bundledDist: false },
    });
    const buildOnlyIndex = makeIndex({ packageBuild: { openclawVersion: "test" } });
    const withoutBuildIndex: InstalledPluginIndex = {
      ...buildOnlyIndex,
      plugins: buildOnlyIndex.plugins.map(({ packageBuild: _packageBuild, ...plugin }) => plugin),
    };
    const bundledDistIndex = makeIndex({
      packageBuild: { openclawVersion: "test", bundledDist: true },
    });
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

    for (const fingerprint of [
      resolveInstalledManifestRegistryIndexFingerprint,
      resolveControlPlaneFingerprint,
    ]) {
      const base = fingerprint(baseIndex);
      expect(fingerprint(changedContractIndex)).not.toBe(base);
      expect(fingerprint(regeneratedIndex)).toBe(base);
      expect(fingerprint(retimedContractIndex)).toBe(base);
      expect(fingerprint(rebuiltIndex)).toBe(base);
      expect(fingerprint(withoutBuildIndex)).toBe(fingerprint(buildOnlyIndex));
      expect(fingerprint(bundledDistIndex)).not.toBe(base);
      expect(fingerprint(reorderedIndex)).toBe(base);
    }
  });
});
