import fs from "node:fs";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { readSqliteNumberPragma } from "../infra/sqlite-pragma.test-support.js";
import {
  clearOpenClawAgentDatabaseOpenFailure,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "./openclaw-agent-db.js";
import {
  applyOpenClawDatabaseVerificationResults,
  runOpenClawDatabaseVerificationWorker,
} from "./openclaw-database-verify.js";
import {
  type OpenClawDatabaseVerifyTarget,
  verifyOpenClawDatabases,
} from "./openclaw-database-verify.worker.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  repairOpenClawStateDatabaseSchema,
} from "./openclaw-state-db.js";

const tempDirs: string[] = [];

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

afterAll(() => cleanupTempDirs(tempDirs));

function createUnsafeIndexDrift(databasePath: string): void {
  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`
      CREATE TABLE unsafe_index_records (
        id INTEGER PRIMARY KEY,
        indexed_value TEXT NOT NULL,
        alternate_value TEXT NOT NULL
      );
      CREATE INDEX unsafe_index_records_value ON unsafe_index_records(indexed_value);
      INSERT INTO unsafe_index_records (indexed_value, alternate_value)
      VALUES ('alpha', 'zeta'), ('beta', 'eta'), ('gamma', 'theta');
    `);
    database.enableDefensive?.(false);
    database.exec("PRAGMA writable_schema = ON;");
    database
      .prepare(
        "UPDATE sqlite_schema SET sql = 'CREATE INDEX unsafe_index_records_value ON unsafe_index_records(alternate_value)' WHERE name = 'unsafe_index_records_value'",
      )
      .run();
    const schemaVersion = readSqliteNumberPragma(database, "schema_version");
    database.exec(`PRAGMA writable_schema = OFF; PRAGMA schema_version = ${schemaVersion + 1};`);
  } finally {
    database.close();
  }
}

