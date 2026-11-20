import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { cleanupCompletedUpdateRecovery } from "../../commands/update-automatic-cleanup.js";
import { formatUpdateDatabaseSnapshotReceipt } from "../../infra/update-database-snapshot-receipt.js";
import { createRetainedUpdateRecovery } from "../../infra/update-retained-recovery.test-support.js";
import {
  createUpdateRun,
  finishUpdateRun,
  recordUpdateRunStep,
  recordUpdateRunVerification,
} from "../../infra/update-run-ledger.js";
import { defaultRuntime } from "../../runtime.js";
import * as snapshotBackup from "../../snapshot/database-backup.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { updateCleanupCommand } from "./cleanup.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  await cleanupSessionStateForTest();
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

function writeSnapshot(directory: string): string {
  fs.mkdirSync(path.join(directory, "payload"), { recursive: true });
  fs.writeFileSync(path.join(directory, "payload", "openclaw.sqlite"), Buffer.alloc(1000));
  fs.writeFileSync(path.join(directory, "schema-discovery-ownership.json"), "{}");
  return directory;
}

const gitSnapshotName = () => `dist-runtime.openclaw-update-${randomUUID()}.tmp.databases`;

/**
 * Update history in run order: two runs a later verified update supersedes, one of them
 * with a pending recovery; the verified update; a failure after it; and a live run. Each
 * recorded the snapshot directory it kept.
 */
async function withSnapshotHistory(
  run: (snapshots: Record<string, string>, runs: Record<string, string>) => Promise<void>,
) {
  const home = fs.realpathSync(dirs.make("update-snapshot-cleanup-"));
  fs.mkdirSync(path.join(home, ".openclaw"));
  const artifacts = path.join(home, "checkout", ".artifacts");
  const outsideHome = fs.realpathSync(dirs.make("update-snapshot-outside-home-"));
  const redactedRoot = path.join(outsideHome, "checkout");
  const env = {
    HOME: home,
    USERPROFILE: home,
    OPENCLAW_HOME: undefined,
    OPENCLAW_PROFILE: undefined,
    OPENCLAW_STATE_DIR: undefined,
    OPENCLAW_CONFIG_PATH: undefined,
  };
  await withEnvAsync(env, async () => {
    const clock = vi.spyOn(Date, "now");
    const snapshots: Record<string, string> = {};
    const runs: Record<string, string> = {};
    let now = Date.UTC(2026, 10, 1);
    for (const [label, status, directory] of [
      // A package update's snapshot beside its package backup, recorded as an absolute path.
      [
        "supersededPackage",
        "succeeded",
        path.join(
          outsideHome,
          "node_modules",
          ".openclaw.package-backup-4242-1795000000000.databases",
        ),
      ],
      // The checkout later moved; the run still names the previous root's snapshot.
      [
        "supersededPreviousRoot",
        "failed",
        path.join(home, "previous", ".artifacts", gitSnapshotName()),
      ],
      // The ledger redacts an install root outside the home directory: never found.
      [
        "supersededRedactedRoot",
        "failed",
        path.join(redactedRoot, ".artifacts", gitSnapshotName()),
      ],
      ["pendingRecovery", "failed", path.join(artifacts, gitSnapshotName())],
      ["latestVerified", "succeeded", path.join(artifacts, gitSnapshotName())],
      ["failedAfterVerified", "failed", path.join(artifacts, gitSnapshotName())],
      ["unfinished", undefined, path.join(artifacts, gitSnapshotName())],
    ] as const) {
      clock.mockReturnValue((now += 60_000));
      const { runId } = createUpdateRun({ trigger: "cli" }, { env });
      recordUpdateRunStep(
        runId,
        {
          step: "diagnostic:database snapshot",
          status: "completed",
          detail: `${formatUpdateDatabaseSnapshotReceipt(directory)} These snapshots require manual recovery and remain available after successful activation.`,
        },
        { env, redactPaths: label === "supersededRedactedRoot" ? [redactedRoot] : [] },
      );
      if (status === "succeeded") {
        recordUpdateRunVerification(
          runId,
          {
            serviceRunning: true,
            versionMatch: true,
            settled: true,
            coreReady: true,
            pluginErrors: [],
          },
          { env },
        );
      }
      if (status) {
        clock.mockReturnValue((now += 60_000));
        finishUpdateRun(runId, { status }, { env });
      }
      runs[label] = runId;
      snapshots[label] = writeSnapshot(directory);
    }
    clock.mockRestore();
    const runtime = { root: home, nodePath: process.execPath, version: "1.0.0", buildId: null };
    createRetainedUpdateRecovery({ runId: runs.pendingRecovery!, from: runtime, to: runtime });
    // Named like a snapshot, beside recorded ones, but no listed run recorded it.
    snapshots.orphan = writeSnapshot(path.join(artifacts, gitSnapshotName()));
    // Not a name the updater gives a snapshot: never listed, never touched.
    snapshots.unrelated = writeSnapshot(path.join(artifacts, "build-cache.databases"));
    closeOpenClawStateDatabaseForTest();
    await run(snapshots, runs);
  });
}

