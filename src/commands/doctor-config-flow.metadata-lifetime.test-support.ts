import fs from "node:fs/promises";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { expect, it, vi, type Mock } from "vitest";
import {
  getPluginCache,
  getPluginCacheRetirementSignal,
  retirePluginCache,
} from "../plugins/plugin-cache.js";
import { createPluginManifestRecordFixture } from "../plugins/plugin-metadata.test-support.js";
import { loadAndMaybeMigrateDoctorConfig } from "./doctor-config-flow.js";
import { runDoctorConfigWithInput } from "./doctor-config-flow.test-utils.js";

/** Register against the config-flow suite's existing orchestration mocks. */
export function registerDoctorPreparedMetadataTests(preflightOptionsMock: Mock): void {
  it("prepares plugin metadata for the complete Doctor lifecycle", async () => {
    await using result = await runDoctorConfigWithInput({
      config: {},
      run: loadAndMaybeMigrateDoctorConfig,
    });

    expect(preflightOptionsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ preparePluginMetadataSnapshot: true }),
    );
    expect(result.runWithPluginMetadataSnapshot).toEqual(expect.any(Function));
    expect(result.invalidatePluginMetadataSnapshot).toEqual(expect.any(Function));
  });

  it("keeps prepared plugin contracts alive until the returned Doctor resources retire", async () => {
    const { listPluginDoctorLegacyConfigRules } = await vi.importActual<
      typeof import("../plugins/doctor-contract-registry.js")
    >("../plugins/doctor-contract-registry.js");
    await withTempHome(async (home) => {
      const rootDir = path.join(home, "fixture-plugin");
      await fs.mkdir(rootDir);
      await fs.writeFile(
        path.join(rootDir, "doctor-contract-api.cjs"),
        'module.exports = { legacyConfigRules: [{ path: ["fixture"], message: "Fixture repair remains available" }] };\n',
      );
      await using result = await runDoctorConfigWithInput({
        config: {},
        run: loadAndMaybeMigrateDoctorConfig,
      });
      // Inventory repairs refresh contracts after config preparation has captured its original rules.
      result.invalidatePluginMetadataSnapshot();
      const cache = result.runWithPluginMetadataSnapshot({ config: result.cfg }, getPluginCache);
      const readRules = () =>
        result.runWithPluginMetadataSnapshot({ config: result.cfg }, () =>
          listPluginDoctorLegacyConfigRules({
            manifestRegistry: {
              plugins: [
                createPluginManifestRecordFixture({ id: "fixture", rootDir, origin: "global" }),
              ],
              diagnostics: [],
            },
          }),
        );
      try {
        expect(readRules()).toEqual([
          expect.objectContaining({
            path: ["fixture"],
            message: "Fixture repair remains available",
          }),
        ]);
        expect(getPluginCacheRetirementSignal(cache).aborted).toBe(false);
        await result[Symbol.asyncDispose]();
        expect(getPluginCacheRetirementSignal(cache).aborted).toBe(true);
        expect(cache.setupModules.size).toBe(0);
      } finally {
        await retirePluginCache(cache);
      }
    });
  });
}

/** Discarded config results still own their metadata and must join retirement. */
export async function runDoctorConfigWithInputAndDispose(
  params: Parameters<typeof runDoctorConfigWithInput<AsyncDisposable>>[0],
): Promise<void> {
  const result = await runDoctorConfigWithInput(params);
  await result[Symbol.asyncDispose]();
}
