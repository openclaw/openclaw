import fs from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import * as sqlite from "../infra/node-sqlite.js";
import { AGENT_DATABASE_MAINTENANCE_LEASE } from "../state/openclaw-agent-db-lease.js";
import * as leaseOwner from "../state/openclaw-agent-db-maintenance-lease.js";
import * as agentMaintenance from "../state/openclaw-agent-db-maintenance.js";
import { invalidateRegisteredAgentDatabasesMemo } from "../state/openclaw-agent-db-registry-listing.js";
import * as agentDatabase from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { noteDoctorAgentMemorySchemaHealth } from "./doctor-agent-memory-schema.js";

const tempDirs: string[] = [];

function createRegisteredAgentDatabase() {
  const stateDir = makeTempDir(tempDirs, "doctor-agent-memory-schema-");
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const databasePath = agentDatabase.openOpenClawAgentDatabase({ agentId: "worker-1", env }).path;
  agentDatabase.closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  return { databasePath, env };
}

function recreateUnreleasedInlineMemoryMetadata(databasePath: string): void {
  using database = sqlite.openNodeSqliteDatabase(databasePath);
  database.exec("PRAGMA foreign_keys = OFF");
  database.exec(`
    DROP TABLE memory_index_chunk_recall_metadata;
    ALTER TABLE memory_index_chunks ADD COLUMN importance INTEGER
      CHECK (importance IS NULL OR importance BETWEEN 1 AND 10);
    CREATE TRIGGER memory_index_chunk_provenance_after_insert
    AFTER INSERT ON memory_index_chunks BEGIN
      INSERT OR IGNORE INTO memory_index_chunk_provenance (chunk_id, origin_class, session_kind, observed_at)
      VALUES (NEW.id, 'agent', 'unknown', NEW.updated_at);
    END;
    INSERT INTO memory_index_chunks
      (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at, importance)
    VALUES ('sentinel', 'MEMORY.md', 'memory', 1, 2, 'hash', 'model', 'sentinel text', X'', 42, 9);
  `);
  database.exec("PRAGMA foreign_keys = ON");
}

function readMemoryChunkColumns(databasePath: string): string[] {
  using database = sqlite.openNodeSqliteDatabase(databasePath, { readOnly: true });
  return database
    .prepare("PRAGMA table_info(memory_index_chunks)")
    .all()
    .map((row) => (row as { name: string }).name);
}

function repairMemory(env: NodeJS.ProcessEnv, shouldRepair = true, note = vi.fn()) {
  return noteDoctorAgentMemorySchemaHealth({ env, shouldRepair }, { note });
}

afterEach(() => {
  vi.restoreAllMocks();
  agentDatabase.closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  cleanupTempDirs(tempDirs);
});

it("removes a stale clean-close seal before failed writable repair while inspection preserves it", async () => {
  const { databasePath, env } = createRegisteredAgentDatabase();
  const sealPath = `${databasePath}.seal`;
  const staleSeal = fs.readFileSync(sealPath);
  recreateUnreleasedInlineMemoryMetadata(databasePath);
  // Model an external schema edit that leaves the prior clean-close marker behind.
  fs.writeFileSync(sealPath, staleSeal);
  await repairMemory(env, false);
  expect(fs.readFileSync(sealPath)).toEqual(staleSeal);

  const nativeOpen = sqlite.openNodeSqliteDatabase;
  let sealPresentBeforeOpen: boolean | undefined;
  vi.spyOn(sqlite, "openNodeSqliteDatabase").mockImplementation((pathname, options) => {
    if (pathname === databasePath && !options?.readOnly) {
      sealPresentBeforeOpen = fs.existsSync(sealPath);
      throw new Error("synthetic maintenance native open failed");
    }
    return nativeOpen(pathname, options);
  });
  const report = await repairMemory(env);
  expect(sealPresentBeforeOpen).toBe(false);
  expect(report.repaired).toEqual([]);
  expect(report.warnings.join(" ")).toContain("synthetic maintenance native open failed");
  expect(fs.existsSync(sealPath)).toBe(false);
});

