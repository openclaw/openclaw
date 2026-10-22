import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { resolveRepoRoot } from "../../scripts/lib/repo-root.mjs";
import { spawnOwnedVitestProcess } from "../../scripts/lib/vitest-process.mts";
import { writeShardTimings } from "../../scripts/lib/vitest-shard-timings.mts";
import { hashVitestWorkerArtifact } from "../../scripts/lib/vitest-worker-artifacts.mts";
import { retainVitestWorkerArtifacts } from "../../scripts/lib/vitest-worker-cache.mts";
import { readActualWorkspaceManifestImpl } from "../../src/gateway/worker-environments/workspace-actual-manifest.js";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const roots = useAutoCleanupTempDirTracker(afterEach);

it("keeps actual test producer caches out of workspace capture", async () => {
  const root = roots.make("workspace-test-caches-");
  const worker = path.join(root, ".artifacts/vitest-workers/run-cache-0");
  const buildInfo = "{}\n";
  await fs.writeFile(path.join(root, "package.json"), '{"type":"module"}\n');
  await fs.mkdir(path.join(worker, "dist"), { recursive: true });
  await fs.writeFile(path.join(worker, "dist/build-info.json"), buildInfo);
  const manifest = {
    identity: "fixture",
    inputs: {},
    outputs: { "build-info.json": hashVitestWorkerArtifact(buildInfo) },
    durationMs: 1,
    cacheSignature: "fixture",
  };
  await fs.writeFile(path.join(worker, "manifest.json"), JSON.stringify(manifest));
  expect(await retainVitestWorkerArtifacts(root, worker, manifest)).toBe(true);

  const { child, completion } = spawnOwnedVitestProcess({
    command: resolveTestNodeExecPath(),
    args: [
      "-e",
      "process.stdout.write(JSON.stringify(process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH))",
    ],
    homeMode: "hermetic",
    options: {
      env: { TMPDIR: roots.make("workspace-test-process-") },
      stdio: ["ignore", "pipe", "pipe"],
    },
  });
  let output = "";
  child.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
    output += chunk;
  });
  child.stderr!.resume();
  expect((await completion).code).toBe(0);
  const bunCache = path.relative(resolveRepoRoot(import.meta.url), JSON.parse(output));
  expect(bunCache.startsWith("..")).toBe(false);
  expect(path.isAbsolute(bunCache)).toBe(false);
  await fs.mkdir(path.join(root, bunCache), { recursive: true });
  await fs.writeFile(path.join(root, bunCache, "compiled.pile"), "compiled cache");

  writeShardTimings(
    [
      {
        baseConfig: "test.config.ts",
        config: "test.config.ts",
        durationMs: 10,
        includePatternCount: 1,
      },
    ],
    root,
    {},
  );
  await fs.writeFile(path.join(root, ".artifacts/report.md"), "guest report\n");
  const captured = await readActualWorkspaceManifestImpl({ root, baseCommit: null });
  expect(captured.manifest.entries.map((entry) => entry.path)).toEqual([
    ".artifacts/report.md",
    "package.json",
  ]);
});
