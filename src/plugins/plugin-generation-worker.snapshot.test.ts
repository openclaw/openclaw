import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { NativeWorker } from "../infra/worker-native-handle.js";
import { closeDefaultRetainedNativeWorkerSource } from "../infra/worker-native-lifecycle.js";
import { withPluginGenerationSourceCustody } from "./plugin-generation-source-lookup.js";
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
afterEach(() => vi.restoreAllMocks());

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
        const custody = left.artifact.retainSourceCustody();
        try {
          expect(custody.files.size).toBeGreaterThan(0);
          expect(custody.source.frozenSource).toBeDefined();
          expect(fs.readFileSync(custody.source.resolve(entry), "utf8")).toContain("42");
        } finally {
          await custody.source.disposeAsync();
        }
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

it.each(["capture failure", "frozen receipt mismatch"] as const)(
  "awaits retained cleanup without synchronous worker waits after %s",
  async (failure) => {
    await withSnapshot(async ({ stateDir, rootDir, entry, descriptor }) => {
      const readDirectory = fs.readdirSync;
      const captureError = new Error("Host reconstruction cannot read source");
      // Workers keep the real filesystem view. Only host reconstruction fails or
      // misses a file, exercising both cleanup owners after custody transfers.
      const read = vi.spyOn(fs, "readdirSync").mockImplementation((...args) => {
        const entries = readDirectory(...args);
        if (entries.some((name) => typeof name === "string" && name === "index.js")) {
          if (failure === "capture failure") {
            throw captureError;
          }
          return entries.filter((name) => typeof name !== "string" || name !== "index.js");
        }
        return entries;
      });
      const posts = vi.spyOn(NativeWorker.prototype, "postMessage");
      const wait = vi.spyOn(Atomics, "wait");
      try {
        await expect(
          preparePluginGenerationArtifact({
            rootDir,
            source: entry,
            ...(failure === "frozen receipt mismatch"
              ? { sourceSnapshot: { stateDir, descriptor } }
              : {}),
          }),
        ).rejects.toThrow(
          failure === "capture failure"
            ? captureError
            : "Plugin snapshot runtime receipt differs from its immutable source receipt",
        );
        const captures = posts.mock.calls.flatMap(([message]) =>
          isRecord(message) &&
          isRecord(message.input) &&
          message.input.operation === "capture" &&
          typeof message.input.scratch === "string"
            ? [message.input.scratch]
            : [],
        );
        expect(captures).toHaveLength(1);
        expect.soft(wait).not.toHaveBeenCalled();
        expect(captures.every((directory) => !fs.existsSync(directory))).toBe(true);
      } finally {
        read.mockRestore();
        wait.mockRestore();
        posts.mockRestore();
      }
    });
  },
);

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
