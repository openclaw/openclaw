// Doctor memory schema tests exercise registered agent databases through the repair path.
import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { readSqliteDatabaseIntegrityVerification } from "../infra/sqlite-database-admission.js";
import { encodeMemoryEmbedding } from "../plugin-sdk/memory-core-host-engine-storage.js";
import { AGENT_DATABASE_MAINTENANCE_LEASE } from "../state/openclaw-agent-db-lease.js";
import { invalidateRegisteredAgentDatabasesMemo } from "../state/openclaw-agent-db-registry-listing.js";
import {
  closeOpenClawAgentDatabasesForTest,
  listOpenClawRegisteredAgentDatabases,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { noteDoctorAgentMemorySchemaHealth } from "./doctor-agent-memory-schema.js";

const tempDirs: string[] = [];

function createRegisteredAgentDatabase(): {
  databasePath: string;
  env: NodeJS.ProcessEnv;
} {
  const stateDir = makeTempDir(tempDirs, "doctor-agent-memory-schema-");
  const env = { OPENCLAW_STATE_DIR: stateDir };
  const databasePath = openOpenClawAgentDatabase({ agentId: "worker-1", env }).path;
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  return { databasePath, env };
}

function recreateUnreleasedInlineMemoryMetadata(databasePath: string): void {
  const database = openNodeSqliteDatabase(databasePath);
  try {
    database.exec("PRAGMA foreign_keys = OFF");
    database.exec(`
      DROP TABLE memory_index_chunk_recall_metadata;
      ALTER TABLE memory_index_chunks ADD COLUMN importance INTEGER
        CHECK (importance IS NULL OR importance BETWEEN 1 AND 10);
      ALTER TABLE memory_index_chunks ADD COLUMN triggers TEXT;
      ALTER TABLE memory_index_chunks ADD COLUMN project_key TEXT;
      CREATE TRIGGER memory_index_chunk_provenance_after_insert
      AFTER INSERT ON memory_index_chunks
      BEGIN
        INSERT OR IGNORE INTO memory_index_chunk_provenance (
          chunk_id, origin_class, session_kind, observed_at
        ) VALUES (NEW.id, 'agent', 'unknown', NEW.updated_at);
      END;
    `);
    database
      .prepare(`INSERT INTO memory_index_chunks (
        id, path, source, start_line, end_line, hash, model, text, embedding,
        updated_at, importance, triggers, project_key
      ) VALUES (
        'pre-provenance-sentinel', 'MEMORY.md', 'memory', 1, 2,
        'sentinel-hash', 'sentinel-model', 'sentinel text', ?, 42,
        9, 'when testing rollback', 'project/key'
      )`)
      .run(encodeMemoryEmbedding([1, 0]));
    database.exec("PRAGMA foreign_keys = ON");
  } finally {
    database.close();
  }
}

function readMemoryChunkColumns(databasePath: string): string[] {
  const database = openNodeSqliteDatabase(databasePath, { readOnly: true });
  try {
    return database
      .prepare("PRAGMA table_info(memory_index_chunks)")
      .all()
      .map((row) => (row as { name: string }).name);
  } finally {
    database.close();
  }
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  cleanupTempDirs(tempDirs);
});

