import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { closeDefaultRetainedNativeWorkerSource } from "../infra/worker-native-lifecycle.js";
import { withPluginSourceCaptureStorage } from "./plugin-source-capture-context.js";
import {
  PLUGIN_SOURCE_SNAPSHOT_PREFIX,
  resolvePluginSourceCapturesDirectory,
} from "./plugin-source-capture-path.js";
import { preparePluginInstallSourceSnapshots } from "./plugin-source-snapshot-install.js";
import * as snapshotPublication from "./plugin-source-snapshot-publication.js";

const temp = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  vi.restoreAllMocks();
  await closeDefaultRetainedNativeWorkerSource();
});

it.each(["demo", "constructor", "toString", "__proto__"])(
  "records unexecuted install digests without publishing snapshots for %s",
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
    const publishCalls = vi.fn();
    const bind = snapshotPublication.bindPluginSnapshotPublication;
    vi.spyOn(snapshotPublication, "bindPluginSnapshotPublication").mockImplementation((...args) => {
      const capture = bind(...args);
      return { ...capture, publish: publishCalls.mockImplementation(capture.publish) };
    });
    await withPluginSourceCaptureStorage({ stateDir, placement: "temporary" }, async () => {
      const prepare = () =>
        preparePluginInstallSourceSnapshots({
          installOwner: pluginId,
          installRecord,
          manifests: [{ id: pluginId, rootDir, origin: "global" }],
          stateDir,
          assertCurrent() {},
          assertCleanupOwned() {},
        });
      await using first = await prepare();
      const firstDigests = installRecord.sourceSnapshotDigests?.[pluginId];
      expect(firstDigests?.contentDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(firstDigests?.dependencyClosureDigest).toMatch(/^[a-f0-9]{64}$/);
      await using second = await prepare();
      expect(installRecord.sourceSnapshotDigests?.[pluginId]).toEqual(firstDigests);
      expect(publishCalls).toHaveBeenCalledTimes(0);
      expect(first.sourceSnapshots).toEqual([]);
      expect(second.sourceSnapshots).toEqual([]);
      expect(fs.existsSync(marker)).toBe(false);
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

it("releases captured source when the installation owner changes", async () => {
  const stateDir = fs.realpathSync(temp.make("plugin-install-publication-loss-"));
  const rootDir = path.join(stateDir, "source");
  fs.mkdirSync(rootDir);
  fs.writeFileSync(path.join(rootDir, "package.json"), '{"name":"demo","version":"1.0.0"}');
  fs.writeFileSync(path.join(rootDir, "index.cjs"), "exports.value = 42;");
  const changed = new Error("installation owner changed after capture");
  let checks = 0;
  await withPluginSourceCaptureStorage({ stateDir, placement: "temporary" }, async () => {
    await expect(
      preparePluginInstallSourceSnapshots({
        installOwner: "demo",
        installRecord: { source: "npm", installPath: rootDir },
        manifests: [{ id: "demo", rootDir, origin: "global" }],
        stateDir,
        assertCurrent() {
          if (++checks === 2) {
            throw changed;
          }
        },
        assertCleanupOwned() {},
      }),
    ).rejects.toBe(changed);
    const captureRoot = resolvePluginSourceCapturesDirectory(stateDir);
    expect(
      fs.existsSync(captureRoot)
        ? fs
            .readdirSync(captureRoot)
            .filter((name) => name.startsWith(PLUGIN_SOURCE_SNAPSHOT_PREFIX))
        : [],
    ).toEqual([]);
  });
});
