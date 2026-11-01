import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { buildBackupArchivePath } from "./backup-archive-path-policy.js";
import * as processCensus from "./openclaw-process-census.js";
import { createPackageSwapFixture } from "./package-update-swap.test-support.js";
import { withRetainedUpdateRuntime } from "./update-retained-runtime.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

type CleanupReport = { lines: string[]; warnings: string[] };

function report() {
  const cleanup: CleanupReport = { lines: [], warnings: [] };
  return {
    cleanup,
    onArtifactCleanup: (result: CleanupReport) => void Object.assign(cleanup, result),
  };
}

/** A runtime left by a run that has exited, and a real updater about to retain its own. */
async function earlierRun() {
  const base = await fs.realpath(dirs.make("retained-earlier-run-"));
  const { globalRoot, packageRoot } = await createPackageSwapFixture(base);
  vi.spyOn(os, "tmpdir").mockReturnValue(base);
  vi.spyOn(processCensus, "inspectOtherOpenClawProcesses").mockReturnValue({ pids: [] });
  const earlier = path.join(base, "openclaw-update-runtime-Prior1");
  await fs.mkdir(earlier);
  await fs.writeFile(
    path.join(earlier, ".openclaw-update-owner.json"),
    JSON.stringify({ pid: 2 ** 22 + 11, startTime: 1 }),
  );
  return {
    earlier,
    moduleUrl: pathToFileURL(path.join(packageRoot, "dist/index.js")).href,
    options: {
      mutationRoots: [packageRoot],
      installTarget: { manager: "npm" as const, command: "npm", globalRoot, packageRoot },
      timeoutMs: 30_000,
      assertCurrent() {},
    },
  };
}

it("reclaims an earlier run's runtime before retaining this one", async () => {
  const { earlier, moduleUrl, options } = await earlierRun();
  const { cleanup, onArtifactCleanup } = report();
  await withRetainedUpdateRuntime(moduleUrl, async (retain) => {
    expect(await retain({ ...options, onArtifactCleanup })).toBeTruthy();
  });
  expect(cleanup.lines).toContain(`Removed abandoned updater runtime: ${earlier}`);
  expect(cleanup.warnings).toEqual([]);
  await expect(fs.lstat(earlier)).rejects.toMatchObject({ code: "ENOENT" });
});

it("reclaims only this state directory's old unrecorded database snapshots", async () => {
  const { moduleUrl, options } = await earlierRun();
  const artifacts = path.join(options.mutationRoots[0]!, ".artifacts");
  const stateDir = path.join(path.dirname(artifacts), "private-state");
  const otherStateDir = path.join(path.dirname(artifacts), "other-state");
  // The layout capture writes: each source database under its encoded absolute path.
  async function snapshot(id: string, owner: string, ageDays: number) {
    const directory = path.join(
      artifacts,
      `dist-runtime.openclaw-update-${id}-0000-4000-8000-000000000000.tmp.databases`,
    );
    const copy = path.join(
      directory,
      buildBackupArchivePath("", path.join(owner, "state", "openclaw.sqlite")),
    );
    await fs.mkdir(path.dirname(copy), { recursive: true });
    await fs.writeFile(copy, "pre-migration");
    const modified = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000);
    await fs.utimes(directory, modified, modified);
    return { directory, copy };
  }
  const old = await snapshot("0000aaaa", stateDir, 8);
  const recent = await snapshot("0000bbbb", stateDir, 1);
  const foreign = await snapshot("0000cccc", otherStateDir, 30);
  const { cleanup, onArtifactCleanup } = report();
  await withRetainedUpdateRuntime(moduleUrl, async (retain) => {
    await retain({ ...options, env: { OPENCLAW_STATE_DIR: stateDir }, onArtifactCleanup });
  });
  expect(cleanup.lines).toContain(`Removed abandoned update database snapshot: ${old.directory}`);
  await expect(fs.lstat(old.directory)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await fs.readFile(recent.copy, "utf8")).toBe("pre-migration");
  // Another state directory's history decides this copy, and it is not readable from here.
  expect(await fs.readFile(foreign.copy, "utf8")).toBe("pre-migration");
  expect(cleanup.lines).toContainEqual(
    expect.stringContaining(`${foreign.directory}: no update run in this state directory`),
  );
});

it("reports a failed cleanup of an earlier run's runtime and continues the update", async () => {
  const { earlier, moduleUrl, options } = await earlierRun();
  const actualRm = fs.rm;
  vi.spyOn(fs, "rm").mockImplementation(async (target, rmOptions) => {
    if (String(target).startsWith(earlier)) {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    }
    await actualRm(target, rmOptions);
  });
  const { cleanup, onArtifactCleanup } = report();
  const outcome = await withRetainedUpdateRuntime(moduleUrl, async (retain) => {
    expect(await retain({ ...options, onArtifactCleanup })).toBeTruthy();
    return "update continued";
  });
  expect(outcome).toBe("update continued");
  expect(cleanup.warnings).toEqual([expect.stringContaining(`${earlier}: cleanup failed: denied`)]);
});

it("continues the update when the sweep itself throws", async () => {
  const { moduleUrl, options } = await earlierRun();
  vi.spyOn(os, "tmpdir").mockImplementationOnce(() => {
    throw new Error("fixture sweep failure");
  });
  const { cleanup, onArtifactCleanup } = report();
  const outcome = await withRetainedUpdateRuntime(moduleUrl, async (retain) => {
    expect(await retain({ ...options, onArtifactCleanup })).toBeTruthy();
    return "update continued";
  });
  expect(outcome).toBe("update continued");
  expect(cleanup.warnings).toEqual([
    "Could not clean up earlier update artifacts: fixture sweep failure",
  ]);
});
