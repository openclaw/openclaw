import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { prepareDoctorHealthDatabaseBackups } from "../flows/doctor-health-database-backup.js";
import * as directoryDurability from "../infra/directory-durability.js";
import * as sqliteSnapshot from "../infra/sqlite-snapshot.js";
import { prepareAgentDatabaseMigrationDiscovery } from "../infra/state-migrations.media-persistence-targets.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { withEnvAsync } from "../test-utils/env.js";
import * as version from "../version.js";
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

  it("preserves the whole rollback group when verified coverage omits a current-schema agent", async () => {
    const fixture = createFixture();
    fs.unlinkSync(fixture.shared);
    const currentAgent = path.join(
      fixture.env.OPENCLAW_STATE_DIR,
      "agents",
      "current",
      "agent",
      "openclaw-agent.sqlite",
    );
    seedDatabase(currentAgent, "current agent before repair");
    const current = new DatabaseSync(currentAgent);
    current.exec("PRAGMA user_version = 24");
    current.close();
    const priorSnapshot = `${fixture.agent}.verified.bak`;
    await sqliteSnapshot.createVerifiedSqliteSnapshot({
      sourcePath: fixture.agent,
      targetPath: priorSnapshot,
    });
    const { dev, ino } = fs.statSync(fixture.agent);
    const targets = [
      { agentId: "main", path: fixture.agent },
      { agentId: "current", path: currentAgent },
    ];
    const maintenance = createOpenClawDatabaseMaintenanceScope({
      schemaMaintenance: true,
      assertOwnerCurrent: () => {},
    });
    try {
      await withEnvAsync({ OPENCLAW_STATE_DIR: fixture.env.OPENCLAW_STATE_DIR }, () =>
        maintenance.run(() =>
          prepareDoctorHealthDatabaseBackups({
            automaticHeartbeatRepair: false,
            schemas: {
              incompatible: [],
              indeterminate: [],
              pendingMigrations: [
                { kind: "agent", ...targets[0]!, foundVersion: 1, supportedVersion: 24 },
              ],
              agentDatabaseMigrationDiscovery: prepareAgentDatabaseMigrationDiscovery({
                env: fixture.env,
                configuredAgentDatabaseTargets: targets,
                registeredAgentDatabases: [],
                deletionJournal: { status: "empty" },
              }),
            },
            verifiedSnapshots: [
              { role: "agent", agentId: "main", sourcePath: fixture.agent, dev, ino },
            ],
            runtime: { log() {} },
          }),
        ),
      );
      expect(listBackups(currentAgent)).toHaveLength(1);
      expect(readPreservedValue(listBackups(currentAgent)[0]!)).toBe("current agent before repair");
      expect(readPreservedValue(priorSnapshot)).toBe("agent before migration");
      expect(fs.existsSync(fixture.shared)).toBe(false);
    } finally {
      await maintenance.close();
    }
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
    for (let attempt = 0; attempt < 4; attempt++) {
      await backup(fixture, [secondAgent], inventory.toReversed());
    }

    expect([fixture.shared, ...inventory].flatMap(listBackups).toSorted()).toEqual(
      originals.toSorted(),
    );
    expect(readPreservedValue(listBackups(fixture.agent)[0]!)).toBe("agent before migration");
    expect(readPreservedValue(listBackups(fixture.shared)[0]!)).toBe("shared before migration");
    expect(readPreservedValue(fixture.agent)).toBe("partially migrated");
  });

  it.each(["missing-agent", "corrupt-agent", "symlink-agent", "missing-shared"] as const)(
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
      if (damage === "corrupt-agent") {
        fs.writeFileSync(damaged, "not a SQLite snapshot");
      } else {
        fs.unlinkSync(damaged);
        if (damage === "symlink-agent") {
          fs.symlinkSync(fixture.agent, damaged);
        }
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

  it.each(["added", "replaced"] as const)(
    "starts a new coherent group for a database that was %s without removing older backups",
    async (change) => {
      const fixture = createFixture();
      await backup(fixture);
      const originalSharedBackup = listBackups(fixture.shared)[0]!;
      const legacyBackup = `${fixture.shared}.pre-startup-migration-legacy-operator-copy.bak`;
      fs.copyFileSync(originalSharedBackup, legacyBackup);
      const originalBytes = fs.readFileSync(legacyBackup);
      const newAgent = path.join(path.dirname(fixture.agent), "replacement.sqlite");
      seedDatabase(newAgent, "new agent history");
      if (change === "replaced") {
        fs.renameSync(newAgent, fixture.agent);
      }
      const currentAgent = change === "replaced" ? fixture.agent : newAgent;
      const inventory = change === "replaced" ? [fixture.agent] : [fixture.agent, newAgent];
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
    },
  );

  it("captures current state for a new candidate build with unchanged database identities and schemas", async () => {
    const fixture = createFixture();
    await backup(fixture);
    const sources = [fixture.agent, fixture.shared];
    const originalBackups = sources.map((source) => listBackups(source)[0]!);
    const originalBytes = originalBackups.map((snapshot) => fs.readFileSync(snapshot));
    for (const source of sources) {
      const database = new DatabaseSync(source);
      try {
        database.exec("UPDATE preserved SET value = 'next build history';");
      } finally {
        database.close();
      }
    }
    const build = vi
      .spyOn(version, "resolveRuntimeServiceBuildId")
      .mockReturnValue("migration-backup-next-build");
    try {
      await backup(fixture);
      await backup(fixture);
    } finally {
      build.mockRestore();
    }

    const newBackups = sources.flatMap((source) => {
      const backups = listBackups(source);
      expect(backups).toHaveLength(2);
      return backups.filter((snapshot) => !originalBackups.includes(snapshot));
    });
    expect(new Set(newBackups.map((name) => name.split(".pre-startup-migration-")[1])).size).toBe(
      1,
    );
    expect(newBackups.map(readPreservedValue)).toEqual([
      "next build history",
      "next build history",
    ]);
    expect(originalBackups.map((snapshot) => fs.readFileSync(snapshot))).toEqual(originalBytes);
  });
});
