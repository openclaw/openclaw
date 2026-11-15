import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { sqliteDatabaseAdmissionState } from "../infra/sqlite-database-admission-context.js";
import { readSqliteDatabaseAdmissionIdentity } from "../infra/sqlite-database-admission-record.js";
import { NativeWorker } from "../infra/worker-native-handle.js";
import { closeDefaultRetainedNativeWorkerSource } from "../infra/worker-native-lifecycle.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withPluginGenerationSourceCustody } from "./plugin-generation-source-lookup.js";
import {
  preparePluginGenerationArtifact,
  preparePluginSourceSnapshot,
} from "./plugin-generation-worker.js";
import { PluginSnapshotDependencyError } from "./plugin-snapshot-dependency-error.js";
import { withPluginSourceCaptureStorage } from "./plugin-source-capture-context.js";
import { collectPluginSourceSnapshots } from "./plugin-source-snapshot-artifact.js";
import { PluginSourceSnapshotValidationError } from "./plugin-source-snapshot-payload.js";
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
});

it.each(["manifest", "directory", "token"] as const)(
  "preserves named snapshot validation failures for a damaged %s",
  async (damage) => {
    await withSnapshot(async ({ stateDir, rootDir, entry, descriptor }) => {
      if (damage === "manifest") {
        fs.writeFileSync(path.join(descriptor.artifact.path, "manifest.json"), "corrupt");
      } else {
        fs.rmSync(
          damage === "directory"
            ? descriptor.artifact.path
            : path.join(descriptor.artifact.path, "owner.sqlite"),
          { recursive: true },
        );
      }
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
  },
);

it("keeps the worker available while concurrent snapshot descriptors prepare", async () => {
  await withSnapshot(async ({ stateDir, rootDir, entry, descriptor }) => {
    using posts = vi.spyOn(NativeWorker.prototype, "postMessage");
    const ordinary = await preparePluginGenerationArtifact({ rootDir, source: entry });
    const location = path.join(descriptor.artifact.path, "owner.sqlite");
    const identity = readSqliteDatabaseAdmissionIdentity(fs.statSync(location, { bigint: true }));
    expect(sqliteDatabaseAdmissionState.registry.descriptors.has(identity)).toBe(false);
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const open = fs.open;
    let opens = 0;
    using opening = vi.spyOn(fs, "open").mockImplementation((...args) => {
      if (args[0] !== location) {
        return Reflect.apply(open, fs, args);
      }
      opens++;
      entered.resolve();
      void release.promise.then(() => Reflect.apply(open, fs, args));
    });
    void opening;
    const preparing = Promise.allSettled(
      [0, 1].map(() =>
        preparePluginGenerationArtifact({
          rootDir,
          source: entry,
          sourceSnapshot: { stateDir, descriptor },
        }),
      ),
    );
    try {
      expect(
        await Promise.race([entered.promise.then(() => "held"), preparing.then(() => "settled")]),
      ).toBe("held");
      // This snapshot must not occupy the sole worker while its host filesystem is held.
      expect(
        posts.mock.calls.some(
          ([message]) =>
            isRecord(message) &&
            isRecord(message.input) &&
            message.input.sourceSnapshot !== undefined,
        ),
      ).toBe(false);
      ordinary.artifact.prepareModule(ordinary.artifact.resolve(entry));
      release.resolve();
      const results = await preparing;
      expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
      expect(opens).toBe(1);
      for (const result of results) {
        if (result.status === "fulfilled") {
          expect(fs.readFileSync(result.value.artifact.resolve(entry), "utf8")).toContain("42");
        }
      }
      const workers = posts.mock.calls.flatMap(([message], index) =>
        isRecord(message) && isRecord(message.input) ? [posts.mock.contexts[index]] : [],
      );
      expect(new Set(workers).size).toBe(1);
    } finally {
      release.resolve();
      for (const result of await preparing) {
        if (result.status === "fulfilled") {
          await result.value.artifact.disposeAsync();
        }
      }
      await ordinary.artifact.disposeAsync();
    }
  });
});

it.each(["open", "fstat", "seal"] as const)(
  "joins held snapshot %s preparation when its original owner retires",
  async (phase) => {
    await withSnapshot(async ({ stateDir, rootDir, entry, descriptor }) => {
      const location = path.join(descriptor.artifact.path, "owner.sqlite");
      const identity = readSqliteDatabaseAdmissionIdentity(fs.statSync(location, { bigint: true }));
      const bytes = fs.readFileSync(location);
      const entered = createDeferredCore();
      const release = createDeferredCore();
      let opened: number | undefined;
      const open = fs.open;
      const fstat = fs.fstat;
      const lstat = fs.promises.lstat;
      using opening = vi.spyOn(fs, "open").mockImplementation((...args) => {
        if (args[0] !== location) {
          return Reflect.apply(open, fs, args);
        }
        const callback = args.at(-1);
        if (typeof callback !== "function") {
          throw new Error("Expected the real filesystem open callback");
        }
        const run = () =>
          Reflect.apply(open, fs, [
            ...args.slice(0, -1),
            (error: NodeJS.ErrnoException | null, fd: number) => {
              if (!error) {
                opened = fd;
              }
              Reflect.apply(callback, undefined, [error, fd]);
            },
          ]);
        if (phase === "open") {
          entered.resolve();
          void release.promise.then(run);
        } else {
          run();
        }
      });
      using checking = vi.spyOn(fs, "fstat").mockImplementation((...args) => {
        if (phase === "fstat" && args[0] === opened) {
          entered.resolve();
          void release.promise.then(() => Reflect.apply(fstat, fs, args));
          return;
        }
        return Reflect.apply(fstat, fs, args);
      });
      using reading = vi.spyOn(fs.promises, "lstat").mockImplementation((...args) => {
        if (phase === "seal" && args[0] === `${location}.seal`) {
          entered.resolve();
          return release.promise.then(() => Reflect.apply(lstat, fs.promises, args));
        }
        return Reflect.apply(lstat, fs.promises, args);
      });
      void opening;
      void checking;
      void reading;
      const preparing = preparePluginGenerationArtifact({
        rootDir,
        source: entry,
        sourceSnapshot: { stateDir, descriptor },
      }).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      let closing: Promise<void> | undefined;
      try {
        expect(
          await Promise.race([entered.promise.then(() => "held"), preparing.then(() => "settled")]),
        ).toBe("held");
        closing = closeDefaultRetainedNativeWorkerSource();
        release.resolve();
        const result = await preparing;
        expect("error" in result && result.error).toMatchObject({
          message: "Plugin preparation worker has closed",
        });
        await closing;
        expect(opened).toBeDefined();
        if (opened === undefined) {
          throw new Error("The held open did not complete");
        }
        let current: fs.BigIntStats | undefined;
        try {
          current = fs.fstatSync(opened, { bigint: true });
        } catch (error) {
          expect(error).toMatchObject({ code: "EBADF" });
        }
        if (current) {
          expect(readSqliteDatabaseAdmissionIdentity(current)).not.toBe(identity);
        }
        expect(sqliteDatabaseAdmissionState.registry.descriptors.has(identity)).toBe(false);
        expect(fs.readFileSync(location)).toEqual(bytes);
      } finally {
        release.resolve();
        const result = await preparing;
        if ("value" in result) {
          await result.value.artifact.disposeAsync();
        }
        await closing;
      }
    });
  },
);
