import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeDefaultRetainedNativeWorkerSource } from "../infra/worker-native-lifecycle.js";
import {
  preparePluginGenerationArtifact,
  preparePluginSourceSnapshot,
} from "./plugin-generation-worker.js";
import { PluginSnapshotDependencyError } from "./plugin-snapshot-dependency-error.js";
import { withPluginSourceCaptureStorage } from "./plugin-source-capture-context.js";
import {
  collectPluginSourceSnapshots,
  PluginSourceSnapshotValidationError,
} from "./plugin-source-snapshot-artifact.js";
import type { PluginSourceSnapshotDescriptor } from "./plugin-source-snapshot.types.js";

const temp = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => closeDefaultRetainedNativeWorkerSource());

async function withSnapshot(
  run: (fixture: {
    stateDir: string;
    rootDir: string;
    entry: string;
    descriptor: PluginSourceSnapshotDescriptor;
  }) => Promise<void>,
) {
  const stateDir = fs.realpathSync(temp.make("plugin-worker-snapshot-"));
  const rootDir = path.join(stateDir, "source");
  fs.mkdirSync(rootDir);
  const entry = path.join(rootDir, "index.js");
  fs.writeFileSync(path.join(rootDir, "package.json"), '{"name":"fixture","type":"module"}');
  fs.writeFileSync(entry, "export const value = 42;");
  await withPluginSourceCaptureStorage({ stateDir, placement: "temporary" }, async () => {
    const snapshot = await preparePluginSourceSnapshot({ stateDir, rootDir });
    try {
      const descriptor = {
        ...(await snapshot.publish({
          installRecordHash: "install-record",
          contentDigest: snapshot.contentDigest,
          dependencyClosureDigest: snapshot.dependencyClosureDigest,
          buildResolutionDigest: "build-resolution",
        })),
        installedRevision: 1,
      };
      await run({ stateDir, rootDir, entry, descriptor });
    } finally {
      await snapshot.disposeAsync();
    }
  });
}

it("prepares independent runtime instances from worker-published immutable source", async () => {
  await withSnapshot(async ({ stateDir, rootDir, entry, descriptor }) => {
    fs.writeFileSync(entry, "export const value = 99;");
    const left = await preparePluginGenerationArtifact({
      rootDir,
      source: entry,
      sourceSnapshot: { stateDir, descriptor },
    });
    const right = await preparePluginGenerationArtifact({
      rootDir,
      source: entry,
      sourceSnapshot: { stateDir, descriptor },
    });
    const unrelated = await preparePluginGenerationArtifact({ rootDir, source: entry });
    const collect = () =>
      collectPluginSourceSnapshots({
        stateDir,
        retainedPaths: new Set(),
        retiredSnapshots: [descriptor],
        assertCurrent() {},
      });
    try {
      expect(left.artifact.rootDir).not.toBe(right.artifact.rootDir);
      expect(fs.readFileSync(left.artifact.resolve(entry), "utf8")).toBe(
        "export const value = 42;",
      );
      expect(fs.readFileSync(right.artifact.resolve(entry), "utf8")).toBe(
        "export const value = 42;",
      );
      const outside = path.join(stateDir, "late.js");
      fs.writeFileSync(outside, "export const value = 'late';");
      expect(() => left.artifact.captureResolvedModule(outside)).toThrow(
        PluginSnapshotDependencyError,
      );
      expect((await collect()).removed).toEqual([]);
      await left.artifact.disposeAsync();
      expect((await collect()).removed).toEqual([]);
      expect(fs.readFileSync(right.artifact.resolve(entry), "utf8")).toContain("42");
      await right.artifact.disposeAsync();
      expect((await collect()).removed).toEqual([descriptor.artifact.path]);
      expect(fs.readFileSync(unrelated.artifact.resolve(entry), "utf8")).toContain("99");
    } finally {
      await left.artifact.disposeAsync();
      await right.artifact.disposeAsync();
      await unrelated.artifact.disposeAsync();
    }
  });
});

it("preserves named snapshot validation failures across the worker boundary", async () => {
  await withSnapshot(async ({ stateDir, rootDir, entry, descriptor }) => {
    fs.writeFileSync(path.join(descriptor.artifact.path, "manifest.json"), "corrupt");
    let failure: unknown;
    try {
      await preparePluginGenerationArtifact({
        rootDir,
        source: entry,
        sourceSnapshot: { stateDir, descriptor },
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(PluginSourceSnapshotValidationError);
    expect(failure).toMatchObject({
      code: "PLUGIN_SOURCE_SNAPSHOT_INVALID",
      artifactPath: descriptor.artifact.path,
    });
  });
});