async function runCleanup(options: { dryRun?: boolean; yes?: boolean }, exitCode?: number) {
  const writeJson = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
  const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined as never);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  await updateCleanupCommand({ ...options, json: true });
  expect(exit.mock.calls).toEqual(exitCode === undefined ? [] : [[exitCode]]);
  exit.mockRestore();
  const report = writeJson.mock.calls.at(-1)?.[0] as {
    status: string;
    artifacts: Array<{
      kind?: string;
      path: string;
      runs: string[];
      outcome: string;
      reason: string;
      bytes: number;
    }>;
  };
  return {
    status: report.status,
    snapshots: Object.fromEntries(
      report.artifacts
        .filter((item) => item.kind === "database-snapshot")
        .map(({ path: directory, runs, outcome, reason, bytes }) => [
          directory,
          { runs, outcome, reason, bytes },
        ]),
    ),
  };
}

const expectedPreview = (snapshots: Record<string, string>, runs: Record<string, string>) => {
  const kept = (label: string, reason: string) => ({
    runs: [runs[label]],
    outcome: "protected",
    reason,
    bytes: 1002,
  });
  const superseded = (label: string) => ({
    runs: [runs[label]],
    outcome: "candidate",
    reason: "superseded-by-verified-update",
    bytes: 1002,
  });
  return {
    [snapshots.supersededPackage!]: superseded("supersededPackage"),
    [snapshots.supersededPreviousRoot!]: superseded("supersededPreviousRoot"),
    [snapshots.pendingRecovery!]: kept("pendingRecovery", "pending-update-recovery"),
    // The verified update's own snapshot waits for the next verified update.
    [snapshots.latestVerified!]: kept("latestVerified", "awaiting-later-verified-update"),
    [snapshots.failedAfterVerified!]: kept("failedAfterVerified", "awaiting-later-verified-update"),
    [snapshots.unfinished!]: kept("unfinished", "unfinished-update-run"),
    [snapshots.orphan!]: {
      runs: [],
      outcome: "protected",
      reason: "orphan-database-snapshot",
      bytes: 1002,
    },
  };
};

it("previews earlier runs' database snapshots with run, bytes and reason without removing any", async () => {
  await withSnapshotHistory(async (snapshots, runs) => {
    expect(await runCleanup({ dryRun: true })).toEqual({
      status: "preview",
      snapshots: expectedPreview(snapshots, runs),
    });
    for (const directory of Object.values(snapshots)) {
      expect(fs.existsSync(directory), directory).toBe(true);
    }
  });
});

it("removes only database snapshots a later verified update superseded", async () => {
  await withSnapshotHistory(async (snapshots, runs) => {
    const result = await runCleanup({ yes: true });
    expect(result.status).toBe("complete");
    for (const [directory, item] of Object.entries(expectedPreview(snapshots, runs))) {
      expect(result.snapshots[directory]).toEqual(
        item.outcome === "candidate"
          ? { ...item, outcome: "removed", reason: "database-snapshot-retired" }
          : item,
      );
      expect(fs.existsSync(directory), directory).toBe(item.outcome !== "candidate");
    }
    expect(fs.existsSync(snapshots.unrelated!)).toBe(true);
    expect(fs.existsSync(snapshots.supersededRedactedRoot!)).toBe(true);
  });
});

