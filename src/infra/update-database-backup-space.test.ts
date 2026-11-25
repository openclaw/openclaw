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

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
// NTFS extends a truncated file with written zeros, not a sparse tail.
const sparse = it.skipIf(process.platform === "win32");

/** Two SQLite families; `sharedBytes` extends the shared file sparsely, as SQLite allows. */
async function fixture({
  sharedBytes,
  agentBlob = 1,
}: {
  sharedBytes?: number;
  agentBlob?: number;
}) {
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
  for (const [file, size] of [
    [shared, 1],
    [agent, agentBlob],
  ] as const) {
    using db = new DatabaseSync(file);
    db.exec("PRAGMA user_version=17; CREATE TABLE witness(value BLOB)");
    db.prepare("INSERT INTO witness(rowid,value) VALUES(42,zeroblob(?))").run(size);
  }
  if (sharedBytes) {
    // The header's page count still wins, so the database stays valid.
    await fs.truncate(shared, sharedBytes);
  }
  const files = [shared, agent];
  const artifacts = async () =>
    Promise.all(
      files.map(async (file) => ({
        sha256: createHash("sha256")
          .update(await fs.readFile(file))
          .digest("hex"),
        mtimeNs: (await fs.stat(file, { bigint: true })).mtimeNs,
      })),
    );
  // A sparse 20 GiB file is never hashed; only real-content fixtures compare bytes.
  const before = sharedBytes ? undefined : await artifacts();
  const input = { stateDir, backupRoot, stagingRoot, config: {}, env: {} };
  return {
    ...input,
    shared,
    agent,
    directory,
    inspectionPlan: await discoverUpdateStateSchemaInspectionInProcess(input),
    unchanged: async () => {
      expect(before).toBeDefined();
      expect(await artifacts()).toEqual(before);
    },
  };
}

function freeSpace(bytes: () => number) {
  const statfs = fsSync.statfsSync;
  vi.spyOn(fsSync, "statfsSync").mockImplementation((...args) =>
    Object.assign(statfs(...args), { bsize: 1, bavail: bytes() }),
  );
}

sparse(
  "continues past a pre-migration image that does not fit and names what it gives up",
  async () => {
    // A 20 GiB shared database with 35 GiB free: the former 5x preflight wanted 100 GiB.
    const f = await fixture({ sharedBytes: 20 * GiB });
    freeSpace(() => 35 * GiB);

    const { step, shortfall } = await assessInitialUpdateSnapshotCapacity({
      ...f,
      backupDirectory: f.directory,
    });

    expect(step.exitCode, step.stderrTail ?? undefined).toBe(0);
    expect(shortfall).toBe(true);
    expect(step.warnings).toEqual([
      `No pre-migration database image: it needs 40 GiB near ${f.directory} and 35 GiB is free. Without it, the previous version cannot be restored once the new version's database migration commits; a failed update then stays on the new version and is fixed forward. The update continues and measures the image again before the migration.`,
    ]);
  },
);

sparse("refuses only when the migration itself has no room, saying how much to free", async () => {
  const f = await fixture({ sharedBytes: 20 * GiB });
  freeSpace(() => 10 * GiB);

  const { step, shortfall } = await assessInitialUpdateSnapshotCapacity({
    ...f,
    backupDirectory: f.directory,
  });

  expect(step.exitCode).toBe(1);
  expect(shortfall).toBe(true);
  expect(step.stderrTail?.split("\n")[0]).toBe(
    `Update refused: A database migration may need up to 20 GiB (${20 * GiB + 64 * MiB} bytes) of free space near ${path.dirname(f.shared)} for its write-ahead log, but only 10 GiB (${10 * GiB} bytes) is available. Free at least 10 GiB (${10 * GiB + 64 * MiB} bytes) on that volume, then run openclaw update again; nothing has changed.`,
  );
});

sparse("keeps the image when it fits beside the migration", async () => {
  const f = await fixture({ sharedBytes: 20 * GiB });
  freeSpace(() => 41 * GiB);

  const { step, shortfall } = await assessInitialUpdateSnapshotCapacity({
    ...f,
    backupDirectory: f.directory,
  });

  expect({ exitCode: step.exitCode, shortfall, warnings: step.warnings }).toEqual({
    exitCode: 0,
    shortfall: false,
    warnings: undefined,
  });
});

it("admits a capture by what it writes and refuses it before any checkpoint or copy", async () => {
  // About 4 MiB of agent: the image plus the larger of one family of staging and the migration's room.
  const f = await fixture({ agentBlob: 4 * MiB });
  let available = 70 * MiB;
  freeSpace(() => available);

  await expect(createUpdateDatabaseBackupInProcess({ ...f, stopped: true })).rejects.toMatchObject({
    name: "UpdateCaptureSpaceError",
  });
  expect(await fs.readdir(f.directory)).toEqual([]);
  await f.unchanged();

  available = 80 * MiB;
  const backup = await createUpdateDatabaseBackupInProcess({ ...f, stopped: true });
  expect(backup.databases.map((entry) => entry.path).toSorted()).toEqual(
    [f.agent, f.shared].toSorted(),
  );
  for (const entry of backup.databases) {
    using db = new DatabaseSync(entry.snapshotPath, { readOnly: true });
    expect(db.prepare("SELECT rowid,length(value) AS bytes FROM witness").get()).toEqual({
      rowid: 42,
      bytes: entry.path === f.agent ? 4 * MiB : 1,
    });
    expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  }
  await f.unchanged();
});
