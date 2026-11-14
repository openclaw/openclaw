import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { assessInitialUpdateSnapshotCapacity } from "./update-candidate-snapshot.js";
import { discoverUpdateStateSchemaInspectionInProcess } from "./update-candidate-state.js";
import { createUpdateDatabaseBackupInProcess } from "./update-database-backup.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

async function fixture(sharedLargest = false, wal = false) {
  const root = await fs.realpath(dirs.make("update-backup-space-"));
  const stateDir = path.join(root, "state");
  const shared = path.join(stateDir, "state/openclaw.sqlite");
  const agent = path.join(stateDir, "agents/main/agent/openclaw-agent.sqlite");
  const backupRoot = path.join(root, "backup");
  const stagingRoot = path.join(root, "scratch");
  const directory = `${backupRoot}.databases`;
  for (const dir of [path.dirname(shared), path.dirname(agent), directory, stagingRoot]) {
    await fs.mkdir(dir, { recursive: true });
  }
  for (const file of [shared, agent]) {
    const size = (file === shared) === sharedLargest ? 4 * 1024 ** 2 : 1;
    const db = new DatabaseSync(file);
    let retained: Buffer[] | undefined;
    try {
      if (wal && file === agent) {
        db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
      }
      db.exec("PRAGMA user_version=17; CREATE TABLE witness(value BLOB)");
      db.prepare("INSERT INTO witness(rowid,value) VALUES(42,zeroblob(?))").run(size);
      if (wal && file === agent) {
        retained = await Promise.all(
          [file, `${file}-wal`, `${file}-shm`].map((p) => fs.readFile(p)),
        );
      }
    } finally {
      db.close();
    }
    if (retained) {
      await Promise.all(
        [file, `${file}-wal`, `${file}-shm`].map((p, i) => fs.writeFile(p, retained[i]!)),
      );
    }
  }
  const files = [shared, agent, ...(wal ? [`${agent}-wal`, `${agent}-shm`] : [])];
  const artifacts = async () =>
    Promise.all(
      files.map(async (file) => ({
        sha256: createHash("sha256")
          .update(await fs.readFile(file))
          .digest("hex"),
        mtimeNs: (await fs.stat(file, { bigint: true })).mtimeNs,
      })),
    );
  const before = await artifacts();
  const input = { stateDir, backupRoot, stagingRoot, config: {}, env: {} };
  const inspectionPlan = await discoverUpdateStateSchemaInspectionInProcess(input);
  return {
    ...input,
    shared,
    agent,
    directory,
    inspectionPlan,
    unchanged: async () => expect(await artifacts()).toEqual(before),
  };
}

it.each([false, true])(
  "admits and captures a large agent without charging it for shared history (WAL=%s)",
  async (wal) => {
    const f = await fixture(false, wal);
    const statfs = fsSync.statfsSync;
    // The candidate needs about 72 MiB; activation fits within 74 MiB. The old
    // stacked scratch allowances for this agent required more than 80 MiB.
    vi.spyOn(fsSync, "statfsSync").mockImplementation((...args) =>
      Object.assign(statfs(...args), {
        bsize: 1,
        bavail: 74 * 1024 ** 2,
      }),
    );
    const preflight = await assessInitialUpdateSnapshotCapacity({
      ...f,
      backupDirectory: f.directory,
    });
    expect(preflight.exitCode, preflight.stderrTail ?? undefined).toBe(0);
    await f.unchanged();
    const backup = await createUpdateDatabaseBackupInProcess({ ...f, stopped: true });
    expect(backup.databases).toHaveLength(2);
    for (const entry of backup.databases) {
      for (const file of [entry.path, entry.snapshotPath]) {
        using db = new DatabaseSync(file, { readOnly: true });
        expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 17 });
        expect(db.prepare("SELECT rowid,length(value) AS bytes FROM witness").get()).toEqual({
          rowid: 42,
          bytes: entry.path === f.agent ? 4 * 1024 ** 2 : 1,
        });
        expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      }
    }
    if (!wal) {
      await f.unchanged();
    }
  },
);

it.each([
  { freeMiB: 71, sharedLargest: false, postgres: false, wal: true },
  { freeMiB: 82, sharedLargest: true, postgres: false, wal: false },
  { freeMiB: 82, sharedLargest: false, postgres: true, wal: false },
])(
  "refuses insufficient activation space before capture ($freeMiB MiB, sharedLargest=$sharedLargest, postgres=$postgres, WAL=$wal)",
  async ({ freeMiB, sharedLargest, postgres, wal }) => {
    const f = await fixture(sharedLargest, wal);
    const config = postgres ? { database: { engine: "postgres" as const } } : {};
    const statfs = fsSync.statfsSync;
    let availableMiB = wal ? 74 : freeMiB;
    vi.spyOn(fsSync, "statfsSync").mockImplementation((...args) =>
      Object.assign(statfs(...args), {
        bsize: 1,
        bavail: availableMiB * 1024 ** 2,
      }),
    );
    const preflight = await assessInitialUpdateSnapshotCapacity({
      ...f,
      config,
      backupDirectory: f.directory,
    });
    expect(preflight.exitCode).toBe(wal ? 0 : 1);
    if (!wal) {
      expect(preflight.stderrTail).toContain("snapshot-capacity-insufficient");
    }
    await f.unchanged();
    // Preflight reserves no space: admission must precede even a WAL checkpoint.
    availableMiB = freeMiB;
    await expect(
      createUpdateDatabaseBackupInProcess({ ...f, config, stopped: true }),
    ).rejects.toMatchObject({ name: "UpdateCaptureSpaceError" });
    expect(await fs.readdir(f.directory)).toEqual([]);
    await f.unchanged();
  },
);
