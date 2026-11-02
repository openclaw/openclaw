import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as processCensus from "./openclaw-process-census.js";
import { createPackageSwapFixture } from "./package-update-swap.test-support.js";
import { captureRuntimeWorkerSource } from "./runtime-worker-generation.js";
import { stampRetainedUpdateRuntime } from "./temp-artifact-cleanup.js";
import { withRetainedUpdateRuntime } from "./update-retained-runtime.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

/** Retain a real installed package and return its retained manifest and the installed one. */
async function retain(runId?: string) {
  const base = await fs.realpath(dirs.make("retained-runtime-stamp-"));
  // The updater places its own runtime beside the install's prefix; keep that inside base.
  const { globalRoot, packageRoot } = await createPackageSwapFixture(path.join(base, "install"));
  vi.spyOn(os, "tmpdir").mockReturnValue(base);
  // No earlier runtimes exist here; the census is not what this file proves.
  vi.spyOn(processCensus, "inspectOtherOpenClawProcesses").mockReturnValue({ pids: [] });
  const installed = path.join(packageRoot, "package.json");
  const before = await fs.readFile(installed, "utf8");
  const moduleUrl = pathToFileURL(path.join(packageRoot, "dist/index.js"));
  let retained = "";
  await withRetainedUpdateRuntime(moduleUrl.href, async (retainRuntime) => {
    expect(
      await retainRuntime({
        mutationRoots: [packageRoot],
        installTarget: { manager: "npm", command: "npm", globalRoot, packageRoot },
        env: { HOME: base, OPENCLAW_STATE_DIR: path.join(base, "state") },
        timeoutMs: 30_000,
        assertCurrent() {},
        ...(runId ? { runId } : {}),
      }),
    ).toBeTruthy();
    const projected = path.resolve(
      path.dirname(fileURLToPath(captureRuntimeWorkerSource(moduleUrl).moduleUrl)),
      "..",
    );
    retained = await fs.readFile(path.join(projected, "package.json"), "utf8");
  });
  return { before, after: await fs.readFile(installed, "utf8"), retained: JSON.parse(retained) };
}

it("stamps the creating run into the retained manifest without touching the installed one", async () => {
  const runId = "00000000-0000-4000-8000-000000000123";
  const { before, after, retained } = await retain(runId);
  expect(retained).toMatchObject({ name: "openclaw", openclawUpdateRunId: runId });
  expect(after).toBe(before);
  expect(JSON.parse(after)).not.toHaveProperty("openclawUpdateRunId");
});

it("replaces a hard-linked marker instead of writing through to the installed manifest", async () => {
  const base = await fs.realpath(dirs.make("retained-runtime-link-"));
  const installed = path.join(base, "installed.json");
  const projected = path.join(base, "projection");
  await fs.mkdir(projected);
  await fs.writeFile(installed, '{"name":"openclaw","version":"1.0.0"}', { mode: 0o644 });
  await fs.link(installed, path.join(projected, "package.json"));
  await stampRetainedUpdateRuntime(projected, "run-1");
  expect(await fs.readFile(installed, "utf8")).toBe('{"name":"openclaw","version":"1.0.0"}');
  expect((await fs.stat(installed)).nlink).toBe(1);
  expect(JSON.parse(await fs.readFile(path.join(projected, "package.json"), "utf8"))).toEqual({
    name: "openclaw",
    version: "1.0.0",
    openclawUpdateRunId: "run-1",
  });
  expect(await fs.readdir(projected)).toEqual(["package.json"]);
});

it("leaves the retained manifest unstamped when no run created it", async () => {
  const { retained } = await retain();
  expect(retained).toMatchObject({ name: "openclaw" });
  expect(retained).not.toHaveProperty("openclawUpdateRunId");
});
