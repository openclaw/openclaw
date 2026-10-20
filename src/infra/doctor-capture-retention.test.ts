import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { parseUpdateRecoveryBackupManifest } from "../commands/backup-verify-manifest.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
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
import { getUpdateRunAsync } from "./update-run-reader.js";

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

it("retires only expired sealed standalone Doctor captures and preserves incomplete or linked copies", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const day = 24 * 60 * 60_000;
    const store = resolveUpdateCaptureRoot(state.stateDir);
    const sealed = async (runId: string, ageDays: number, directory = path.join(store, runId)) => {
      const manifest = {
        schemaVersion: 2,
        kind: "update-recovery",
        generation: { kind: "baseline" },
        databases: [],
        runId,
        installRoot: state.root,
        stateDir: state.stateDir,
        configPath: state.configPath,
        configPaths: [state.configPath],
        creator: { host: "fixture", pid: 1, startIdentity: "1" },
        drivers: [],
        createdAt: new Date(now - ageDays * day).toISOString(),
        roots: [state.configPath],
        excludedRoots: [],
        protectedPaths: [state.configPath],
        entries: [
          { kind: "missing", sourcePath: state.configPath, sqlite: false, directory: false },
        ],
      };
      const raw = JSON.stringify(manifest);
      parseUpdateRecoveryBackupManifest(raw);
      await fsPromises.mkdir(directory, { recursive: true });
      await fsPromises.writeFile(path.join(directory, "manifest.json"), raw);
      expect(await getUpdateRunAsync(runId)).toBeUndefined();
      return directory;
    };
    const expired = await sealed(`doctor-${randomUUID()}`, 31);
    const recent = await sealed(`doctor-${randomUUID()}`, 1);
    const incomplete = path.join(store, `doctor-${randomUUID()}`);
    await fsPromises.mkdir(incomplete);
    const update = await sealed(randomUUID(), 40);
    const linkedId = `doctor-${randomUUID()}`;
    const linkedTarget = await sealed(linkedId, 31, state.path("linked-capture"));
    const linked = path.join(store, linkedId);
    await fsPromises.symlink(linkedTarget, linked, "dir");
    const interrupted: string[] = [];
    for (const kind of ["linked", "copied", "conflicting"]) {
      const retained = await sealed(`doctor-${randomUUID()}`, 31);
      const finalPath = path.join(retained, "manifest.json");
      const partialPath = `${finalPath}.partial`;
      if (kind === "linked") {
        await fsPromises.link(finalPath, partialPath);
      } else if (kind === "copied") {
        await fsPromises.copyFile(finalPath, partialPath);
      } else {
        await fsPromises.writeFile(partialPath, "different, unverified bytes");
      }
      interrupted.push(retained);
    }
    const assertCurrent = vi.fn();

    const result = await retireExpiredStandaloneDoctorCaptures({
      stateDir: state.stateDir,
      keepRunId: path.basename(recent),
      now,
      assertCurrent,
    });

    expect(result).toEqual({ retired: [expired], warnings: [] });
    expect(assertCurrent).toHaveBeenCalled();
    await expect(fsPromises.lstat(expired)).rejects.toMatchObject({ code: "ENOENT" });
    for (const retained of [recent, incomplete, update, linkedTarget, ...interrupted]) {
      expect((await fsPromises.lstat(retained)).isDirectory()).toBe(true);
    }
    expect((await fsPromises.lstat(linked)).isSymbolicLink()).toBe(true);
    expect(await fsPromises.readlink(linked)).toBe(linkedTarget);
  });
});