describe("OpenClaw database integrity verifier", () => {
  it("detects corruption off-thread, persists it, and latches later opens", async () => {
    const stateDir = makeTempDir(tempDirs, "openclaw-database-verify-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const agentPath = openOpenClawAgentDatabase({ agentId: "worker-1", env }).path;
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    createUnsafeIndexDrift(agentPath);
    const targets: OpenClawDatabaseVerifyTarget[] = [
      { kind: "agent", label: "OpenClaw agent database worker-1", path: agentPath },
    ];

    const directResults = verifyOpenClawDatabases(targets);
    expect(directResults).toEqual([
      {
        path: agentPath,
        ok: false,
        error: expect.stringMatching(/missing from index unsafe_index_records_value/iu),
        terminal: true,
      },
    ]);
    await expect(runOpenClawDatabaseVerificationWorker(targets)).resolves.toEqual(directResults);

    // The drift lives outside schema_meta, so the rescoped open still succeeds;
    // the recorder must then quarantine this live handle, not just future opens.
    const liveHandle = openOpenClawAgentDatabase({ agentId: "worker-1", env });
    expect(liveHandle.db.isOpen).toBe(true);

    applyOpenClawDatabaseVerificationResults({
      env,
      results: directResults,
      targets,
      verifiedAt: 1234,
    });
    expect(liveHandle.db.isOpen).toBe(false);

    expect(
      openOpenClawStateDatabase({ env })
        .db.prepare(
          "SELECT path, kind, verified_at, result, error FROM database_verifications WHERE path = ?",
        )
        .get(agentPath),
    ).toEqual({
      path: agentPath,
      kind: "agent",
      verified_at: 1234,
      result: "error",
      error: directResults[0]?.error,
    });
    applyOpenClawDatabaseVerificationResults({
      env,
      results: [{ path: agentPath, ok: false, error: "database busy", terminal: false }],
      targets,
      verifiedAt: 1235,
    });
    expect(
      openOpenClawStateDatabase({ env })
        .db.prepare("SELECT verified_at, result, error FROM database_verifications WHERE path = ?")
        .get(agentPath),
    ).toEqual({ verified_at: 1234, result: "error", error: directResults[0]?.error });
    expect(() => openOpenClawAgentDatabase({ agentId: "worker-1", env })).toThrow(
      expect.objectContaining({ name: "SqliteIntegrityError" }),
    );

    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    expect(() => openOpenClawAgentDatabase({ agentId: "worker-1", env })).toThrow(
      expect.objectContaining({
        name: "SqliteIntegrityError",
        message: expect.stringContaining(directResults[0]?.error ?? ""),
      }),
    );
    clearOpenClawAgentDatabaseOpenFailure(agentPath, { env });
    expect(openOpenClawAgentDatabase({ agentId: "worker-1", env }).db.isOpen).toBe(true);
  });

  it("reports an uncleared quarantine row instead of claiming repair success", () => {
    const stateDir = makeTempDir(tempDirs, "openclaw-database-verify-clear-failure-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const agentPath = openOpenClawAgentDatabase({ agentId: "worker-1", env }).path;
    const statePath = openOpenClawStateDatabase({ env }).path;
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    applyOpenClawDatabaseVerificationResults({
      env,
      results: [{ path: agentPath, ok: false, error: "corrupt index", terminal: true }],
      targets: [{ kind: "agent", label: "OpenClaw agent database worker-1", path: agentPath }],
      verifiedAt: 4567,
    });
    closeOpenClawStateDatabaseForTest();

    // A read-only state DB cannot drop the quarantine row; the clear must say so
    // instead of letting doctor report success while the next open still refuses.
    fs.chmodSync(statePath, 0o444);
    try {
      expect(clearOpenClawAgentDatabaseOpenFailure(agentPath, { env })).toBe(false);
    } finally {
      // WAL sidecars minted during the read-only attempt inherit its mode.
      for (const sidecar of [statePath, `${statePath}-wal`, `${statePath}-shm`]) {
        if (fs.existsSync(sidecar)) {
          fs.chmodSync(sidecar, 0o600);
        }
      }
    }
    expect(clearOpenClawAgentDatabaseOpenFailure(agentPath, { env })).toBe(true);
    expect(openOpenClawAgentDatabase({ agentId: "worker-1", env }).db.isOpen).toBe(true);
  });

  it("persists transient verifier errors as inconclusive without latching", () => {
    const stateDir = makeTempDir(tempDirs, "openclaw-database-verify-transient-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const agentPath = openOpenClawAgentDatabase({ agentId: "worker-1", env }).path;
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    const targets: OpenClawDatabaseVerifyTarget[] = [
      { kind: "agent", label: "OpenClaw agent database worker-1", path: agentPath },
    ];

    applyOpenClawDatabaseVerificationResults({
      env,
      results: [{ path: agentPath, ok: false, error: "Error: database is busy", terminal: false }],
      targets,
      verifiedAt: 2345,
    });

    expect(
      openOpenClawStateDatabase({ env })
        .db.prepare("SELECT result, error FROM database_verifications WHERE path = ?")
        .get(agentPath),
    ).toEqual({ result: "inconclusive", error: "Error: database is busy" });
    expect(openOpenClawAgentDatabase({ agentId: "worker-1", env }).db.isOpen).toBe(true);
  });

  it("persists state failure quarantine across restart until doctor repair", () => {
    const stateDir = makeTempDir(tempDirs, "openclaw-database-verify-state-failure-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const statePath = openOpenClawStateDatabase({ env }).path;
    closeOpenClawStateDatabaseForTest();
    const targets: OpenClawDatabaseVerifyTarget[] = [
      { kind: "state", label: "OpenClaw state database", path: statePath },
    ];

    applyOpenClawDatabaseVerificationResults({
      env,
      results: [{ path: statePath, ok: false, error: "corrupt index", terminal: true }],
      targets,
      verifiedAt: 3456,
    });

    const { DatabaseSync } = requireNodeSqlite();
    const raw = new DatabaseSync(statePath, { readOnly: true });
    try {
      expect(
        raw
          .prepare("SELECT result, error FROM database_verifications WHERE path = ?")
          .get(statePath),
      ).toEqual({ result: "error", error: "corrupt index" });
    } finally {
      raw.close();
    }
    expect(() => openOpenClawStateDatabase({ env })).toThrow(
      expect.objectContaining({
        name: "SqliteIntegrityError",
        message: expect.stringContaining("corrupt index"),
      }),
    );
    closeOpenClawStateDatabaseForTest();
    expect(() => openOpenClawStateDatabase({ env })).toThrow(
      expect.objectContaining({
        name: "SqliteIntegrityError",
        message: expect.stringContaining("corrupt index"),
      }),
    );
    expect(repairOpenClawStateDatabaseSchema({ env }).warnings).toEqual([]);
    expect(openOpenClawStateDatabase({ env }).db.isOpen).toBe(true);
  });
});
