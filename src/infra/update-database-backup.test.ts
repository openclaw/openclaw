import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as diskSpace from "./disk-space.js";
import { discoverUpdateStateSchemaInspectionInProcess } from "./update-candidate-state.js";
import { createUpdateDatabaseBackupInProcess } from "./update-database-backup.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
});

async function fixture(externalAgents = false) {
  const root = await fs.realpath(dirs.make("update-database-backup-preflight-"));
  const stateDir = path.join(root, "state");
  const shared = path.join(stateDir, "state/openclaw.sqlite");
  const backupRoot = path.join(root, "retained-package");
  const directory = `${backupRoot}.databases`;
  const stagingRoot = path.join(root, "scratch");
  const external = externalAgents
    ? [path.join(root, "external-a/agent.sqlite"), path.join(root, "external-b/agent.sqlite")]
    : [];
  for (const parent of [
    path.dirname(shared),
    directory,
    stagingRoot,
    ...external.map((file) => path.dirname(file)),
  ]) {
    await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  }
  for (const file of [shared, ...external]) {
    const db = new DatabaseSync(file);
    try {
      db.exec(
        "PRAGMA user_version=17; CREATE TABLE payload(value TEXT); INSERT INTO payload(rowid,value) VALUES(42,'retained');",
      );
      if (file === shared) {
        db.exec("CREATE TABLE agent_databases(path TEXT)");
        for (const agent of external) {
          db.prepare("INSERT INTO agent_databases VALUES (?)").run(agent);
        }
      } else {
        db.exec(
          "CREATE TABLE schema_meta(meta_key TEXT, role TEXT, agent_id TEXT); INSERT INTO schema_meta VALUES ('primary','agent','main');",
        );
        db.prepare("UPDATE payload SET value = ?").run(path.basename(path.dirname(file)));
      }
    } finally {
      db.close();
    }
  }
  const input = { backupRoot, stateDir, config: {}, env: {}, stagingRoot };
  const inspectionPlan = await discoverUpdateStateSchemaInspectionInProcess(input);
  return {
    root,
    shared,
    directory,
    external,
    capture: () => createUpdateDatabaseBackupInProcess({ ...input, inspectionPlan }),
  };
}

it.each(["", "-wal", "-shm", "-journal"])(
  "refuses a hard-linked database family file %s before publishing any rollback snapshot",
  async (suffix) => {
    const f = await fixture();
    const source = `${f.shared}${suffix}`;
    if (suffix) {
      await fs.writeFile(source, "");
    }
    const alias = path.join(f.root, "outside-alias");
    await fs.link(source, alias);
    expect((await fs.lstat(source)).nlink).toBe(2);
    const before = await fs.readFile(f.shared);

    await expect(f.capture()).rejects.toThrow(
      `Update database rollback requires a regular file with one link: ${source}`,
    );

    expect(await fs.readdir(f.directory)).toEqual([]);
    expect(await fs.readFile(f.shared)).toEqual(before);
    expect((await fs.lstat(alias)).ino).toBe((await fs.lstat(source)).ino);
  },
);

it.each(["insufficient", "unknown"] as const)(
  "preflights a separate source volume whose available capacity is %s",
  async (capacity) => {
    const f = await fixture(true);
    const externalDirectories = f.external.map((file) => path.dirname(file));
    const sizes = await Promise.all(f.external.map(async (file) => (await fs.stat(file)).size));
    const largest = Math.max(...sizes);
    const headroom = 64 * 1024 * 1024;
    // Enough for either agent separately; insufficient for both retained originals plus publication.
    const available = headroom + 2 * largest;
    expect(available).toBeLessThan(
      headroom + sizes.reduce((total, size) => total + size, 0) + largest,
    );
    const stat = fs.stat;
    const backupDevice = (await stat(f.directory, { bigint: true })).dev;
    const deviceQueries = new Set(externalDirectories);
    vi.spyOn(fs, "stat").mockImplementation(async (...args) => {
      const info = await stat(...args);
      // Only the volume inventory sees synthetic device identities; native file publication stays real.
      if (deviceQueries.delete(String(args[0]))) {
        assert(info, "Fixture source volume must exist");
        Object.defineProperty(info, "dev", {
          value: typeof info.dev === "bigint" ? backupDevice + 1n : Number(backupDevice + 1n),
        });
      }
      return info;
    });
    vi.spyOn(diskSpace, "tryReadDiskSpace").mockImplementation((targetPath) => {
      const external = externalDirectories.includes(targetPath);
      if (external && capacity === "unknown") {
        return null;
      }
      return {
        targetPath,
        checkedPath: targetPath,
        availableBytes: external ? available : 1024 * 1024 * 1024,
        totalBytes: 2 * 1024 * 1024 * 1024,
      };
    });
    const originals = await Promise.all([f.shared, ...f.external].map((file) => fs.readFile(file)));
    if (capacity === "insufficient") {
      await expect(f.capture()).rejects.toThrow(`near ${externalDirectories[0]}`);
      expect(await fs.readdir(f.directory)).toEqual([]);
    } else {
      const backup = await f.capture();
      expect(backup.databases.map((entry) => entry.path).toSorted()).toEqual(
        [f.shared, ...f.external].toSorted(),
      );
      expect(backup.warnings).toContain(
        `Available disk space could not be measured near ${externalDirectories[0]}; database backup will be attempted.`,
      );
      const retainedAgentFiles = (await fs.readdir(backup.directory, { recursive: true }))
        .filter((file) => file.endsWith("agent.sqlite"))
        .toSorted();
      expect(retainedAgentFiles).toEqual([
        expect.stringMatching(/[\\/]external-a[\\/]agent\.sqlite$/u),
        expect.stringMatching(/[\\/]external-b[\\/]agent\.sqlite$/u),
      ]);
      for (const entry of backup.databases) {
        const db = new DatabaseSync(entry.snapshotPath, { readOnly: true });
        try {
          expect(db.prepare("SELECT rowid,value FROM payload").all()).toEqual([
            {
              rowid: 42,
              value: entry.path === f.shared ? "retained" : path.basename(path.dirname(entry.path)),
            },
          ]);
          if (entry.path !== f.shared) {
            expect(db.prepare("SELECT agent_id FROM schema_meta").get()).toEqual({
              agent_id: "main",
            });
          }
        } finally {
          db.close();
        }
      }
    }
    expect(await Promise.all([f.shared, ...f.external].map((file) => fs.readFile(file)))).toEqual(
      originals,
    );
  },
);
