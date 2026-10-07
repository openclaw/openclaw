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

async function testEnv(options?: { bootstrap?: boolean }): Promise<NodeJS.ProcessEnv> {
  const root = roots.make("openclaw-backup-runs-test-");
  const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
  if (options?.bootstrap) {
    // Recording is non-creating by contract, so the fixture bootstraps the
    // state database the way a real gateway host already has.
    runOpenClawStateWriteTransaction(() => undefined, { env });
  }
  return env;
}

describe("backup run records", () => {
  it("discovers native absolute archive parents without requiring them to exist", async () => {
    const env = await testEnv({ bootstrap: true });
    const parent = path.join(path.dirname(resolveOpenClawStateSqlitePath(env)), "archives");
    for (const [kind, archivePath] of [
      ["archive", path.join(parent, "first.tar.gz")],
      ["archive", path.join(parent, "second.tar.gz")],
      ["archive", "storage://offsite/host/backup.tar.gz"],
      ["archive", "relative.tar.gz"],
      ["git", path.join(parent, "git")],
    ] as const) {
      await recordBackupRunOutcome({ env, kind, archivePath, status: "ok" });
    }
    expect(await readBackupArchiveDirectories(env)).toEqual([parent]);
    await expect(fs.access(parent)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reads legacy manifests and round trips offsite details and external command outcomes", async () => {
    expect(
      parseBackupRun({
        id: "legacy",
        created_at: 1,
        archive_path: "/old.tar.gz",
        status: "ok",
        manifest_json: '{"kind":"archive"}',
      }),
    ).toEqual({
      id: "legacy",
      createdAt: 1,
      archivePath: "/old.tar.gz",
      status: "ok",
      kind: "archive",
    });
    const env = await testEnv({ bootstrap: true });
    vi.stubEnv("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
    const location = {
      name: "offsite",
      provider: "filesystem",
      locationId: "location-1",
      key: "20260930T120000Z-abcd1234.tar.gz",
      namespace: "host",
      plaintextBytes: 100,
      storedBytes: 150,
    };
    expect(
      parseBackupRun({
        id: "legacy-offsite",
        created_at: 1,
        archive_path: "",
        status: "ok",
        manifest_json: JSON.stringify({ kind: "archive", target: "offsite", location }),
      }),
    ).toMatchObject({ namespace: "host", location });
    await recordBackupRunOutcome({
      env,
      kind: "archive",
      status: "ok",
      archivePath: "",
      target: "offsite",
      location,
      retention: { kept: 7, deleted: 2 },
      createdAt: 20,
    });
    await recordBackupRunOutcome({
      env,
      kind: "archive",
      status: "failed",
      archivePath: "",
      target: "offsite",
      namespace: "host",
      error: "reconnect the disk",
      createdAt: 30,
    });
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
      expect.objectContaining({ target: "offsite", status: "failed", error: "reconnect the disk" }),
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
      const env = await testEnv({ bootstrap: true });
      vi.stubEnv("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
      vi.spyOn(Date, "now").mockReturnValue(1_100);
      const ok = {
        env,
        createdAt: 1_000,
        archivePath: "storage://archive/backups/host-a/backup.tar.gz",
        status: "ok" as const,
        kind: "archive" as const,
        target: "archive",
        ...(namespace
          ? {
              location: {
                name: "archive",
                provider: "filesystem",
                locationId: "location-1",
                namespace,
                key: "backup.tar.gz",
                plaintextBytes: 100,
                storedBytes: 100,
              },
            }
          : {}),
      };
      await recordBackupRunOutcome(ok);
      await saveCronJobsStore(resolveCronJobsStorePathFromConfig({}, env), {
        version: 1,
        jobs: [
          {
            ...buildBackupScheduleJob({
              mode: "offsite",
              location: "archive",
              namespace: "host-b",
              everyMs: 100,
              includeWorkspace: true,
            }),
            id: "scheduled",
            enabled: true,
            createdAtMs: 1,
            updatedAtMs: 1,
            state: {},
          },
        ],
      });
      await noteBackupDoctorHint(env, {});
      expect(mocks.note).toHaveBeenCalledWith(
        expect.stringContaining("No successful offsite backup to archive is recorded."),
        "Backups",
      );
      expect(summarizeBackupTargets(await readBackupRuns(env))).toEqual([
        expect.objectContaining({
          target: "archive",
          latestOk: expect.objectContaining({ createdAt: 1_000 }),
        }),
      ]);
      await recordBackupRunOutcome({
        ...ok,
        location: undefined,
        namespace: "host-b",
        status: "failed",
        error: "disk unavailable",
        createdAt: 1_050,
      });
      expect(summarizeBackupTargets(await readBackupRuns(env))).toEqual([
        {
          kind: "archive",
          target: "archive",
          namespace: "host-b",
          latest: expect.objectContaining({ status: "failed", namespace: "host-b" }),
        },
        expect.objectContaining({
          target: "archive",
          latestOk: expect.objectContaining({ createdAt: 1_000 }),
        }),
      ]);
      await recordBackupRunOutcome({
        ...ok,
        location: undefined,
        namespace: "host-b",
        createdAt: 1_100,
      });
      mocks.note.mockClear();
      await noteBackupDoctorHint(env, {});
      expect(mocks.note).not.toHaveBeenCalled();
    },
  );

  it("hints on failed or stale offsite schedules independently of newer successes elsewhere", async () => {
    const env = await testEnv({ bootstrap: true });
    vi.stubEnv("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
    const cfg = {};
    const storePath = resolveCronJobsStorePathFromConfig(cfg, env);
    const ok = {
      env,
      createdAt: 1_000,
      archivePath: "",
      status: "ok" as const,
      kind: "archive" as const,
      target: "archive",
      namespace: "host",
    };
    const schedule: CronJob = {
      id: "scheduled",
      name: "Offsite backup",
      declarationKey: "openclaw-backup-offsite-scheduled",
      enabled: true,
      createdAtMs: 1,
      updatedAtMs: 1,
      schedule: { kind: "every", everyMs: 100 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: {
        kind: "command",
        argv: ["openclaw", "backup", "create", "--to", "archive", "--namespace", "host"],
      },
      state: {},
    };
    await recordBackupRunOutcome(ok);
    await saveCronJobsStore(storePath, { version: 1, jobs: [schedule] });
    vi.spyOn(Date, "now").mockReturnValue(1_300);
    await noteBackupDoctorHint(env, cfg);
    expect(mocks.note).not.toHaveBeenCalled();
    vi.mocked(Date.now).mockReturnValue(1_301);
    await noteBackupDoctorHint(env, cfg);
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("openclaw storage test archive"),
      "Backups",
    );
    await recordBackupRunOutcome({ ...ok, target: "elsewhere", createdAt: 1_250 });
    await recordBackupRunOutcome({
      ...ok,
      status: "failed",
      error: "disk unavailable",
      createdAt: 1_200,
    });
    mocks.note.mockClear();
    vi.mocked(Date.now).mockReturnValue(1_250);
    await noteBackupDoctorHint(env, cfg);
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringMatching(/archive failed: disk unavailable.*openclaw storage test archive/su),
      "Backups",
    );
    await saveCronJobsStore(storePath, {
      version: 1,
      jobs: [{ ...schedule, enabled: false }],
    });
    mocks.note.mockClear();
    vi.mocked(Date.now).mockReturnValue(1_301);
    await noteBackupDoctorHint(env, cfg);
    expect(mocks.note).not.toHaveBeenCalled();
  });

  it("records in the captured state without main-thread SQL and retains the outcome after reopen", async () => {
    const env = await testEnv({ bootstrap: true });
    const otherEnv = await testEnv({ bootstrap: true });
    const mutableEnv = { ...env };
    await closeOpenClawStateDatabaseAsync();
    requireNodeSqlite();
    const sql = observeMainThreadSql();
    try {
      const pending = recordBackupRunOutcome({
        env: mutableEnv,
        archivePath: "/backups/snapshot",
        kind: "sqlite-snapshot",
        status: "ok",
        createdAt: 7,
      });
      mutableEnv.OPENCLAW_STATE_DIR = otherEnv.OPENCLAW_STATE_DIR;
      await pending;
      const [first, second] = await Promise.all([
        readBackupRunFreshness(env),
        readBackupRunFreshness(otherEnv),
      ]);
      expect(second).toEqual({});
      expect(first).toMatchObject({
        latest: { archivePath: "/backups/snapshot", kind: "sqlite-snapshot", createdAt: 7 },
      });
      sql.expectIdle();
    } finally {
      sql.restore();
    }
    await closeOpenClawStateDatabaseAsync();
    expect(await readBackupRunFreshness(env)).toMatchObject({
      latest: {
        archivePath: "/backups/snapshot",
        kind: "sqlite-snapshot",
        status: "ok",
        createdAt: 7,
      },
      latestOk: { archivePath: "/backups/snapshot" },
    });
  });

  it.each(["archive", "git", "local archive"] as const)(
    "retains each target and namespace's newest attempt and success beyond the 200-row window (%s)",
    async (mode) => {
      const env = await testEnv({ bootstrap: true });
      const frequentRun = (index: number) => ({
        archivePath: mode === "git" ? "/backups/git" : `/backups/archive-${index}.tar.gz`,
        kind: mode === "git" ? ("git" as const) : ("archive" as const),
        ...(mode === "local archive"
          ? {}
          : { target: mode === "git" ? `commit-${index}` : "occasional" }),
        ...(mode === "archive" ? { namespace: "frequent" } : {}),
      });
      await recordBackupRunOutcome({
        env,
        archivePath: "/backups/archive.tar.gz",
        status: "ok",
        kind: "archive",
        target: "occasional",
        namespace: "occasional",
        createdAt: 1,
      });
      await recordBackupRunOutcome({
        env,
        archivePath: "/backups/archive.tar.gz",
        status: "failed",
        kind: "archive",
        target: "occasional",
        namespace: "occasional",
        error: "archive failed",
        createdAt: 2,
      });
      for (let index = 3; index <= 252; index += 1) {
        await recordBackupRunOutcome({
          env,
          ...frequentRun(index),
          status: "ok",
          createdAt: index,
        });
      }
      const targets = summarizeBackupTargets(await readBackupRuns(env));
      expect(targets.find((entry) => entry.latest.createdAt === 252)).toMatchObject({
        kind: mode === "git" ? "git" : "archive",
        target:
          mode === "git"
            ? "/backups/git"
            : mode === "local archive"
              ? "/backups/archive-252.tar.gz"
              : "occasional",
        latest: expect.objectContaining({ createdAt: 252, status: "ok" }),
        latestOk: expect.objectContaining({ createdAt: 252, status: "ok" }),
      });
      expect(targets.find((entry) => entry.namespace === "occasional")).toMatchObject({
        kind: "archive",
        target: "occasional",
        latest: expect.objectContaining({ createdAt: 2, status: "failed" }),
        latestOk: expect.objectContaining({ createdAt: 1, status: "ok" }),
      });
      const rows = withExistingOpenClawStateDatabaseReadOnly(
        ({ db }) =>
          db
            .prepare(
              "SELECT created_at, status, manifest_json FROM backup_runs ORDER BY created_at ASC",
            )
            .all() as Array<{ created_at: number; status: string; manifest_json: string }>,
        { env },
      );
      expect(rows).toHaveLength(202);
      expect(rows?.slice(0, 3).map((row) => row.created_at)).toEqual([1, 2, 53]);
      expect(rows?.at(-1)).toMatchObject({ created_at: 252, status: "ok" });
      await recordBackupRunOutcome({
        env,
        ...frequentRun(253),
        status: "failed",
        createdAt: 253,
      });
      expect(await readBackupRunFreshness(env)).toMatchObject({
        latest: { createdAt: 253, status: "failed" },
        latestOk: { createdAt: 252, status: "ok" },
      });
    },
  );

  it("treats an older same-version database without backup_runs as no recorded backups", async () => {
    const env = await testEnv({ bootstrap: true });
    withExistingOpenClawStateDatabaseReadOnly(() => undefined, { env });
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(resolveOpenClawStateSqlitePath(env));
    raw.exec("DROP TABLE backup_runs");
    raw.close();
    expect(await readBackupRunFreshness(env)).toEqual({});
  });

  it("keeps absent status reads read-only and formats none, failed, fresh, and stale states", async () => {
    const env = await testEnv();
    const realpath = vi.spyOn(fsSync.realpathSync, "native").mockImplementation(() => {
      throw new Error("Scratch discovery must not canonicalize an absent ledger");
    });
    await expect(readBackupArchiveDirectories(env)).resolves.toEqual([]);
    expect(realpath).not.toHaveBeenCalled();
    realpath.mockRestore();
    await recordBackupRunOutcome({
      env,
      archivePath: "/backups/failed.tar.gz",
      kind: "archive",
      status: "failed",
    });
    expect(await readBackupRunFreshness(env)).toEqual({});
    await expect(fs.access(resolveOpenClawStateSqlitePath(env))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const formatTimeAgo = (ageMs: number) => `${ageMs / 3_600_000}h ago`;
    expect(buildBackupStatusValue({ freshness: {}, now: 10, formatTimeAgo })).toBe("none recorded");
    const failed = {
      id: "failed",
      createdAt: 1,
      archivePath: "/backup",
      status: "failed" as const,
      kind: "archive" as const,
    };
    expect(
      buildBackupStatusValue({
        freshness: { latest: failed },
        now: 3 * 24 * 3_600_000 + 1,
        formatTimeAgo,
      }),
    ).toBe("last attempt failed 72h ago (archive)");
    await noteBackupDoctorHint(env);
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("No successful backup is recorded."),
      "Backups",
    );

    // Recording is non-creating; bootstrap the state database before the
    // recording phase the way a real gateway host already has.
    runOpenClawStateWriteTransaction(() => undefined, { env });
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    await recordBackupRunOutcome({
      env,
      archivePath: "/backup",
      status: "ok",
      kind: "git",
      createdAt: 1,
    });
    mocks.note.mockClear();
    await noteBackupDoctorHint(env);
    expect(mocks.note).not.toHaveBeenCalled();

    vi.mocked(Date.now).mockReturnValue(1 + 15 * 24 * 3_600_000);
    await noteBackupDoctorHint(env);
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining("more than 14 days old"),
      "Backups",
    );

    await recordBackupRunOutcome({
      env,
      archivePath: "/backups/git",
      status: "ok",
      kind: "git",
      pushFailed: true,
      error: `${"x".repeat(1_199)}😀tail`,
      createdAt: 2,
    });
    const pushFailed = await readBackupRunFreshness(env);
    expect(pushFailed.latest?.error).toBe("x".repeat(1_199));
    expect(
      buildBackupStatusValue({
        freshness: pushFailed,
        now: 3_600_002,
        formatTimeAgo,
      }),
    ).toBe("last ok 1h ago (git, push failing)");
    mocks.note.mockClear();
    vi.mocked(Date.now).mockReturnValue(3_600_002);
    await noteBackupDoctorHint(env);
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringMatching(/configured Git remote.*\/backups\/git/su),
      "Backups",
    );
  });
});
