import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  copyUpdateCandidatePluginTrees,
  prepareUpdateCandidatePluginTrees,
} from "../infra/update-candidate-plugin-tree.js";
import { closeDefaultRetainedNativeWorkerSource } from "../infra/worker-native-lifecycle.js";
import { preparePluginDoctorMigrationBackupResources } from "./doctor-contract-preparation.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { createPluginManifestRecordFixture } from "./plugin-metadata.test-support.js";
const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  await closeDefaultRetainedNativeWorkerSource();
});
it.each(["indirect", "literalURL"])(
  "runs real Doctor contract over normalized external data without receipt: %s",
  async (kind) => {
    const root = fs.realpathSync(dirs.make("doctor-normalized-"));
    const plugin = path.join(root, "plugin"),
      assets = path.join(root, "assets"),
      stateDir = path.join(root, "state"),
      candidateRoot = path.join(root, "candidate");
    for (const dir of [plugin, assets, stateDir, candidateRoot]) {
      fs.mkdirSync(dir, { mode: 0o700 });
    }
    fs.writeFileSync(
      path.join(plugin, "package.json"),
      JSON.stringify({ name: "normalized-doctor", type: "module" }),
    );
    fs.writeFileSync(path.join(assets, "package.json"), JSON.stringify({ name: "asset-owner" }));
    const resource = path.join(stateDir, "backup.db");
    fs.writeFileSync(resource, "backup");
    fs.writeFileSync(path.join(assets, "config.txt"), resource);
    fs.symlinkSync(path.join(assets, "config.txt"), path.join(plugin, "config.txt"));
    const read =
      kind === "literalURL"
        ? "new URL('./config.txt',import.meta.url)"
        : "path.join(path.dirname(fileURLToPath(import.meta.url)),'config.txt')";
    fs.writeFileSync(
      path.join(plugin, "doctor-contract-api.mjs"),
      "import fs from 'node:fs'; import path from 'node:path'; import {fileURLToPath} from 'node:url';" +
        "export const stateMigrations=[{id:'asset-inventory',label:'Asset inventory',detectLegacyState(){return null},migrateLegacyState(){return {changes:[],warnings:[]}},collectBackupResources(){return [{path:fs.readFileSync(" +
        read +
        ",'utf8'),kind:'file'}]}}];",
    );
    const project = (source: string) => path.join(stateDir, path.relative(root, source));
    const plan = await prepareUpdateCandidatePluginTrees({
      roots: new Map([[plugin, project(plugin)]]),
      project,
      targetStateDir: stateDir,
      candidateRoot,
    });
    await copyUpdateCandidatePluginTrees(plan, { targetStateDir: stateDir, candidateRoot });
    const rootDir = project(plugin);
    const record = createPluginManifestRecordFixture({
      id: "normalized-doctor",
      rootDir,
      source: path.join(rootDir, "doctor-contract-api.mjs"),
      origin: "config",
      doctorContract: { stateMigrations: [{ id: "asset-inventory" }] },
    });
    await using cache = createPluginCache();
    const result = await withPluginCache(cache, () =>
      preparePluginDoctorMigrationBackupResources({
        config: { plugins: { allow: [record.id], entries: { [record.id]: { enabled: true } } } },
        env: {},
        stateDir,
        warnings: [],
        manifestRegistry: { plugins: [record], diagnostics: [] },
      }),
    );
    expect(result.resources).toEqual([{ path: resource, kind: "file" }]);
    expect(fs.readFileSync(path.join(assets, "config.txt"), "utf8")).toBe(resource);
  },
);
