import fs from "node:fs";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import {
  hashVitestWorkerArtifact,
  verifyVitestWorkerArtifacts,
  type VitestWorkerManifest,
} from "../../scripts/lib/vitest-worker-artifacts.mts";
import { createVitestWorkerRun } from "../../scripts/lib/vitest-worker-run.mts";
import { awaitGateBeforeSettlement, createDeferred, withinTest } from "../helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { writeFixture } from "./vitest-worker-artifacts.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
type Group = "inputs" | "outputs";

function generation(directory: string, groups: Partial<Record<Group, string[]>>, source: string) {
  const hash = hashVitestWorkerArtifact(source);
  const manifest: VitestWorkerManifest = {
    identity: "fixture",
    inputs: {},
    outputs: {},
    durationMs: 0,
  };
  for (const group of ["inputs", "outputs"] as const) {
    for (const name of groups[group] ?? []) {
      const parent = group === "inputs" ? directory : path.join(directory, "dist");
      const filename = writeFixture(parent, name, source);
      manifest[group][group === "inputs" ? filename : name] = hash;
    }
  }
  return manifest;
}

it.for(["filesystem", "microtask"] as const)(
  "keeps the runner event loop responsive while verifying a completed generation (%s reads)",
  async (completion, { signal }) => {
    const directory = tempDirs.make("vitest-worker-verification-");
    const source = "export const value = 1;\n";
    const manifest = generation(
      directory,
      {
        inputs: Array.from({ length: 64 }, (_, i) => `input-${i}.ts`),
        outputs: Array.from({ length: 64 }, (_, i) => `output-${i}.js`),
      },
      source,
    );
    const files = new Set([
      ...Object.keys(manifest.inputs),
      ...Object.keys(manifest.outputs).map((name) => path.join(directory, "dist", name)),
    ]);

    const held = path.join(directory, "input-0.ts");
    const started = createDeferred();
    const release = createDeferred();
    const observedReads: string[] = [];
    const readFile = fs.readFile.bind(fs);
    const reader = vi.spyOn(fs, "readFile").mockImplementation((...args) => {
      const [filename, callback] = args;
      if (completion === "filesystem") {
        if (filename === held) {
          started.resolve();
          void release.promise.then(() => readFile(...args));
          return;
        }
        return readFile(...args);
      }
      if (typeof filename !== "string" || !files.has(filename)) {
        return readFile(...args);
      }
      observedReads.push(filename);
      if (filename === held) {
        void release.promise.then(() => callback(null, Buffer.from(source)));
      } else {
        queueMicrotask(() => callback(null, Buffer.from(source)));
      }
    });
    let completed = false;
    // Supplying the manifest means the artifact reads themselves must yield.
    let verification: Promise<void> | undefined;
    try {
      verification = Promise.resolve(verifyVitestWorkerArtifacts(directory, manifest)).then(() => {
        completed = true;
      });
      if (completion === "filesystem") {
        await withinTest(
          awaitGateBeforeSettlement(started.promise, verification, "reads bypassed"),
          signal,
        );
      }
      await nextTurn();
      expect(completed, "verification blocked the runner until every file was hashed").toBe(false);
      if (completion === "microtask") {
        expect(observedReads, "one slow input must not stall unrelated input reads").toHaveLength(
          64,
        );
      }
    } finally {
      release.resolve();
      try {
        await verification;
      } finally {
        reader.mockRestore();
      }
    }
    if (completion === "microtask") {
      expect(observedReads.toSorted()).toEqual([...files].toSorted());
    }
  },
);

it.for([
  { group: "inputs", damage: "changed" },
  { group: "outputs", damage: "changed" },
  { group: "inputs", damage: "missing" },
  { group: "outputs", damage: "missing" },
] as const)(
  "drains active $group reads before $damage verification releases the generation",
  async ({ group, damage }, { signal }) => {
    const owner = createVitestWorkerRun();
    const directory = owner.descriptor.directory;
    const files = group === "inputs" ? directory : path.join(directory, "dist");
    const bad = path.join(files, "changed.js");
    const held = path.join(files, "held.js");
    const manifest = generation(directory, { [group]: ["changed.js", "held.js"] }, "expected");
    if (damage === "changed") {
      fs.writeFileSync(bad, "changed");
    } else {
      fs.unlinkSync(bad);
    }
    fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify(manifest));
    const started = createDeferred();
    const failedRead = createDeferred();
    const release = createDeferred();
    const readFile = fs.readFile.bind(fs);
    const reader = vi.spyOn(fs, "readFile").mockImplementation((...args) => {
      const [filename, callback] = args;
      if (filename === held) {
        started.resolve();
        void release.promise.then(() => readFile(...args));
        return;
      }
      if (filename !== bad) {
        return readFile(...args);
      }
      readFile(filename, (error, bytes) => {
        callback(error, bytes);
        failedRead.resolve();
      });
    });
    let completed = false;
    let failure: unknown;
    const disposal = owner
      .dispose()
      .catch((error: unknown) => {
        failure = error;
      })
      .finally(() => {
        completed = true;
      });
    try {
      const admitted = Promise.all([started.promise, failedRead.promise]);
      await withinTest(awaitGateBeforeSettlement(admitted, disposal, "reads not admitted"), signal);
      await nextTurn();
      expect(completed).toBe(false);
      expect(fs.readFileSync(held, "utf8")).toBe("expected");
    } finally {
      release.resolve();
      await disposal;
      reader.mockRestore();
    }
    const diagnostic =
      group === "inputs"
        ? "Source changed during compiled subprocess invocation"
        : "Compiled subprocess artifact changed";
    if (damage === "missing") {
      expect(failure).toMatchObject({ code: "ENOENT" });
    } else {
      expect(failure).toMatchObject({ message: expect.stringContaining(diagnostic) });
    }
    expect(fs.existsSync(directory)).toBe(false);
  },
);
