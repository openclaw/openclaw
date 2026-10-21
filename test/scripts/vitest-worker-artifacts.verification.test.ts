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
const source = "expected";

function generation(directory: string, groups: Partial<Record<Group, string[]>>) {
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

function controlledReads(held: string, options: { synthetic?: Set<string>; failed?: string } = {}) {
  const started = createDeferred(),
    release = createDeferred(),
    failedRead = createDeferred();
  const observedReads: string[] = [];
  const readFile = fs.readFile.bind(fs);
  const reader = vi.spyOn(fs, "readFile").mockImplementation((...args) => {
    const [filename, callback] = args;
    const synthetic = typeof filename === "string" && options.synthetic?.has(filename);
    if (synthetic) {
      observedReads.push(filename);
    }
    const deliver = () => (synthetic ? callback(null, Buffer.from(source)) : readFile(...args));
    if (filename === held) {
      started.resolve();
      void release.promise.then(deliver);
    } else if (filename === options.failed) {
      readFile(filename, (error, bytes) => {
        callback(error, bytes);
        failedRead.resolve();
      });
    } else if (synthetic) {
      queueMicrotask(deliver);
    } else {
      readFile(...args);
    }
  });
  return { started, release, failedRead, observedReads, reader };
}

it.for(["filesystem", "microtask"] as const)(
  "keeps the runner event loop responsive while verifying a completed generation (%s reads)",
  async (completion, { signal }) => {
    const directory = tempDirs.make("vitest-worker-verification-");
    const names = Array.from({ length: 64 }, (_, i) => `${i}.js`);
    const manifest = generation(directory, { inputs: names, outputs: names });
    const files = new Set([
      ...Object.keys(manifest.inputs),
      ...Object.keys(manifest.outputs).map((name) => path.join(directory, "dist", name)),
    ]);

    const { started, release, observedReads, reader } = controlledReads(
      path.join(directory, "0.js"),
      {
        synthetic: completion === "microtask" ? files : undefined,
      },
    );
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
    const manifest = generation(directory, { [group]: ["changed.js", "held.js"] });
    if (damage === "changed") {
      fs.writeFileSync(bad, "changed");
    } else {
      fs.unlinkSync(bad);
    }
    fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify(manifest));
    const { started, failedRead, release, reader } = controlledReads(held, { failed: bad });
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
