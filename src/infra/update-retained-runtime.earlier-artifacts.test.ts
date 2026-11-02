import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { buildBackupArchivePath } from "./backup-archive-path-policy.js";
import * as processCensus from "./openclaw-process-census.js";
import { createPackageSwapFixture } from "./package-update-swap.test-support.js";
import { withRetainedUpdateRuntime } from "./update-retained-runtime.js";
import {
  createUpdateRun,
  finishUpdateRun,
  recordUpdateRunPhase,
  recordUpdateRunStep,
} from "./update-run-ledger.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
});

const DAY_MS = 24 * 60 * 60 * 1000;
type CleanupReport = { lines: string[]; warnings: string[] };

function report() {
  const cleanup: CleanupReport = { lines: [], warnings: [] };
  return {
    cleanup,
    onArtifactCleanup: (result: CleanupReport) => void Object.assign(cleanup, result),
  };
}

async function age(directory: string, days: number) {
  const modified = new Date(Date.now() - days * DAY_MS);
  await fs.utimes(directory, modified, modified);
}

/**
 * A real updater about to retain its own runtime, beside a runtime an earlier updater left two
 * days ago. The projected package marks it, as for runtimes current main leaves.
 */
async function earlierRun() {
  const base = await fs.realpath(dirs.make("retained-earlier-run-"));
  // The updater places its own runtime beside the install's prefix; keep that inside base.
  const { globalRoot, packageRoot } = await createPackageSwapFixture(path.join(base, "install"));
  vi.spyOn(os, "tmpdir").mockReturnValue(base);
  vi.spyOn(processCensus, "inspectOtherOpenClawProcesses").mockReturnValue({ pids: [] });
  const earlier = path.join(base, "openclaw-update-runtime-Prior1");
  const root = path.parse(packageRoot).root;
  const projected = path.join(
    earlier,
    "tree",
    Buffer.from(root).toString("hex"),
    path.relative(root, packageRoot),
  );
  await fs.mkdir(projected, { recursive: true });
  await fs.copyFile(path.join(packageRoot, "package.json"), path.join(projected, "package.json"));
  await age(earlier, 2);
  const stateDir = path.join(base, "state");
  return {
    base,
    earlier,
    // Its own home and state directory: the ledger redacts paths under both.
    env: { HOME: base, OPENCLAW_STATE_DIR: stateDir },
    stateDir,
    artifacts: path.join(packageRoot, ".artifacts"),
    moduleUrl: pathToFileURL(path.join(packageRoot, "dist/index.js")).href,
    options: {
      mutationRoots: [packageRoot],
      installTarget: { manager: "npm" as const, command: "npm", globalRoot, packageRoot },
      timeoutMs: 30_000,
      assertCurrent() {},
    },
  };
}

/** The layout capture writes: each source database under its encoded absolute path. */
async function snapshot(artifacts: string, id: string, stateDir: string, ageDays: number) {
  const directory = path.join(
    artifacts,
    `dist-runtime.openclaw-update-${id}-0000-4000-8000-000000000000.tmp.databases`,
  );
  const copy = path.join(
    directory,
    buildBackupArchivePath("", path.join(stateDir, "state", "openclaw.sqlite")),
  );
  await fs.mkdir(path.dirname(copy), { recursive: true });
  await fs.writeFile(copy, "pre-migration");
  await age(directory, ageDays);
  return { directory, copy };
}

type Env = { HOME: string; OPENCLAW_STATE_DIR: string };

/** A run written through the real ledger, as the update command writes it. */
function recordRun(
  env: Env,
  status: "succeeded" | "failed" | "skipped",
  details: { step: string; detail: string }[] = [],
) {
  const options = { env };
  const run = createUpdateRun({ trigger: "cli" }, options);
  recordUpdateRunPhase(run.runId, "activating", {}, options);
  for (const { step, detail } of details) {
    recordUpdateRunStep(run.runId, { step, status: "completed", detail }, options);
  }
  finishUpdateRun(
    run.runId,
    { status, ...(status === "succeeded" ? {} : { reason: "fixture" }) },
    options,
  );
  return run.runId;
}

const captureReceipt = (directory: string) => ({
  step: "diagnostic:database snapshot",
  detail: `Databases snapshotted at ${directory}. Verified successful activation removes these snapshots only if automatic restoration remains available; otherwise retain them with the update's recovery artifacts.`,
});

async function sweep(fixture: Awaited<ReturnType<typeof earlierRun>>) {
  const { cleanup, onArtifactCleanup } = report();
  await withRetainedUpdateRuntime(fixture.moduleUrl, async (retain) => {
    await retain({ ...fixture.options, env: fixture.env, onArtifactCleanup });
  });
  return cleanup;
}

it("reclaims an earlier run's runtime that nothing uses, before retaining this one", async () => {
  const fixture = await earlierRun();
  const cleanup = await sweep(fixture);
  expect(cleanup.lines).toContain(`Removed abandoned updater runtime: ${fixture.earlier}`);
  expect(cleanup.warnings).toEqual([]);
  await expect(fs.lstat(fixture.earlier)).rejects.toMatchObject({ code: "ENOENT" });
});