describe("doctor agent memory schema repair", () => {
  it("invalidates verification before a failed writable repair while inspection preserves it", async () => {
    const { databasePath, env } = createRegisteredAgentDatabase();
    recreateUnreleasedInlineMemoryMetadata(databasePath);
    const verification = readSqliteDatabaseIntegrityVerification(databasePath);
    expect(verification).toBeDefined();
    await noteDoctorAgentMemorySchemaHealth({ env, shouldRepair: false }, { note: vi.fn() });
    expect(readSqliteDatabaseIntegrityVerification(databasePath)).toEqual(verification);

    const sqlite = await import("../infra/node-sqlite.js");
    const nativeOpen = sqlite.openNodeSqliteDatabase;
    let observedWritableOpen = false;
    let receiptBeforeOpen: ReturnType<typeof readSqliteDatabaseIntegrityVerification>;
    const open = vi
      .spyOn(sqlite, "openNodeSqliteDatabase")
      .mockImplementation((pathname, options) => {
        if (pathname === databasePath && !options?.readOnly) {
          observedWritableOpen = true;
          receiptBeforeOpen = readSqliteDatabaseIntegrityVerification(databasePath);
          throw new Error("synthetic maintenance native open failed");
        }
        return nativeOpen(pathname, options);
      });
    try {
      const report = await noteDoctorAgentMemorySchemaHealth(
        { env, shouldRepair: true },
        { note: vi.fn() },
      );
      expect(observedWritableOpen).toBe(true);
      expect(receiptBeforeOpen).toBeUndefined();
      expect(report.repaired).toEqual([]);
      expect(report.warnings.join(" ")).toContain("synthetic maintenance native open failed");
      expect(readSqliteDatabaseIntegrityVerification(databasePath)).toBeUndefined();
    } finally {
      open.mockRestore();
    }
  });

  it("blocks runtime admission until a lost Doctor repair releases maintenance", async () => {
    const { databasePath, env } = createRegisteredAgentDatabase();
    const laterOptions = { agentId: "worker-2", env };
    const laterPath = openOpenClawAgentDatabase(laterOptions).path;
    closeOpenClawAgentDatabasesForTest();
    recreateUnreleasedInlineMemoryMetadata(databasePath);
    recreateUnreleasedInlineMemoryMetadata(laterPath);
    const laterBefore = fs.readFileSync(laterPath);
    const agentDatabase = await import("../state/openclaw-agent-db.js");
    const agentMaintenance = await import("../state/openclaw-agent-db-maintenance.js");
    const integrityWorker = await import("../infra/sqlite-integrity-worker.js");
    const sqlite = await import("../infra/node-sqlite.js");
    const startAdmission = createDeferred();
    // Register outside the old maintenance ALS scope: this is a new runtime owner.
    const newerAdmission = startAdmission.promise.then(() =>
      agentDatabase.withOpenClawAgentDatabaseAsync(laterOptions, (database) =>
        database.db.prepare("SELECT id, text FROM memory_index_chunks").all(),
      ),
    );
    void newerAdmission.catch(() => {});
    const scan = vi.spyOn(integrityWorker, "assertSqliteIntegrityInWorker");
    const open = sqlite.openNodeSqliteDatabase;
    const inspectedPaths: string[] = [];
    const inspection = vi
      .spyOn(sqlite, "openNodeSqliteDatabase")
      .mockImplementation((pathname, options) => {
        if (options?.readOnly) {
          inspectedPaths.push(pathname);
        }
        return open(pathname, options);
      });
    const close = vi.spyOn(agentDatabase, "closeOpenClawAgentDatabaseByPath");
    const migrate = agentMaintenance.migrateOpenClawAgentDatabaseForMaintenance;
    const repair = vi
      .spyOn(agentMaintenance, "migrateOpenClawAgentDatabaseForMaintenance")
      .mockImplementationOnce(async (options, maintenance) => {
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
      });
    try {
      await expect(
        noteDoctorAgentMemorySchemaHealth({ env, shouldRepair: true }, { note: vi.fn() }),
      ).rejects.toThrow(/maintenance lease.*was lost/iu);
      expect(repair.mock.calls.map(([options]) => options.pathname)).toEqual([databasePath]);
      expect(inspectedPaths).not.toContain(laterPath);
      expect(close.mock.calls.some(([pathname]) => pathname === laterPath)).toBe(false);
      expect(scan.mock.calls.filter(([pathname]) => pathname === laterPath)).toHaveLength(0);
      await expect(newerAdmission).rejects.toThrow("undergoing offline maintenance");
      expect(fs.readFileSync(laterPath)).toEqual(laterBefore);
      await expect(
        agentDatabase.withOpenClawAgentDatabaseAsync(laterOptions, (database) =>
          database.db.prepare("SELECT id, text FROM memory_index_chunks").all(),
        ),
      ).resolves.toEqual([{ id: "pre-provenance-sentinel", text: "sentinel text" }]);
      expect(scan.mock.calls.filter(([pathname]) => pathname === laterPath)).toHaveLength(1);
    } finally {
      startAdmission.resolve();
      await newerAdmission.catch(() => {});
      repair.mockRestore();
      close.mockRestore();
      inspection.mockRestore();
      scan.mockRestore();
    }
  });

  it("is idempotent on a second doctor fix run", async () => {
    const { databasePath, env } = createRegisteredAgentDatabase();
    recreateUnreleasedInlineMemoryMetadata(databasePath);
    await noteDoctorAgentMemorySchemaHealth({ env, shouldRepair: true }, { note: vi.fn() });
    const options = { agentId: "worker-1", env };
    const admitted = openOpenClawAgentDatabase(options);
    const writeNote = vi.fn();

    const report = await noteDoctorAgentMemorySchemaHealth(
      { env, shouldRepair: true },
      { note: writeNote },
    );

    expect(report).toEqual({ repaired: [], warnings: [] });
    expect(writeNote).not.toHaveBeenCalled();
    expect(admitted.db.isOpen).toBe(true);
    expect(openOpenClawAgentDatabase(options)).toBe(admitted);
  });

  it.each(["already-repaired", "new-repair"])(
    "rediscovers memory repairs after acquiring maintenance: %s",
    async (change) => {
      const { databasePath, env } = createRegisteredAgentDatabase();
      const laterPath = openOpenClawAgentDatabase({ agentId: "worker-2", env }).path;
      closeOpenClawAgentDatabasesForTest();
      recreateUnreleasedInlineMemoryMetadata(databasePath);
      const agentMaintenance = await import("../state/openclaw-agent-db-maintenance.js");
      const agentMaintenanceLease = await import("../state/openclaw-agent-db-maintenance-lease.js");
      const withLease = agentMaintenanceLease.withAgentDatabaseMaintenanceLease;
      const lease = vi
        .spyOn(agentMaintenanceLease, "withAgentDatabaseMaintenanceLease")
        .mockImplementationOnce((options, run) =>
          withLease(options, async (maintenance) => {
            if (change === "already-repaired") {
              await agentMaintenance.migrateOpenClawAgentDatabaseForMaintenance(
                { agentId: "worker-1", pathname: databasePath },
                maintenance,
              );
            } else {
              recreateUnreleasedInlineMemoryMetadata(laterPath);
            }
            return run(maintenance);
          }),
        );
      try {
        const report = await noteDoctorAgentMemorySchemaHealth(
          { env, shouldRepair: true },
          { note: vi.fn() },
        );
        expect(report.warnings).toEqual([]);
        expect(report.repaired.map((repair) => repair.path)).toEqual(
          change === "already-repaired" ? [] : [databasePath, laterPath],
        );
        expect(readMemoryChunkColumns(databasePath)).not.toContain("importance");
        expect(readMemoryChunkColumns(laterPath)).not.toContain("importance");
      } finally {
        lease.mockRestore();
      }
    },
  );

  it.each(["before-doctor", "before-lease"])(
    "discovers a peer registration committed %s despite cached inventory",
    async (timing) => {
      const { databasePath, env } = createRegisteredAgentDatabase();
      const peerPath = openOpenClawAgentDatabase({ agentId: "worker-2", env }).path;
      closeOpenClawAgentDatabasesForTest();
      recreateUnreleasedInlineMemoryMetadata(peerPath);
      if (timing === "before-lease") {
        recreateUnreleasedInlineMemoryMetadata(databasePath);
      }
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
      expect(listOpenClawRegisteredAgentDatabases({ env }).map((entry) => entry.agentId)).toEqual([
        "worker-1",
      ]);
      const publishPeerRegistration = () => {
        // A peer commit does not invalidate this process's registry memo.
        const peer = openNodeSqliteDatabase(state.path);
        try {
          peer
            .prepare(
              "INSERT INTO agent_databases(agent_id,path,schema_version,last_seen_at,size_bytes) VALUES(?,?,?,?,?)",
            )
            .run(...Object.values(row));
        } finally {
          peer.close();
        }
      };
      const agentMaintenanceLease = await import("../state/openclaw-agent-db-maintenance-lease.js");
      const withLease = agentMaintenanceLease.withAgentDatabaseMaintenanceLease;
      const lease = vi.spyOn(agentMaintenanceLease, "withAgentDatabaseMaintenanceLease");
      if (timing === "before-doctor") {
        publishPeerRegistration();
      } else {
        lease.mockImplementationOnce((options, run) => {
          publishPeerRegistration();
          return withLease(options, run);
        });
      }
      try {
        const report = await noteDoctorAgentMemorySchemaHealth(
          { env, shouldRepair: true },
          { note: vi.fn() },
        );
        expect(report.warnings).toEqual([]);
        expect(report.repaired.map((repair) => repair.path)).toEqual(
          timing === "before-doctor" ? [peerPath] : [databasePath, peerPath],
        );
        expect(readMemoryChunkColumns(peerPath)).not.toContain("importance");
      } finally {
        lease.mockRestore();
      }
    },
  );
});