it("blocks runtime admission until a lost Doctor repair releases maintenance", async () => {
  const { databasePath, env } = createRegisteredAgentDatabase();
  const laterOptions = { agentId: "worker-2", env };
  const laterPath = agentDatabase.openOpenClawAgentDatabase(laterOptions).path;
  agentDatabase.closeOpenClawAgentDatabasesForTest();
  recreateUnreleasedInlineMemoryMetadata(databasePath);
  recreateUnreleasedInlineMemoryMetadata(laterPath);
  const laterBefore = fs.readFileSync(laterPath);
  const startAdmission = createDeferred();
  // Register outside the old maintenance ALS scope: this is a new runtime owner.
  const newerAdmission = startAdmission.promise.then(() =>
    agentDatabase.withOpenClawAgentDatabaseAsync(laterOptions, (database) =>
      database.db.prepare("SELECT id, text FROM memory_index_chunks").all(),
    ),
  );
  void newerAdmission.catch(() => {});
  const open = sqlite.openNodeSqliteDatabase;
  const inspectedPaths: string[] = [];
  vi.spyOn(sqlite, "openNodeSqliteDatabase").mockImplementation((pathname, options) => {
    if (options?.readOnly) {
      inspectedPaths.push(pathname);
    }
    return open(pathname, options);
  });
  const close = vi.spyOn(agentDatabase, "closeOpenClawAgentDatabaseByPath");
  const migrate = agentMaintenance.migrateOpenClawAgentDatabaseForMaintenance;
  vi.spyOn(agentMaintenance, "migrateOpenClawAgentDatabaseForMaintenance").mockImplementationOnce(
    async (options, maintenance) => {
      await migrate(options, maintenance);
      const removed = openOpenClawStateDatabase({ env })
        .db.prepare("DELETE FROM state_leases WHERE scope = ? AND lease_key = ?")
        .run(AGENT_DATABASE_MAINTENANCE_LEASE.scope, AGENT_DATABASE_MAINTENANCE_LEASE.key);
      expect(removed.changes).toBe(1);
      // Earlier registry discovery may inspect targets while the lease is still valid.
      inspectedPaths.length = 0;
      close.mockClear();
      startAdmission.resolve();
      await newerAdmission.catch(() => {});
    },
  );
  try {
    await expect(repairMemory(env)).rejects.toThrow(/maintenance lease.*was lost/iu);
    expect(inspectedPaths).not.toContain(laterPath);
    expect(close.mock.calls.some(([pathname]) => pathname === laterPath)).toBe(false);
    await expect(newerAdmission).rejects.toThrow(
      "without an active schema lease or maintenance scope",
    );
    expect(fs.readFileSync(laterPath)).toEqual(laterBefore);
    await expect(
      agentDatabase.withOpenClawAgentDatabaseAsync(laterOptions, (database) =>
        database.db.prepare("SELECT id, text FROM memory_index_chunks").all(),
      ),
    ).resolves.toEqual([{ id: "sentinel", text: "sentinel text" }]);
  } finally {
    startAdmission.resolve();
    await newerAdmission.catch(() => {});
  }
});

it.each(["already-repaired", "new-repair", "before-doctor", "before-lease"])(
  "rediscovers memory repairs across maintenance acquisition: %s",
  async (change) => {
    const { databasePath, env } = createRegisteredAgentDatabase();
    const peerPath = agentDatabase.openOpenClawAgentDatabase({ agentId: "worker-2", env }).path;
    agentDatabase.closeOpenClawAgentDatabasesForTest();
    const peerRegistration = change === "before-doctor" || change === "before-lease";
    if (change !== "before-doctor") {
      recreateUnreleasedInlineMemoryMetadata(databasePath);
    }
    let publishPeer = () => {};
    if (peerRegistration) {
      recreateUnreleasedInlineMemoryMetadata(peerPath);
      const state = openOpenClawStateDatabase({ env });
      const row = state.db
        .prepare(
          "SELECT agent_id,path,schema_version,last_seen_at,size_bytes FROM agent_databases WHERE agent_id = ?",
        )
        .get("worker-2");
      if (!row) {
        throw new Error("missing peer fixture registration");
      }
      state.db.prepare("DELETE FROM agent_databases WHERE agent_id = ?").run("worker-2");
      invalidateRegisteredAgentDatabasesMemo({ env });
      expect(
        agentDatabase.listOpenClawRegisteredAgentDatabases({ env }).map((entry) => entry.agentId),
      ).toEqual(["worker-1"]);
      publishPeer = () => {
        // A peer commit does not invalidate this process's registry memo.
        using peer = sqlite.openNodeSqliteDatabase(state.path);
        peer
          .prepare(
            "INSERT INTO agent_databases(agent_id,path,schema_version,last_seen_at,size_bytes) VALUES(?,?,?,?,?)",
          )
          .run(...Object.values(row));
      };
    }
    const withLease = leaseOwner.withAgentDatabaseMaintenanceLease;
    vi.spyOn(leaseOwner, "withAgentDatabaseMaintenanceLease").mockImplementationOnce(
      (options, run) => {
        if (change === "before-lease") {
          publishPeer();
        }
        return withLease(options, async (maintenance) => {
          if (change === "already-repaired") {
            await agentMaintenance.migrateOpenClawAgentDatabaseForMaintenance(
              { agentId: "worker-1", pathname: databasePath },
              maintenance,
            );
          } else if (change === "new-repair") {
            recreateUnreleasedInlineMemoryMetadata(peerPath);
          }
          return run(maintenance);
        });
      },
    );
    if (change === "before-doctor") {
      publishPeer();
    }
    const report = await repairMemory(env);
    expect(report.warnings).toEqual([]);
    expect(report.repaired.map((repair) => repair.path)).toEqual(
      change === "already-repaired"
        ? []
        : change === "before-doctor"
          ? [peerPath]
          : [databasePath, peerPath],
    );
    for (const pathname of peerRegistration ? [peerPath] : [databasePath, peerPath]) {
      expect(readMemoryChunkColumns(pathname)).not.toContain("importance");
    }
    if (change === "new-repair") {
      const options = { agentId: "worker-1", env };
      const admitted = agentDatabase.openOpenClawAgentDatabase(options);
      const writeNote = vi.fn();
      expect(await repairMemory(env, true, writeNote)).toEqual({ repaired: [], warnings: [] });
      expect(writeNote).not.toHaveBeenCalled();
      expect(admitted.db.isOpen).toBe(true);
      expect(agentDatabase.openOpenClawAgentDatabase(options)).toBe(admitted);
    }
  },
);
