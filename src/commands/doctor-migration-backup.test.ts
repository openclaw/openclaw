import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as sqliteVec from "../../packages/memory-host-sdk/src/host/sqlite-vec.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as directoryDurability from "../infra/directory-durability.js";
import * as sqliteSnapshot from "../infra/sqlite-snapshot.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { backupDoctorMigrationDatabases } from "./doctor-migration-backup.js";
import { inspectSessionSqliteRecovery } from "./doctor-session-sqlite-recovery-inventory.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function seedDatabase(databasePath: string, value: string) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("PRAGMA user_version = 1; CREATE TABLE preserved (value TEXT NOT NULL);");
    database.prepare("INSERT INTO preserved VALUES (?)").run(value);
  } finally {
    database.close();
  }
}

function readPreservedValue(databasePath: string) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database.prepare("SELECT value FROM preserved").get()?.value;
  } finally {
    database.close();
  }
}

function listBackups(databasePath: string) {
  return fs
    .readdirSync(path.dirname(databasePath))
    .filter(
      (name) =>
        name.startsWith(`${path.basename(databasePath)}.pre-startup-migration-`) &&
        name.endsWith(".bak"),
    )
    .map((name) => path.join(path.dirname(databasePath), name));
}

function createFixture() {
  const stateDir = tempDirs.make("openclaw-doctor-backup-");
  const shared = path.join(stateDir, "state", "openclaw.sqlite");
  const agent = path.join(stateDir, "agents", "main", "openclaw-agent.sqlite");
  seedDatabase(shared, "shared before migration");
  seedDatabase(agent, "agent before migration");
  return { shared, agent, env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
}

async function backup(
  fixture: ReturnType<typeof createFixture>,
  pendingDatabasePaths = [fixture.agent],
  databasePaths = [fixture.agent],
) {
  const maintenance = createOpenClawDatabaseMaintenanceScope({
    schemaMaintenance: true,
    assertOwnerCurrent: () => {},
  });
  try {
    return await maintenance.run(() =>
      backupDoctorMigrationDatabases({ env: fixture.env, pendingDatabasePaths, databasePaths }),
    );
  } finally {
    await maintenance.close();
  }
}

describe("Doctor migration backup retries", () => {
  it("backs up the full inventory when only the shared database has a pending migration", async () => {
    const fixture = createFixture();
    await backup(fixture, [fixture.shared]);
    expect(listBackups(fixture.shared)).toHaveLength(1);
    expect(listBackups(fixture.agent)).toHaveLength(1);
    expect(readPreservedValue(listBackups(fixture.agent)[0]!)).toBe("agent before migration");
    const preview = inspectSessionSqliteRecovery({ cfg: {}, env: fixture.env });
    expect(preview.artifacts).toHaveLength(2);
    expect(preview.artifacts).toEqual(
      expect.arrayContaining(
        [fixture.shared, fixture.agent].map((database) =>
          expect.objectContaining({
            path: listBackups(database)[0],
            outcome: "protected",
            reason: "incomplete-recovery-operation",
          }),
        ),
      ),
    );
  });

  it("does not reuse a completed group until capture-marker removal is durable", async () => {
    const fixture = createFixture();
    const syncDirectory = directoryDurability.syncDirectorySync;
    const sync = vi
      .spyOn(directoryDurability, "syncDirectorySync")
      .mockImplementationOnce(syncDirectory)
      .mockImplementationOnce(() => {
        throw new Error("capture completion sync failed");
      })
      .mockImplementationOnce(() => {
        throw new Error("capture completion sync failed");
      });
    try {
      await expect(backup(fixture)).rejects.toThrow("capture completion sync failed");
      await expect(backup(fixture)).rejects.toThrow("capture completion sync failed");
    } finally {
      sync.mockRestore();
    }
    const originals = [fixture.agent, fixture.shared].flatMap(listBackups);
    await backup(fixture);
    expect([fixture.agent, fixture.shared].flatMap(listBackups)).toEqual(originals);
  });

  it("recaptures the entire incomplete group after interruption and intervening writes", async () => {
    const fixture = createFixture();
    const originalCreateSnapshot = sqliteSnapshot.createVerifiedSqliteSnapshot;
    const createSnapshot = vi
      .spyOn(sqliteSnapshot, "createVerifiedSqliteSnapshot")
      .mockImplementationOnce(originalCreateSnapshot)
      .mockRejectedValueOnce(new Error("interrupted backup"));
    try {
      await expect(backup(fixture)).rejects.toThrow("interrupted backup");
    } finally {
      createSnapshot.mockRestore();
    }
    expect(listBackups(fixture.agent)).toHaveLength(1);
    expect(listBackups(fixture.shared)).toHaveLength(0);
    for (const source of [fixture.agent, fixture.shared]) {
      const database = new DatabaseSync(source);
      try {
        database.exec("UPDATE preserved SET value = 'after interruption';");
      } finally {
        database.close();
      }
    }
    await backup(fixture);
    for (const source of [fixture.agent, fixture.shared]) {
      const backups = listBackups(source);
      expect(backups).toHaveLength(1);
      expect(readPreservedValue(backups[0]!)).toBe("after interruption");
    }
  });

  it("reuses the original rollback group after partial migration and repeated retries", async () => {
    const fixture = createFixture();
    const secondAgent = path.join(path.dirname(fixture.agent), "second.sqlite");
    seedDatabase(secondAgent, "second before migration");
    const inventory = [fixture.agent, secondAgent];
    await backup(fixture, inventory, inventory);
    const originals = [fixture.shared, ...inventory].map((source) => listBackups(source)[0]!);
    expect(new Set(originals.map((name) => name.split(".pre-startup-migration-")[1])).size).toBe(1);

    const migrated = new DatabaseSync(fixture.agent);
    try {
      migrated.exec("PRAGMA user_version = 24; UPDATE preserved SET value = 'partially migrated';");
    } finally {
      migrated.close();
    }
    const load = vi
      .spyOn(sqliteVec, "loadSqliteVecExtension")
      .mockRejectedValue(new Error("sqlite-vec cannot load on this CPU"));
    try {
      for (let attempt = 0; attempt < 4; attempt++) {
        await backup(fixture, [secondAgent], inventory.toReversed());
      }
      expect(load).not.toHaveBeenCalled();
    } finally {
      load.mockRestore();
    }

    expect([fixture.shared, ...inventory].flatMap(listBackups).toSorted()).toEqual(
      originals.toSorted(),
    );
    expect(readPreservedValue(listBackups(fixture.agent)[0]!)).toBe("agent before migration");
    expect(readPreservedValue(listBackups(fixture.shared)[0]!)).toBe("shared before migration");
    expect(readPreservedValue(fixture.agent)).toBe("partially migrated");
  });

  it.each(["symlink-agent", "missing-shared"] as const)(
    "preserves a completed rollback group when %s damage is discovered after partial migration",
    async (damage) => {
      const fixture = createFixture();
      const secondAgent = path.join(path.dirname(fixture.agent), "second.sqlite");
      seedDatabase(secondAgent, "second before migration");
      const inventory = [fixture.agent, secondAgent];
      await backup(fixture, inventory, inventory);
      const originalAgent = listBackups(fixture.agent)[0]!;
      const originalShared = listBackups(fixture.shared)[0]!;
      const originalSecond = listBackups(secondAgent)[0]!;
      const originalBytes = fs.readFileSync(originalSecond);
      const migrated = new DatabaseSync(fixture.agent);
      try {
        migrated.exec(
          "PRAGMA user_version = 24; UPDATE preserved SET value = 'partially migrated';",
        );
      } finally {
        migrated.close();
      }
      const damaged = damage === "missing-shared" ? originalShared : originalAgent;
      fs.unlinkSync(damaged);
      if (damage === "symlink-agent") {
        fs.symlinkSync(fixture.agent, damaged);
      }
      const remaining = [fixture.shared, ...inventory].flatMap(listBackups);

      await expect(backup(fixture, [secondAgent], inventory)).rejects.toMatchObject({
        refusal: { kind: "data-at-risk", reason: "incomplete-migration" },
      });
      expect([fixture.shared, ...inventory].flatMap(listBackups)).toEqual(remaining);
      expect(fs.readFileSync(originalSecond)).toEqual(originalBytes);
      expect(readPreservedValue(fixture.agent)).toBe("partially migrated");
      if (damage === "missing-shared") {
        expect(readPreservedValue(originalAgent)).toBe("agent before migration");
      }
    },
  );

  it("starts a new coherent group for a replaced database without removing older backups", async () => {
    const fixture = createFixture();
    await backup(fixture);
    const originalSharedBackup = listBackups(fixture.shared)[0]!;
    const legacyBackup = `${fixture.shared}.pre-startup-migration-legacy-operator-copy.bak`;
    fs.copyFileSync(originalSharedBackup, legacyBackup);
    const originalBytes = fs.readFileSync(legacyBackup);
    const newAgent = path.join(path.dirname(fixture.agent), "replacement.sqlite");
    seedDatabase(newAgent, "new agent history");
    fs.renameSync(newAgent, fixture.agent);
    const currentAgent = fixture.agent;
    const inventory = [fixture.agent];
    await backup(fixture, [currentAgent], inventory);
    await backup(fixture, [currentAgent], inventory);

    const newSharedBackups = listBackups(fixture.shared).filter(
      (pathname) => pathname !== originalSharedBackup && pathname !== legacyBackup,
    );
    expect(newSharedBackups).toHaveLength(1);
    const newId = newSharedBackups[0]!.split(".pre-startup-migration-")[1];
    const currentBackup = listBackups(currentAgent).find((pathname) => pathname.endsWith(newId!));
    expect(currentBackup).toBeDefined();
    expect(readPreservedValue(currentBackup!)).toBe("new agent history");
    expect(fs.readFileSync(legacyBackup)).toEqual(originalBytes);
    expect(fs.existsSync(originalSharedBackup)).toBe(true);
  });
});
