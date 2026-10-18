import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  collectStandaloneDoctorCaptures,
  retireExpiredStandaloneDoctorCaptures,
} from "./doctor-capture-retention.js";
import { resolveUpdateCaptureRoot } from "./update-capture-paths.js";
import {
  UPDATE_CAPTURE_PRIVACY_MARKER,
  UPDATE_CAPTURE_PRIVACY_MARKER_CONTENT,
} from "./update-capture-privacy-marker.js";
import { retainedCheckpointBinding } from "./update-retained-checkpoint.test-support.js";
import {
  createRetainedUpdateRecovery,
  storeRetainedUpdateRecovery,
} from "./update-retained-recovery.test-support.js";
import { createUpdateRun } from "./update-run-ledger.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => closeOpenClawStateDatabaseForTest());
const now = Date.parse("2026-10-16T12:00:00Z");

function fixture() {
  const stateDir = path.join(fs.realpathSync(dirs.make("doctor-retention-")), "state");
  fs.mkdirSync(stateDir);
  const env = { HOME: stateDir, OPENCLAW_STATE_DIR: stateDir };
  const root = resolveUpdateCaptureRoot(stateDir);
  const seal = (ageDays: number, runId = `doctor-${randomUUID()}`) => {
    const directory = path.join(root, runId);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, UPDATE_CAPTURE_PRIVACY_MARKER),
      UPDATE_CAPTURE_PRIVACY_MARKER_CONTENT,
    );
    fs.writeFileSync(
      path.join(directory, "manifest.json"),
      JSON.stringify({
        schemaVersion: 2,
        kind: "update-recovery",
        generation: { kind: "baseline" },
        databases: [],
        runId,
        installRoot: stateDir,
        stateDir,
        configPath: path.join(stateDir, "openclaw.json"),
        configPaths: [path.join(stateDir, "openclaw.json")],
        creator: { host: "fixture", pid: 1, startIdentity: "1" },
        drivers: [],
        createdAt: new Date(now - ageDays * 86_400_000).toISOString(),
        roots: [path.join(stateDir, "openclaw.json")],
        excludedRoots: [],
        protectedPaths: [path.join(stateDir, "openclaw.json")],
        entries: [
          {
            kind: "missing",
            sourcePath: path.join(stateDir, "openclaw.json"),
            sqlite: false,
            directory: false,
          },
        ],
      }),
    );
    return directory;
  };
  return { stateDir, env, seal };
}

it("retains only the newest three of five sealed standalone captures, leaving update and incomplete captures untouched", async () => {
  const f = fixture();
  const captures = [5, 4, 3, 2, 1].map((age) => f.seal(age));
  const update = f.seal(40, randomUUID());
  const incomplete = f.seal(40);
  fs.writeFileSync(path.join(incomplete, "manifest.json.partial"), "unfinished");
  const result = await retireExpiredStandaloneDoctorCaptures({
    ...f,
    now,
    keepRunId: path.basename(captures[4]!),
    assertCurrent: vi.fn(),
  });
  expect(result.warnings).toEqual([]);
  expect(result.retired.toSorted()).toEqual(captures.slice(0, 2).toSorted());
  expect(captures.map((directory) => fs.existsSync(directory))).toEqual([
    false,
    false,
    true,
    true,
    true,
  ]);
  expect(fs.existsSync(update)).toBe(true);
  expect(fs.existsSync(incomplete)).toBe(true);
});

it("protects an old capture referenced by active recovery and keeps all captures when recovery is unreadable", async () => {
  const f = fixture();
  const old = f.seal(40);
  const superseded = f.seal(4);
  [3, 2, 1].forEach((age) => f.seal(age));
  const options = { env: f.env };
  const { runId } = createUpdateRun({ trigger: "cli" }, options);
  const runtime = { root: f.stateDir, nodePath: process.execPath, version: "1.0.0", buildId: null };
  const record = createRetainedUpdateRecovery({ runId, from: runtime, to: runtime }, options);
  record.checkpoint = retainedCheckpointBinding(record);
  record.checkpoint.ref.manifestPath = path.join(old, "manifest.json");
  storeRetainedUpdateRecovery(record, options);
  const preview = collectStandaloneDoctorCaptures({ ...f, now });
  expect(preview.captures.get(old)).toMatchObject({
    eligible: false,
    reason: "pending-update-recovery",
  });
  expect(preview.captures.get(superseded)?.eligible).toBe(true);
  const retired = await retireExpiredStandaloneDoctorCaptures({
    ...f,
    now,
    keepRunId: "",
    assertCurrent: vi.fn(),
  });
  expect(retired).toEqual({ retired: [superseded], warnings: [] });
  expect(fs.existsSync(old)).toBe(true);
  const unreadableCandidate = f.seal(10);
  openOpenClawStateDatabase(options)
    .db.prepare("UPDATE config_machine_state SET value_json = ? WHERE state_key = ?")
    .run("unreadable", `update.recovery.${runId}`);
  const result = await retireExpiredStandaloneDoctorCaptures({
    ...f,
    now,
    keepRunId: "",
    assertCurrent: vi.fn(),
  });
  expect(result.retired).toEqual([]);
  expect(result.warnings).toHaveLength(1);
  expect(fs.existsSync(unreadableCandidate)).toBe(true);
});

it("expires captures after thirty days but always keeps the newest sealed capture", async () => {
  const f = fixture();
  const expired = f.seal(40);
  const newest = f.seal(31);
  const result = await retireExpiredStandaloneDoctorCaptures({
    ...f,
    now,
    keepRunId: path.basename(newest),
    assertCurrent: vi.fn(),
  });
  expect(result).toEqual({ retired: [expired], warnings: [] });
  expect(fs.existsSync(newest)).toBe(true);
});
