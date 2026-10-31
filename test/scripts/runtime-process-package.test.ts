import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { collectNpmPackInventory } from "../../scripts/lib/npm-pack-inventory.mts";
import { runtimeProcessCoreEntrypoints } from "../../scripts/lib/runtime-process-core-build-entries.mts";
import { WORKER_BUNDLE_ARTIFACT_PATHS } from "../../src/shared/worker-bundle-hash.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("packs every core runtime process without exposing the portable worker graph", () => {
  const root = tempDirs.make("runtime-process-package-");
  const { files } = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { files: string[] };
  const runtimePaths = runtimeProcessCoreEntrypoints.map((entry) => `dist/${entry.distWorkerPath}`);
  const archivePath = `dist/worker-artifacts/${"a".repeat(64)}.tar.gz`;
  // Only the file-selection boundary is under test; no build or lifecycle scripts run.
  const fixturePaths = [
    ...runtimePaths,
    ...WORKER_BUNDLE_ARTIFACT_PATHS.map((entry) => `dist/worker/${entry}`),
    "dist/worker/worker-chunk-fixture.mjs",
    archivePath,
  ];
  for (const file of fixturePaths) {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, "export {};\n");
  }
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "runtime-process-package-fixture", version: "1.0.0", files }),
  );

  const inventory = collectNpmPackInventory(root, { timeoutMs: 10_000 });
  const packed = new Set(inventory.files);
  expect(runtimePaths.filter((file) => !packed.has(file))).toEqual([]);
  expect(packed.has(archivePath)).toBe(true);
  expect(inventory.files.filter((file) => file.startsWith("dist/worker/"))).toEqual([]);
});
