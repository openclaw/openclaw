import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeDefaultRetainedNativeWorkerSource } from "../infra/worker-native-lifecycle.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { withPluginGenerationSourceCustody } from "./plugin-generation-source-lookup.js";
import {
  preparePluginGenerationArtifact,
  preparePluginSourceSnapshot,
} from "./plugin-generation-worker.js";
import { bindPluginInstanceModuleLoader } from "./plugin-instance-module-loader.js";
import { PluginInstance } from "./plugin-instance.js";
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
  shared?: true,
) {
  const stateDir = fs.realpathSync(temp.make("plugin-worker-snapshot-"));
  const rootDir = path.join(stateDir, "source");
  fs.mkdirSync(rootDir);
  const entry = path.join(rootDir, "index.js");
  fs.writeFileSync(path.join(rootDir, "package.json"), '{"name":"fixture","type":"module"}');
  fs.writeFileSync(
    entry,
    "export const value = 42; let count = 0; export function increment() { return ++count; }",
  );
  await withPluginSourceCaptureStorage({ stateDir, placement: "temporary" }, async () => {
    const snapshot = await preparePluginSourceSnapshot({ stateDir, rootDir, shared });
    let descriptor: PluginSourceSnapshotDescriptor | undefined;
    try {
      descriptor = {
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
      await closeDefaultRetainedNativeWorkerSource();
      if (descriptor) {
        await collectPluginSourceSnapshots({
          stateDir,
          retainedPaths: new Set(),
          retiredSnapshots: [descriptor],
          assertCurrent() {},
        });
      }
    }
  });
}

it("prepares independent runtime instances from worker-published immutable source", async () => {
  await withSnapshot(async (fixture) => {
    await withPluginGenerationSourceCustody(async () => {
      const { stateDir, rootDir, entry, descriptor } = fixture;
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
          "export const value = 42; let count = 0; export function increment() { return ++count; }",
        );
        expect(fs.readFileSync(right.artifact.resolve(entry), "utf8")).toBe(
          "export const value = 42; let count = 0; export function increment() { return ++count; }",
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
});

it("retains one shared source through worker custody with separate module counters", async () => {
  await withSnapshot(async ({ stateDir, rootDir, entry, descriptor }) => {
    await withPluginGenerationSourceCustody(async () => {
      const instances: PluginInstance[] = [];
      const prepared: Awaited<ReturnType<typeof preparePluginGenerationArtifact>>[] = [];
      try {
        for (let index = 0; index < 2; index++) {
          const artifact = await preparePluginGenerationArtifact({
            rootDir,
            source: entry,
            sourceSnapshot: { stateDir, descriptor, shared: true },
          });
          prepared.push(artifact);
          const instance = new PluginInstance(`shared-${index}`);
          instances.push(instance);
          withPluginCache(createPluginCache(), () =>
            bindPluginInstanceModuleLoader({
              instance,
              origin: "global",
              source: entry,
              rootDir,
              preparedArtifact: artifact,
            }),
          );
        }
        expect(prepared[0]!.artifact.rootDir).toBe(prepared[1]!.artifact.rootDir);
        const left = instances[0]!.loadModule(entry) as { increment(): number };
        const right = instances[1]!.loadModule(entry) as { increment(): number };
        expect([left.increment(), left.increment(), right.increment()]).toEqual([1, 2, 1]);
        expect((await prepared[0]!.startScrub!(async () => {})).status).toBe("passed");
      } finally {
        for (const instance of instances) {
          await instance.dispose();
        }
        for (const artifact of prepared) {
          await artifact.artifact.disposeAsync();
        }
      }
    });
  }, true);
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
