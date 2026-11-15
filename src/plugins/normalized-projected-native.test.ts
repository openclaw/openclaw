import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  copyUpdateCandidatePluginTrees,
  prepareUpdateCandidatePluginTrees,
} from "../infra/update-candidate-plugin-tree.js";
import { createFixture } from "./plugin-generation-artifact.admission.test-support.js";
import { captureResources } from "./plugin-generation-capture.test-support.js";
import {
  nativeAdmissionStateFor,
  preparePluginNativeAdmissions,
} from "./plugin-native-admission-state.js";
import { withPluginSourceCaptureStorage } from "./plugin-source-capture-context.js";
const dirs = useAutoCleanupTempDirTracker(afterEach);
it.each([false, true])(
  "normalizes data while preserving internal native aliases and reuse (nested=%s)",
  async (nested) => {
    const root = fs.realpathSync(dirs.make("projected-native-assets-"));
    const f = createFixture(path.join(root, "source"), true);
    const assets = path.join(root, "assets"),
      stateDir = path.join(root, "state"),
      candidateRoot = path.join(root, "candidate");
    for (const p of [assets, stateDir, candidateRoot]) {
      fs.mkdirSync(p, { mode: 0o700 });
    }
    fs.writeFileSync(path.join(assets, "package.json"), JSON.stringify({ name: "asset-owner" }));
    const source = path.join(assets, "config.txt");
    fs.writeFileSync(source, "native config");
    let binary = f.filename;
    if (nested) {
      fs.mkdirSync(path.join(f.root, "native"));
      binary = path.join(f.root, "native", "fixture.bin");
      fs.renameSync(f.filename, binary);
    }
    for (const name of ["a-alias.so", "z-alias.so"]) {
      fs.symlinkSync(path.relative(f.root, binary), path.join(f.root, name));
    }
    fs.symlinkSync(source, path.join(path.dirname(binary), "config.txt"));
    const project = (file: string) => path.join(stateDir, path.relative(root, file));
    const plan = await prepareUpdateCandidatePluginTrees({
      roots: new Map([[f.root, project(f.root)]]),
      project,
      targetStateDir: stateDir,
      candidateRoot,
    });
    await copyUpdateCandidatePluginTrees(plan, { targetStateDir: stateDir, candidateRoot });
    expect(fs.lstatSync(project(path.join(path.dirname(binary), "config.txt"))).isFile()).toBe(
      true,
    );
    await using resources = captureResources();
    const cache = resources.cache();
    await withPluginSourceCaptureStorage({ stateDir, placement: "state" }, async () => {
      const index = structuredClone(f.index);
      for (const record of index.plugins) {
        record.rootDir = project(record.rootDir);
        record.source = record.source ? project(record.source) : undefined;
        record.manifestPath = project(record.manifestPath);
      }
      for (const record of Object.values(index.installRecords)) {
        record.installPath = record.installPath ? project(record.installPath) : undefined;
      }
      preparePluginNativeAdmissions(index, cache);
      const first = resources.capture(cache, project(f.root));
      const a = first.resolve(project(path.join(f.root, "a-alias.so"))),
        z = first.resolve(project(path.join(f.root, "z-alias.so")));
      expect(fs.realpathSync(a)).toBe(fs.realpathSync(z));
      expect(
        fs.readFileSync(path.join(path.dirname(fs.realpathSync(a)), "config.txt"), "utf8"),
      ).toBe("native config");
      expect(nativeAdmissionStateFor(cache).namespaces.size).toBeGreaterThan(0);
      const second = resources.capture(cache, project(f.root));
      expect(fs.realpathSync(second.resolve(project(path.join(f.root, "a-alias.so"))))).toBe(
        fs.realpathSync(a),
      );
      expect(fs.readFileSync(source, "utf8")).toBe("native config");
      expect(fs.statSync(source).nlink).toBe(1);
    });
  },
);
