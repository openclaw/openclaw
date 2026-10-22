import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { buildBackupStatusValue, noteBackupDoctorHint } from "../commands/backup-health.js";
import { backupRecordCommand } from "../commands/backup-record.js";
import { createTestRuntime } from "../commands/test-runtime-config-helpers.js";
import { buildBackupScheduleJob } from "../cron/backup-command.js";
import { saveCronJobsStore } from "../cron/store.js";
import { resolveCronJobsStorePathFromConfig } from "../cron/store/paths.js";
import type { CronJob } from "../cron/types.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { parseBackupRun } from "./backup-run-records.contract.js";
import {
  readBackupArchiveDirectories,
  readBackupRunFreshness,
  readBackupRuns,
  summarizeBackupTargets,
  recordBackupRunOutcome,
  type BackupRunRecord,
  type BackupRunFreshness,
} from "./backup-run-records.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "./openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseForTest,
  closeOpenClawStateDatabaseAsync,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";

const mocks = vi.hoisted(() => ({ note: vi.fn() }));
const roots = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    try {
      await closeOpenClawStateDatabaseAsync();
      closeOpenClawStateDatabaseForTest();
      cleanup();
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      mocks.note.mockReset();
    }
  }),
);

vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: mocks.note }));

type Outcome = Parameters<typeof recordBackupRunOutcome>[0];
async function fixture(stubEnv = false, bootstrap = true) {
  const root = roots.make("openclaw-backup-runs-test-");
  const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
  // Recording never creates the ledger; ordinary fixtures model an existing host.
  if (bootstrap) {
    runOpenClawStateWriteTransaction(() => undefined, { env });
  }
  if (stubEnv) {
    vi.stubEnv("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
  }
  return {
    env,
    record: (overrides: Partial<Omit<Outcome, "env">> = {}) =>
      recordBackupRunOutcome({ env, kind: "archive", status: "ok", archivePath: "", ...overrides }),
  };
}

function schedule(namespace: string): CronJob {
  return {
    ...buildBackupScheduleJob({
      mode: "offsite",
      location: "archive",
      namespace,
      everyMs: 100,
      includeWorkspace: true,
    }),
    id: "scheduled",
    createdAtMs: 1,
    updatedAtMs: 1,
    state: {},
  };
}

function legacyRun(manifest: object, archivePath = "") {
  return parseBackupRun({
    id: "legacy",
    created_at: 1,
    archive_path: archivePath,
    status: "ok",
    manifest_json: JSON.stringify(manifest),
  });
}

const offsiteLocation = (namespace = "host") => ({
  name: "offsite",
  provider: "filesystem",
  locationId: "location-1",
  namespace,
  key: "20260930T120000Z-abcd1234.tar.gz",
  plaintextBytes: 100,
  storedBytes: 150,
});

async function checkHint(
  env: NodeJS.ProcessEnv,
  message?: string | RegExp,
  now?: number,
  cfg?: Parameters<typeof noteBackupDoctorHint>[1],
) {
  mocks.note.mockClear();
  if (now !== undefined) {
    vi.spyOn(Date, "now").mockReturnValue(now);
  }
  await noteBackupDoctorHint(env, cfg);
  if (message === undefined) {
    expect(mocks.note).not.toHaveBeenCalled();
  } else {
    expect(mocks.note).toHaveBeenCalledWith(
      typeof message === "string"
        ? expect.stringContaining(message)
        : expect.stringMatching(message),
      "Backups",
    );
  }
}

describe("backup run records", () => {
  it("discovers native absolute archive parents without requiring them to exist", async () => {
    const { env, record } = await fixture();
    const parent = path.join(path.dirname(resolveOpenClawStateSqlitePath(env)), "archives");
    for (const [kind, archivePath] of [
      ["archive", path.join(parent, "first.tar.gz")],
      ["archive", path.join(parent, "second.tar.gz")],
      ["archive", "storage://offsite/host/backup.tar.gz"],
      ["archive", "relative.tar.gz"],
      ["git", path.join(parent, "git")],
    ] as const) {
      await record({ kind, archivePath });
    }
    expect(await readBackupArchiveDirectories(env)).toEqual([parent]);
    await expect(fs.access(parent)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reads legacy manifests and round trips offsite details and external command outcomes", async () => {
    expect(legacyRun({ kind: "archive" }, "/old.tar.gz")).toEqual({
      id: "legacy",
      createdAt: 1,
      archivePath: "/old.tar.gz",
      status: "ok",
      kind: "archive",
    });
    const { env, record } = await fixture(true);
    const location = offsiteLocation();
    expect(legacyRun({ kind: "archive", target: "offsite", location })).toMatchObject({
      namespace: "host",
      location,
    });
    await record({
      target: "offsite",
      location,
      retention: { kept: 7, deleted: 2 },
      createdAt: 20,
    });
    const failed = {
      status: "failed",
      target: "offsite",
      namespace: "host",
      error: "reconnect the disk",
      createdAt: 30,
    } as const;
    await record(failed);
    vi.spyOn(Date, "now").mockReturnValue(40);
    await backupRecordCommand(createTestRuntime(), {
      status: "ok",
      target: "host-restic",
      bytes: "321",
    });
    const runs = await readBackupRuns(env);
    expect(runs).toEqual([
      expect.objectContaining({
        kind: "external",
        target: "host-restic",
        status: "ok",
        bytes: 321,
      }),
      expect.objectContaining(failed),
      expect.objectContaining({ location, retention: { kept: 7, deleted: 2 } }),
    ]);
    expect(summarizeBackupTargets(runs)).toEqual([
      { kind: "external", target: "host-restic", latest: runs[0], latestOk: runs[0] },
      { kind: "archive", target: "offsite", namespace: "host", latest: runs[1], latestOk: runs[2] },
    ]);
    expect((await readBackupRunFreshness(env)).latestOffsite?.createdAt).toBe(30);
    vi.mocked(Date.now).mockReturnValue(50);
    await backupRecordCommand(createTestRuntime(), {
      status: "failed",
      target: "host-restic",
      error: "host timer failed",
    });
    expect((await readBackupRuns(env))[0]).toMatchObject({
      kind: "external",
      status: "failed",
      error: "host timer failed",
    });
  });

  it.each([
    { status: "invalid", target: "host", bytes: undefined },
    { status: "ok", target: "", bytes: undefined },
    { status: "ok", target: "host", bytes: "-1" },
    { status: "ok", target: "host", bytes: "1.5" },
  ])("rejects invalid external outcome input %j", async (opts) => {
    await expect(backupRecordCommand(createTestRuntime(), opts)).rejects.toThrow();
  });

  it.each(["host-a", undefined])(
    "does not count namespace %s successes toward another namespace's schedule",
    async (namespace) => {
      const { env, record } = await fixture(true);
      vi.spyOn(Date, "now").mockReturnValue(1_100);
      const ok = {
        createdAt: 1_000,
        archivePath: "storage://archive/backups/host-a/backup.tar.gz",
        target: "archive",
        location: namespace ? { ...offsiteLocation(namespace), name: "archive" } : undefined,
      };
      await record(ok);
      await saveCronJobsStore(resolveCronJobsStorePathFromConfig({}, env), {
        version: 1,
        jobs: [schedule("host-b")],
      });
      await checkHint(env, "No successful offsite backup to archive is recorded.", undefined, {});
      const successfulTarget = { target: "archive", latestOk: { createdAt: 1_000 } };
      expect(summarizeBackupTargets(await readBackupRuns(env))).toMatchObject([successfulTarget]);
      await record({
        ...ok,
        location: undefined,
        namespace: "host-b",
        status: "failed",
        error: "disk unavailable",
        createdAt: 1_050,
      });
      const targets = summarizeBackupTargets(await readBackupRuns(env));
      expect(targets).toHaveLength(2);
      expect(targets[0]).toEqual({
        kind: "archive",
        target: "archive",
        namespace: "host-b",
        latest: expect.objectContaining({ status: "failed", namespace: "host-b" }),
      });
      expect(targets[1]).toMatchObject(successfulTarget);
      await record({
        ...ok,
        location: undefined,
        namespace: "host-b",
        createdAt: 1_100,
      });
      await checkHint(env, undefined, undefined, {});
    },
  );

  it("hints on failed or stale offsite schedules independently of newer successes elsewhere", async () => {
    const { env, record } = await fixture(true);
    const cfg = {};
    const storePath = resolveCronJobsStorePathFromConfig(cfg, env);
    const ok = { createdAt: 1_000, target: "archive", namespace: "host" };
    const job = schedule("host");
    await record(ok);
    await saveCronJobsStore(storePath, { version: 1, jobs: [job] });
    await checkHint(env, undefined, 1_300, cfg);
    await checkHint(env, "openclaw storage test archive", 1_301, cfg);
    await record({ ...ok, target: "elsewhere", createdAt: 1_250 });
    await record({ ...ok, status: "failed", error: "disk unavailable", createdAt: 1_200 });
    await checkHint(
      env,
      /archive failed: disk unavailable.*openclaw storage test archive/su,
      1_250,
      cfg,
    );
    await saveCronJobsStore(storePath, { version: 1, jobs: [{ ...job, enabled: false }] });
    await checkHint(env, undefined, 1_301, cfg);
  });

  it("records in the captured state without main-thread SQL and retains the outcome after reopen", async () => {
    const { env } = await fixture();
    const { env: otherEnv } = await fixture();
    const mutableEnv = { ...env };
    const snapshot = {
      archivePath: "/backups/snapshot",
      kind: "sqlite-snapshot",
      status: "ok",
      createdAt: 7,
    } as const;
    await closeOpenClawStateDatabaseAsync();
    requireNodeSqlite();
    const sql = observeMainThreadSql();
    try {
      const pending = recordBackupRunOutcome({ env: mutableEnv, ...snapshot });
      mutableEnv.OPENCLAW_STATE_DIR = otherEnv.OPENCLAW_STATE_DIR;
      await pending;
      const [first, second] = await Promise.all([
        readBackupRunFreshness(env),
        readBackupRunFreshness(otherEnv),
      ]);
      expect(second).toEqual({});
      expect(first).toMatchObject({ latest: snapshot });
      sql.expectIdle();
    } finally {
      sql.restore();
    }
    await closeOpenClawStateDatabaseAsync();
    expect(await readBackupRunFreshness(env)).toMatchObject({
      latest: snapshot,
      latestOk: { archivePath: "/backups/snapshot" },
    });
  });

  it.each([
    ["archive", "occasional", "frequent", "occasional"],
    ["git", "commit", undefined, "/backups/git"],
    ["archive", undefined, undefined, "/backups/archive-252.tar.gz"],
  ] as const)(
    "retains %s target %s attempts and successes beyond the 200-row window",
    async (kind, target, namespace, expectedTarget) => {
      const { env, record } = await fixture();
      const frequentRun = (index: number) => ({
        archivePath: kind === "git" ? "/backups/git" : `/backups/archive-${index}.tar.gz`,
        kind,
        target: target === "commit" ? `commit-${index}` : target,
        namespace,
      });
      const occasional = {
        archivePath: "/backups/archive.tar.gz",
        target: "occasional",
        namespace: "occasional",
      };
      await record({ ...occasional, createdAt: 1 });
      await record({
        ...occasional,
        status: "failed",
        error: "archive failed",
        createdAt: 2,
      });
      for (let index = 3; index <= 252; index += 1) {
        await record({ ...frequentRun(index), createdAt: index });
      }
      const targets = summarizeBackupTargets(await readBackupRuns(env));
      expect(targets.find((entry) => entry.latest.createdAt === 252)).toMatchObject({
        kind,
        target: expectedTarget,
        latest: { createdAt: 252, status: "ok" },
        latestOk: { createdAt: 252, status: "ok" },
      });
      expect(targets.find((entry) => entry.namespace === "occasional")).toMatchObject({
        kind: "archive",
        target: "occasional",
        latest: { createdAt: 2, status: "failed" },
        latestOk: { createdAt: 1, status: "ok" },
      });
      const rows = withExistingOpenClawStateDatabaseReadOnly(
        ({ db }) =>
          db
            .prepare("SELECT created_at, status FROM backup_runs ORDER BY created_at ASC")
            .all() as Array<{ created_at: number; status: string }>,
        { env },
      );
      expect(rows).toHaveLength(202);
      expect(rows?.slice(0, 3).map((row) => row.created_at)).toEqual([1, 2, 53]);
      expect(rows?.at(-1)).toMatchObject({ created_at: 252, status: "ok" });
      await record({ ...frequentRun(253), status: "failed", createdAt: 253 });
      expect(await readBackupRunFreshness(env)).toMatchObject({
        latest: { createdAt: 253, status: "failed" },
        latestOk: { createdAt: 252, status: "ok" },
      });
    },
  );

  it("treats an older same-version database without backup_runs as no recorded backups", async () => {
    const { env } = await fixture();
    withExistingOpenClawStateDatabaseReadOnly(() => undefined, { env });
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    const pathname = resolveOpenClawStateSqlitePath(env);
    fsSync.renameSync(pathname, `${pathname}.seed`);
    fsSync.copyFileSync(`${pathname}.seed`, pathname);
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(pathname);
    raw.exec("DROP TABLE backup_runs");
    raw.close();
    expect(await readBackupRunFreshness(env)).toEqual({});
  });

  it("keeps absent status reads read-only and formats none, failed, fresh, and stale states", async () => {
    const { env, record } = await fixture(false, false);
    const realpath = vi.spyOn(fsSync.realpathSync, "native").mockImplementation(() => {
      throw new Error("Scratch discovery must not canonicalize an absent ledger");
    });
    await expect(readBackupArchiveDirectories(env)).resolves.toEqual([]);
    expect(realpath).not.toHaveBeenCalled();
    realpath.mockRestore();
    await record({ archivePath: "/backups/failed.tar.gz", status: "failed" });
    expect(await readBackupRunFreshness(env)).toEqual({});
    await expect(fs.access(resolveOpenClawStateSqlitePath(env))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const formatTimeAgo = (ageMs: number) => `${ageMs / 3_600_000}h ago`;
    const statusValue = (freshness: BackupRunFreshness, now: number) =>
      buildBackupStatusValue({ freshness, now, formatTimeAgo });
    expect(statusValue({}, 10)).toBe("none recorded");
    const failed: BackupRunRecord = {
      id: "failed",
      createdAt: 1,
      archivePath: "/backup",
      status: "failed",
      kind: "archive",
    };
    expect(statusValue({ latest: failed }, 3 * 24 * 3_600_000 + 1)).toBe(
      "last attempt failed 72h ago (archive)",
    );
    await checkHint(env, "No successful backup is recorded.");

    runOpenClawStateWriteTransaction(() => undefined, { env });
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    await record({ archivePath: "/backup", kind: "git", createdAt: 1 });
    await checkHint(env);

    await checkHint(env, "more than 14 days old", 1 + 15 * 24 * 3_600_000);

    await record({
      archivePath: "/backups/git",
      kind: "git",
      pushFailed: true,
      error: `${"x".repeat(1_199)}😀tail`,
      createdAt: 2,
    });
    const pushFailed = await readBackupRunFreshness(env);
    expect(pushFailed.latest?.error).toBe("x".repeat(1_199));
    expect(statusValue(pushFailed, 3_600_002)).toBe("last ok 1h ago (git, push failing)");
    await checkHint(env, /configured Git remote.*\/backups\/git/su, 3_600_002);
  });
});