it("automatic cleanup after a verified update retires earlier snapshots and reports the kept ones", async () => {
  await withSnapshotHistory(async (snapshots, runs) => {
    // A clock set back makes an earlier run look superseded to itself: its own snapshot stays.
    await cleanupCompletedUpdateRecovery(runs.supersededPackage!, process.env, () => {});
    expect(fs.existsSync(snapshots.supersededPackage!)).toBe(true);
    const step = await cleanupCompletedUpdateRecovery(runs.latestVerified!, process.env, () => {});
    expect(step?.advisory).toBeUndefined();
    expect(step?.diagnostics).toEqual(
      expect.arrayContaining([
        expect.stringContaining(`Removed ${snapshots.supersededPackage} (1002 logical bytes`),
        expect.stringContaining(`Removed ${snapshots.supersededPreviousRoot} (1002 logical bytes`),
        expect.stringMatching(
          new RegExp(
            `^Kept ${snapshots.latestVerified} \\(1002 logical bytes.*kept until a later verified update`,
          ),
        ),
        expect.stringContaining(`Kept: not provably ours: ${snapshots.orphan} (1002 logical bytes`),
      ]),
    );
    expect(fs.existsSync(snapshots.supersededPackage!)).toBe(false);
    expect(fs.existsSync(snapshots.supersededPreviousRoot!)).toBe(false);
    for (const label of [
      "pendingRecovery",
      "latestVerified",
      "failedAfterVerified",
      "unfinished",
    ]) {
      expect(fs.existsSync(snapshots[label]!), label).toBe(true);
    }
  });
});

it("keeps a superseded snapshot whose recorded path became a symlink", async () => {
  await withSnapshotHistory(async (snapshots) => {
    const moved = `${snapshots.supersededPackage}.moved`;
    fs.renameSync(snapshots.supersededPackage!, moved);
    fs.symlinkSync(moved, snapshots.supersededPackage!, "dir");
    const result = await runCleanup({ yes: true });
    expect(result.snapshots[snapshots.supersededPackage!]).toBeUndefined();
    expect(fs.existsSync(path.join(moved, "payload", "openclaw.sqlite"))).toBe(true);
  });
});

it("attributes no home-relative snapshot while the ledger's home names two directories", async () => {
  await withSnapshotHistory(async (snapshots) => {
    await withEnvAsync({ USERPROFILE: path.dirname(snapshots.supersededPackage!) }, async () => {
      await runCleanup({ yes: true });
      expect(fs.existsSync(snapshots.supersededPreviousRoot!)).toBe(true);
      expect(fs.existsSync(snapshots.supersededPackage!)).toBe(false);
    });
  });
});

it("still retires recorded snapshots when an earlier install root can no longer be inspected", async () => {
  await withSnapshotHistory(async (snapshots) => {
    // The previous checkout was replaced by a file, so its recorded location is not a directory path.
    const previous = path.dirname(path.dirname(snapshots.supersededPreviousRoot!));
    fs.rmSync(previous, { recursive: true });
    fs.writeFileSync(previous, "");
    const result = await runCleanup({ yes: true });
    expect(result.snapshots[snapshots.supersededPreviousRoot!]).toBeUndefined();
    expect(result.snapshots[snapshots.supersededPackage!]).toMatchObject({ outcome: "removed" });
  });
});

it("drops a snapshot's PostgreSQL server captures before removing it and keeps it while the drop fails", async () => {
  await withSnapshotHistory(async (snapshots) => {
    const snapshot = snapshots.supersededPreviousRoot!;
    const exported = path.join(snapshot, "payload", "workboard.sqlite.postgres");
    fs.mkdirSync(exported);
    fs.writeFileSync(path.join(exported, "manifest.json"), "{}");
    // A mirrored source directory of that name holds no manifest and is not an export.
    fs.mkdirSync(path.join(snapshot, "payload", "state.postgres"));
    const discard = vi.spyOn(snapshotBackup, "discardPostgresSchemaCaptures");
    discard.mockImplementationOnce(async () => {
      expect(fs.existsSync(path.join(exported, "manifest.json"))).toBe(true);
      throw new Error("connection refused");
    });
    const failed = await runCleanup({ yes: true }, 1);
    expect(discard).toHaveBeenCalledExactlyOnceWith(expect.anything(), [exported]);
    expect(failed.snapshots[snapshot]?.reason).toBe("database-snapshot-retirement-failed");
    expect(fs.existsSync(path.join(exported, "manifest.json"))).toBe(true);
    expect(fs.existsSync(snapshots.supersededPackage!)).toBe(false);
    discard.mockResolvedValueOnce();
    expect((await runCleanup({ yes: true })).snapshots[snapshot]?.outcome).toBe("removed");
  });
});
