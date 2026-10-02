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

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.for(["filesystem", "microtask"] as const)(
  "keeps the runner event loop responsive while verifying a completed generation (%s reads)",
  async (completion, { signal }) => {
    const directory = tempDirs.make("vitest-worker-verification-");
    fs.mkdirSync(path.join(directory, "dist"));
    const manifest: VitestWorkerManifest = {
      identity: "verification-fixture",
      inputs: {},
      outputs: {},
      durationMs: 0,
    };
    const source = "export const value = 1;\n";
    const hash = hashVitestWorkerArtifact(source);
    const files = new Set<string>();
    for (let index = 0; index < 64; index++) {
      const input = path.join(directory, `input-${index}.ts`);
      const output = `output-${index}.js`;
      const outputPath = path.join(directory, "dist", output);
      fs.writeFileSync(input, source);
      fs.writeFileSync(outputPath, source);
      manifest.inputs[input] = hash;
      manifest.outputs[output] = hash;
      files.add(input);
      files.add(outputPath);
    }

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
      queueMicrotask(() => callback(null, Buffer.from(source)));
    });
    let completed = false;
    // Supply the manifest so an asynchronous manifest read alone cannot satisfy
    // the assertion: the source/artifact traversal itself must yield to I/O.
    let verification: Promise<void> | undefined;
    try {
      verification = Promise.resolve(verifyVitestWorkerArtifacts(directory, manifest)).then(() => {
        completed = true;
      });
      if (completion === "filesystem") {
        await withinTest(
          awaitGateBeforeSettlement(
            started.promise,
            verification,
            "verification bypassed async reads",
          ),
          signal,
        );
      }
      await nextTurn();
      expect(completed, "verification blocked the runner until every file was hashed").toBe(false);
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
    fs.mkdirSync(files, { recursive: true });
    const bad = path.join(files, "changed.js");
    const held = path.join(files, "held.js");
    if (damage === "changed") {
      fs.writeFileSync(bad, "changed");
    }
    fs.writeFileSync(held, "expected");
    const hash = hashVitestWorkerArtifact("expected");
    const manifest: VitestWorkerManifest = {
      identity: "drain-fixture",
      durationMs: 0,
      inputs: {},
      outputs: {},
    };
    manifest[group] = Object.fromEntries(
      [bad, held].map((filename) => [
        group === "inputs" ? filename : path.basename(filename),
        hash,
      ]),
    );
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
      await withinTest(
        awaitGateBeforeSettlement(
          Promise.all([started.promise, failedRead.promise]),
          disposal,
          "verification did not admit both reads",
        ),
        signal,
      );
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

it("rejects a byte-identical input at the compiler-time ctime cutoff", async () => {
  const directory = tempDirs.make("vitest-worker-source-change-");
  const filename = path.join(directory, "input.ts");
  const original = "export const value = 1;\n";
  fs.writeFileSync(filename, original);
  const manifest: VitestWorkerManifest = {
    identity: "source-change-fixture",
    inputs: { [filename]: hashVitestWorkerArtifact(original) },
    outputs: {},
    durationMs: 0,
  };
  fs.writeFileSync(filename, "export const value = 2;\n");
  fs.writeFileSync(filename, original);
  // Filesystem timestamps need not advance in lockstep with the wall clock.
  const inputsChangedAfter = fs.statSync(filename).ctimeMs;
  await expect(
    verifyVitestWorkerArtifacts(directory, manifest, {
      inputsChangedAfter: inputsChangedAfter + 1,
    }),
  ).resolves.toBeUndefined();
  await expect(
    verifyVitestWorkerArtifacts(directory, manifest, { inputsChangedAfter }),
  ).rejects.toThrow("Source changed during compiled subprocess invocation");
});