it("keeps a recent earlier runtime, since another update may still be running", async () => {
  const fixture = await earlierRun();
  await age(fixture.earlier, 0);
  const cleanup = await sweep(fixture);
  expect(cleanup.lines).toContain(
    `Runtime retained at ${fixture.earlier}: no process uses it, but the update that made it may still be running; keeping it until it is 24 hours old`,
  );
  expect(cleanup.warnings).toEqual([]);
  await expect(fs.lstat(fixture.earlier)).resolves.toBeDefined();
});

it("keeps a failed run's snapshot after more than a page of newer unsuccessful runs", async () => {
  const fixture = await earlierRun();
  const kept = await snapshot(fixture.artifacts, "0000aaaa", fixture.stateDir, 30);
  const failed = recordRun(fixture.env, "failed", [captureReceipt(kept.directory)]);
  // A later skipped run that only reported this snapshot must not be read as its capture.
  recordRun(fixture.env, "skipped", [
    {
      step: "diagnostic:updater-runtime-retention",
      detail: `Update database snapshot retained at ${kept.directory}: fixture`,
    },
  ]);
  for (let index = 0; index < 20; index++) {
    recordRun(fixture.env, index % 2 ? "failed" : "skipped");
  }
  const cleanup = await sweep(fixture);
  expect(await fs.readFile(kept.copy, "utf8")).toBe("pre-migration");
  expect(cleanup.lines).toContainEqual(
    expect.stringContaining(`${kept.directory}: recovery from update run ${failed} may need it`),
  );
});

it("reclaims a failed run's snapshot once a later update succeeded and the window ended", async () => {
  const fixture = await earlierRun();
  const superseded = await snapshot(fixture.artifacts, "0000bbbb", fixture.stateDir, 30);
  vi.useFakeTimers({ toFake: ["Date"], now: Date.now() - 10 * DAY_MS });
  recordRun(fixture.env, "failed", [captureReceipt(superseded.directory)]);
  vi.setSystemTime(Date.now() + DAY_MS);
  recordRun(fixture.env, "succeeded");
  vi.useRealTimers();
  for (let index = 0; index < 21; index++) {
    recordRun(fixture.env, "skipped");
  }
  const cleanup = await sweep(fixture);
  expect(cleanup.lines).toContain(
    `Removed abandoned update database snapshot: ${superseded.directory}`,
  );
  await expect(fs.lstat(superseded.directory)).rejects.toMatchObject({ code: "ENOENT" });
});

it("reclaims only this state directory's old unrecorded database snapshots", async () => {
  const fixture = await earlierRun();
  // History exists and was searched in full; none of these copies appears in it.
  recordRun(fixture.env, "succeeded");
  const old = await snapshot(fixture.artifacts, "0000cccc", fixture.stateDir, 8);
  const recent = await snapshot(fixture.artifacts, "0000dddd", fixture.stateDir, 1);
  const foreign = await snapshot(
    fixture.artifacts,
    "0000eeee",
    path.join(fixture.base, "other-state"),
    30,
  );
  const cleanup = await sweep(fixture);
  expect(cleanup.lines).toContain(`Removed abandoned update database snapshot: ${old.directory}`);
  await expect(fs.lstat(old.directory)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await fs.readFile(recent.copy, "utf8")).toBe("pre-migration");
  // Another state directory's history decides this copy, and it is not readable from here.
  expect(await fs.readFile(foreign.copy, "utf8")).toBe("pre-migration");
  expect(cleanup.lines).toContainEqual(
    expect.stringContaining(`${foreign.directory}: no update run in this state directory`),
  );
});

it("keeps every snapshot when this state directory has no update history to search", async () => {
  const fixture = await earlierRun();
  const old = await snapshot(fixture.artifacts, "0000ffff", fixture.stateDir, 30);
  const cleanup = await sweep(fixture);
  expect(await fs.readFile(old.copy, "utf8")).toBe("pre-migration");
  expect(cleanup.lines).toContainEqual(
    expect.stringContaining(`${old.directory}: update history cannot show which run captured it`),
  );
});

it("reports a failed cleanup of an earlier run's runtime and continues the update", async () => {
  const fixture = await earlierRun();
  const actualRm = fs.rm;
  vi.spyOn(fs, "rm").mockImplementation(async (target, rmOptions) => {
    if (String(target).startsWith(fixture.earlier)) {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    }
    await actualRm(target, rmOptions);
  });
  const { cleanup, onArtifactCleanup } = report();
  const outcome = await withRetainedUpdateRuntime(fixture.moduleUrl, async (retain) => {
    expect(await retain({ ...fixture.options, env: fixture.env, onArtifactCleanup })).toBeTruthy();
    return "update continued";
  });
  expect(outcome).toBe("update continued");
  expect(cleanup.warnings).toEqual([
    expect.stringContaining(`${fixture.earlier}: cleanup failed: denied`),
  ]);
});

it("continues the update when the sweep itself throws", async () => {
  const fixture = await earlierRun();
  vi.spyOn(os, "tmpdir").mockImplementationOnce(() => {
    throw new Error("fixture sweep failure");
  });
  const { cleanup, onArtifactCleanup } = report();
  const outcome = await withRetainedUpdateRuntime(fixture.moduleUrl, async (retain) => {
    expect(await retain({ ...fixture.options, env: fixture.env, onArtifactCleanup })).toBeTruthy();
    return "update continued";
  });
  expect(outcome).toBe("update continued");
  expect(cleanup.warnings).toEqual([
    "Could not clean up earlier update artifacts: fixture sweep failure",
  ]);
});
