import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createStatfsFixture } from "../infra/disk-space.test-support.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { capturePluginSourceSnapshot } from "./plugin-generation-capture.js";
import { createPluginManifestRecordFixture } from "./plugin-metadata.test-support.js";
import {
  createPluginSourceCapture,
  withPluginSourceCaptureDirectory,
} from "./plugin-package-metadata-capture.js";
import {
  getPluginSetupModuleLoader,
  preparePluginSetupModuleLoader,
} from "./plugin-setup-module.js";
import { withPluginSourceCaptureStorage } from "./plugin-source-capture-context.js";
import { retainPluginSourceCaptureInstance } from "./plugin-source-capture-directory.js";
import { resolvePluginSourceCapturesDirectory } from "./plugin-source-capture-path.js";
import {
  pluginSourceSnapshotClosureDigest,
  stagePluginSourceSnapshot,
} from "./plugin-source-snapshot-artifact.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("refuses new and retained captures on low space without removing existing bytes", async () => {
  const stateDir = dirs.make("capture-disk-state-");
  const instance = retainPluginSourceCaptureInstance(stateDir, "temporary");
  const statfs = vi
    .spyOn(fs, "statfsSync")
    .mockReturnValue(createStatfsFixture({ bavail: 524288 }));
  const capture = instance.createDirectory();
  const sentinel = path.join(capture, "sentinel");
  fs.writeFileSync(sentinel, "retained bytes");
  statfs.mockReturnValue(createStatfsFixture({ bavail: 524287 }));
  try {
    for (const create of [
      () => instance.createDirectory(),
      () => instance.createNativeDirectory(),
      () => withPluginSourceCaptureDirectory(capture, () => createPluginSourceCapture()),
    ]) {
      expect(create).toThrow(/Plugin source capture refused.*512 MiB.*Free space/);
    }
    expect(fs.readFileSync(sentinel, "utf8")).toBe("retained bytes");
    expect(fs.readdirSync(capture)).toEqual(["sentinel"]);
    const fresh = retainPluginSourceCaptureInstance(dirs.make("capture-disk-fresh-"), "temporary");
    try {
      expect(() => fresh.createDirectory()).toThrow(/Plugin source capture refused/);
    } finally {
      await fresh.releaseAsync();
    }
  } finally {
    await instance.releaseAsync();
  }
});

it("falls back from a low state volume and keeps unavailable disk readings best effort", async () => {
  const stateDir = fs.realpathSync(dirs.make("capture-disk-fallback-"));
  const temporary = fs.realpathSync(dirs.make("capture-disk-temp-"));
  for (const key of ["TMPDIR", "TMP", "TEMP"]) {
    vi.stubEnv(key, temporary);
  }
  vi.spyOn(process, "emitWarning").mockImplementation(() => {});
  const statfs = vi
    .spyOn(fs, "statfsSync")
    .mockImplementation((target) =>
      createStatfsFixture({ bavail: String(target).startsWith(stateDir) ? 1 : 524288 }),
    );
  const instance = retainPluginSourceCaptureInstance(stateDir);
  try {
    const capture = instance.createDirectory();
    expect(capture.startsWith(temporary + path.sep)).toBe(true);
    statfs.mockImplementation(() => {
      throw new Error("statfs unavailable");
    });
    expect(fs.existsSync(instance.createDirectory())).toBe(true);
  } finally {
    await instance.releaseAsync();
  }
});

it("refuses snapshot staging before copying payload onto a low destination volume", async () => {
  const stateDir = dirs.make("snapshot-disk-state-");
  const source = dirs.make("snapshot-disk-source-");
  fs.writeFileSync(path.join(source, "package.json"), '{"name":"disk-fixture"}');
  const statfs = vi
    .spyOn(fs, "statfsSync")
    .mockReturnValue(createStatfsFixture({ bavail: 524288 }));
  const capture = withPluginSourceCaptureStorage({ stateDir, placement: "temporary" }, () =>
    capturePluginSourceSnapshot(source),
  );
  const binding = {
    installRecordHash: "record",
    contentDigest: capture.sourceDigest,
    dependencyClosureDigest: pluginSourceSnapshotClosureDigest(capture),
    buildResolutionDigest: "options",
  };
  statfs.mockReturnValue(createStatfsFixture({ bavail: 1 }));
  try {
    await expect(
      stagePluginSourceSnapshot({ stateDir, capture, binding, assertCurrent() {} }).then(
        async (stage) => {
          await stage.disposeAsync();
        },
      ),
    ).rejects.toThrow(/Plugin source capture refused.*512 MiB.*Free space/);
    expect(fs.existsSync(resolvePluginSourceCapturesDirectory(stateDir))).toBe(false);
  } finally {
    await capture.disposeAsync();
  }
});

it("contains low-space setup preparation failure so startup can continue", async () => {
  const stateDir = dirs.make("setup-disk-state-");
  const rootDir = dirs.make("setup-disk-source-");
  const source = path.join(rootDir, "setup.cjs");
  fs.writeFileSync(source, 'module.exports = { id: "disk-fixture", register() {} };');
  const record = createPluginManifestRecordFixture({
    id: "disk-fixture",
    origin: "config",
    rootDir,
    source,
    setupSource: source,
  });
  vi.spyOn(fs, "statfsSync").mockReturnValue(createStatfsFixture({ bavail: 1 }));
  await using cache = createPluginCache();
  await withPluginSourceCaptureStorage({ stateDir, placement: "temporary" }, () =>
    withPluginCache(cache, async () => {
      await expect(
        preparePluginSetupModuleLoader(record, source, rootDir),
      ).resolves.toBeUndefined();
      expect(() => getPluginSetupModuleLoader(record, source, rootDir)).toThrow(
        /Plugin source capture refused/,
      );
    }),
  );
});
