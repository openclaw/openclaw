import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { closeDefaultRetainedNativeWorkerSource } from "../infra/worker-native-lifecycle.js";
import { hashJson } from "./installed-plugin-index-hash.js";
import { withPluginSourceCaptureStorage } from "./plugin-source-capture-context.js";
import {
  PLUGIN_SOURCE_SNAPSHOT_PREFIX,
  resolvePluginSourceCapturesDirectory,
} from "./plugin-source-capture-path.js";
import { acquirePluginSourceSnapshot } from "./plugin-source-snapshot-artifact.js";
import { preparePluginInstallSourceSnapshots } from "./plugin-source-snapshot-install.js";

const temp = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => closeDefaultRetainedNativeWorkerSource());

it.each(["demo", "constructor", "toString", "__proto__"])(
  "publishes unexecuted install bytes and a new generation for %s on same-version reinstall",
  async (pluginId) => {
    const stateDir = fs.realpathSync(temp.make("plugin-install-snapshot-"));
    const rootDir = path.join(stateDir, "source");
    fs.mkdirSync(rootDir);
    fs.writeFileSync(path.join(rootDir, "package.json"), '{"name":"demo","version":"1.0.0"}');
    const marker = path.join(stateDir, "executed");
    fs.writeFileSync(
      path.join(rootDir, "index.cjs"),
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'bad');`,
    );
    const installRecord: PluginInstallRecord = {
      source: "npm",
      installPath: rootDir,
      version: "1.0.0",
    };
    await withPluginSourceCaptureStorage({ stateDir, placement: "temporary" }, async () => {
      const publish = () =>
        preparePluginInstallSourceSnapshots({
          installOwner: pluginId,
          installRecord,
          manifests: [{ id: pluginId, rootDir, origin: "global" }],
          stateDir,
          assertCurrent() {},
          assertCleanupOwned() {},
        });
      await using first = await publish();
      await using second = await publish();
      const left = first.sourceSnapshots[0]!.descriptor;
      const right = second.sourceSnapshots[0]!.descriptor;
      expect(right.generation).not.toBe(left.generation);
      expect(right.installRecordHash).toBe(hashJson(installRecord));
      expect(Object.hasOwn(installRecord.sourceSnapshotDigests ?? {}, pluginId)).toBe(true);
      expect(right.contentDigest).toBe(
        installRecord.sourceSnapshotDigests?.[pluginId]?.contentDigest,
      );
      expect(right.dependencyClosureDigest).toBe(
        installRecord.sourceSnapshotDigests?.[pluginId]?.dependencyClosureDigest,
      );
      expect(fs.existsSync(marker)).toBe(false);
      const acquired = await acquirePluginSourceSnapshot({
        stateDir,
        descriptor: { ...right, installedRevision: 1 },
        assertCurrent() {},
      });
      try {
        expect(fs.readFileSync(path.join(acquired.rootDir, "index.cjs"), "utf8")).toContain(
          "writeFileSync",
        );
      } finally {
        await acquired.releaseAsync();
      }
    });
  },
);

it("keeps a mutable local install on the ordinary capture path", async () => {
  const stateDir = fs.realpathSync(temp.make("plugin-local-snapshot-"));
  const installRecord: PluginInstallRecord = { source: "path", sourcePath: "/local/development" };
  await using result = await preparePluginInstallSourceSnapshots({
    installOwner: "demo",
    installRecord,
    manifests: [{ id: "demo", rootDir: installRecord.sourcePath!, origin: "config" }],
    stateDir,
    assertCurrent() {},
    assertCleanupOwned() {},
  });
  expect(result.sourceSnapshots).toEqual([]);
  expect(installRecord.sourceSnapshotDigests).toBeUndefined();
});

it("reclaims a published candidate after the installation owner changes", async () => {
  const stateDir = fs.realpathSync(temp.make("plugin-install-publication-loss-"));
  const rootDir = path.join(stateDir, "source");
  fs.mkdirSync(rootDir);
  fs.writeFileSync(path.join(rootDir, "package.json"), '{"name":"demo","version":"1.0.0"}');
  fs.writeFileSync(path.join(rootDir, "index.cjs"), "exports.value = 42;");
  const captureRoot = resolvePluginSourceCapturesDirectory(stateDir);
  const candidates = () =>
    fs.existsSync(captureRoot)
      ? fs.readdirSync(captureRoot).filter((name) => name.startsWith(PLUGIN_SOURCE_SNAPSHOT_PREFIX))
      : [];
  const changed = new Error("installation owner changed after publication");
  let observedPublished = false;
  await withPluginSourceCaptureStorage({ stateDir, placement: "temporary" }, async () => {
    await expect(
      preparePluginInstallSourceSnapshots({
        installOwner: "demo",
        installRecord: { source: "npm", installPath: rootDir },
        manifests: [{ id: "demo", rootDir, origin: "global" }],
        stateDir,
        assertCurrent() {
          if (candidates().length) {
            observedPublished = true;
            throw changed;
          }
        },
        assertCleanupOwned() {},
      }),
    ).rejects.toBe(changed);
    expect(observedPublished).toBe(true);
    expect(candidates()).toEqual([]);
  });
});
