import fs from "node:fs";
import path from "node:path";
import { isMainThread } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { UPDATE_PLUGIN_ASSET_RECEIPT_ENV } from "../infra/update-candidate-plugin-assets.js";
import { closeDefaultRetainedNativeWorkerSource } from "../infra/worker-native-lifecycle.js";
import { preparePluginDoctorMigrationBackupResources } from "./doctor-contract-preparation.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { createPluginManifestRecordFixture } from "./plugin-metadata.test-support.js";
import { createPrivateAssetFixture } from "./plugin-source-capture-asset.test-support.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  vi.unstubAllEnvs();
  await closeDefaultRetainedNativeWorkerSource();
});

async function fixture() {
  const asset = await createPrivateAssetFixture(dirs.make("doctor-asset-authority-"));
  const source = path.join(asset.rootDir, "doctor-contract-api.mjs");
  fs.writeFileSync(path.join(asset.rootDir, "package.json"), JSON.stringify({ type: "module" }));
  fs.writeFileSync(
    source,
    `import fs from 'node:fs';
    export const stateMigrations = [{
      id: 'asset-inventory', label: 'Asset inventory',
      detectLegacyState() { return null; },
      migrateLegacyState() { return { changes: [], warnings: [] }; },
      collectBackupResources() {
        let resource = ${JSON.stringify(asset.unavailableResource)};
        try {
          resource = JSON.parse(fs.readFileSync(new URL('./config.json', import.meta.url), 'utf8')).backupPath;
        } catch {}
        return [{ path: resource, kind: 'file' }];
      }
    }];`,
  );
  const record = createPluginManifestRecordFixture({
    id: "asset-doctor",
    rootDir: asset.rootDir,
    source,
    origin: "config",
    doctorContract: { stateMigrations: [{ id: "asset-inventory" }] },
  });
  return {
    ...asset,
    async prepare(env: NodeJS.ProcessEnv) {
      await using cache = createPluginCache();
      return await withPluginCache(cache, () =>
        preparePluginDoctorMigrationBackupResources({
          config: { plugins: { allow: [record.id], entries: { [record.id]: { enabled: true } } } },
          env,
          stateDir: asset.stateDir,
          warnings: [],
          manifestRegistry: { plugins: [record], diagnostics: [] },
        }),
      );
    },
  };
}

it.each(["same", "different"])(
  "does not admit the ambient %s-state asset into an explicit Doctor environment without a receipt",
  { timeout: 60_000 },
  async (ambientState) => {
    expect(isMainThread).toBe(true);
    const selected = await fixture();
    const ambient =
      ambientState === "same"
        ? selected
        : await createPrivateAssetFixture(dirs.make("doctor-ambient-authority-"));
    vi.stubEnv(UPDATE_PLUGIN_ASSET_RECEIPT_ENV, ambient.receipt);
    const result = await selected.prepare({});
    // The actual contract ran, but its private configuration was not admitted.
    expect(result.resources).toEqual([{ path: selected.unavailableResource, kind: "file" }]);
  },
);

it(
  "reads the authorized asset through the real Doctor contract with an explicit receipt",
  { timeout: 60_000 },
  async () => {
    expect(isMainThread).toBe(true);
    const selected = await fixture();
    const ambient = await createPrivateAssetFixture(dirs.make("doctor-ambient-authority-"));
    vi.stubEnv(UPDATE_PLUGIN_ASSET_RECEIPT_ENV, ambient.receipt);
    const result = await selected.prepare({ [UPDATE_PLUGIN_ASSET_RECEIPT_ENV]: selected.receipt });
    expect(result.resources).toEqual([{ path: selected.authorizedResource, kind: "file" }]);
  },
);
