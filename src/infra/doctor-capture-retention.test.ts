import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createMissingConfigRecoveryManifest } from "../commands/update-recovery-manifest.test-support.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { retireExpiredStandaloneDoctorCaptures } from "./doctor-capture-retention.js";
import { resolveUpdateCaptureRoot } from "./update-capture-paths.js";
import { retainedCheckpointBinding } from "./update-retained-checkpoint.test-support.js";
import {
  createRetainedUpdateRecovery,
  storeRetainedUpdateRecovery,
} from "./update-retained-recovery.test-support.js";
import { createUpdateRun } from "./update-run-ledger.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => closeOpenClawStateDatabaseForTest());
// Ages are relative to the real clock: the retention owner reads no injected time.
const now = Date.now();

function retire(f: ReturnType<typeof fixture>, keepRunId = "", assertCurrent = vi.fn()) {
  return retireExpiredStandaloneDoctorCaptures({ ...f, keepRunId, assertCurrent });
}

function fixture() {
  const stateDir = path.join(fs.realpathSync(dirs.make("doctor-retention-")), "state");
  fs.mkdirSync(stateDir);
  const env = { HOME: stateDir, OPENCLAW_STATE_DIR: stateDir };
  const root = resolveUpdateCaptureRoot(stateDir);
  const seal = (age: number, id = `doctor-${randomUUID()}`, dir = path.join(root, id)) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "manifest.json"),
      JSON.stringify(
        createMissingConfigRecoveryManifest({
          runId: id,
          installRoot: stateDir,
          stateDir,
          configPath: path.join(stateDir, "openclaw.json"),
          createdAt: new Date(now - age * 86_400_000).toISOString(),
        }),
      ),
    );
    return dir;
  };
  return { stateDir, env, seal };
}

it.each([
  { ages: [5, 4, 3, 2, 1], retained: [false, false, false, false, true] },
  // An install that kept three under the former limit converges on one.
  { ages: [3, 2, 1], retained: [false, false, true] },
  { ages: [40, 31], retained: [false, true] },
])("keeps only the newest sealed capture, whatever its age: $ages", async ({ ages, retained }) => {
  const f = fixture();
  const captures = ages.map((age) => f.seal(age));
  const result = await retire(f);
  expect(result.warnings).toEqual([]);
  expect(result.retired.toSorted()).toEqual(
    captures.filter((_, index) => !retained[index]).toSorted(),
  );
  expect(captures.map(fs.existsSync)).toEqual(retained);
});

it("protects an old capture referenced by active recovery and keeps all captures when recovery is unreadable", async () => {
  const f = fixture();
  const old = f.seal(40);
  const superseded = [4, 3, 2].map((age) => f.seal(age));
  const newest = f.seal(1);
  const options = { env: f.env };
  const { runId } = createUpdateRun({ trigger: "cli" }, options);
  const runtime = { root: f.stateDir, nodePath: process.execPath, version: "1.0.0", buildId: null };
  const record = createRetainedUpdateRecovery({ runId, from: runtime, to: runtime }, options);
  record.checkpoint = retainedCheckpointBinding(record);
  record.checkpoint.ref.manifestPath = path.join(old, "manifest.json");
  storeRetainedUpdateRecovery(record, options);
  const retired = await retire(f);
  expect(retired.warnings).toEqual([]);
  expect(retired.retired.toSorted()).toEqual(superseded.toSorted());
  expect([old, newest].map(fs.existsSync)).toEqual([true, true]);
  const unreadableCandidate = f.seal(10);
  openOpenClawStateDatabase(options)
    .db.prepare("UPDATE config_machine_state SET value_json = ? WHERE state_key = ?")
    .run("unreadable", `update.recovery.${runId}`);
  const result = await retire(f);
  expect(result.retired).toEqual([]);
  expect(result.warnings).toHaveLength(1);
  expect(fs.existsSync(unreadableCandidate)).toBe(true);
});

it("retires superseded sealed standalone Doctor captures and preserves the current, incomplete, linked, and update copies", async () => {
  const f = fixture();
  const store = resolveUpdateCaptureRoot(f.stateDir);
  const older = f.seal(31);
  // The caller's own capture stays even when a newer one exists.
  const current = f.seal(2);
  const recent = f.seal(1);
  const incomplete = path.join(store, `doctor-${randomUUID()}`);
  await fsPromises.mkdir(incomplete);
  const update = f.seal(40, randomUUID());
  const linkedId = `doctor-${randomUUID()}`;
  const linkedTarget = f.seal(31, linkedId, path.join(f.stateDir, "linked-capture"));
  const linked = path.join(store, linkedId);
  await fsPromises.symlink(linkedTarget, linked, "dir");
  const interrupted = f.seal(31);
  fs.writeFileSync(path.join(interrupted, "manifest.json.partial"), "unverified bytes");
  const assertCurrent = vi.fn();

  const result = await retire(f, path.basename(current), assertCurrent);

  expect(result).toEqual({ retired: [older], warnings: [] });
  expect(assertCurrent).toHaveBeenCalled();
  await expect(fsPromises.lstat(older)).rejects.toMatchObject({ code: "ENOENT" });
  for (const retained of [current, recent, incomplete, update, linkedTarget, interrupted]) {
    expect((await fsPromises.lstat(retained)).isDirectory()).toBe(true);
  }
  expect((await fsPromises.lstat(linked)).isSymbolicLink()).toBe(true);
  expect(await fsPromises.readlink(linked)).toBe(linkedTarget);
});
