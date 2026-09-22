import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import * as integrity from "../infra/sqlite-integrity.js";
import * as snapshots from "../infra/sqlite-snapshot-source.js";
import { acquireStateDatabaseHandleLease } from "../infra/state-database-coordinator.js";
import { readAgentDatabaseAdmissionRefusal } from "./agent-database-admission.js";
import { OpenClawAgentDatabaseMediaMigrationRequiredError } from "./openclaw-agent-db-migration-required.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "./openclaw-agent-db.js";
import { assertOpenClawDatabasesReady } from "./openclaw-database-preflight.js";
import { snapshotPreflightSourceManifest } from "./openclaw-database-preflight.test-support.js";
import {
  applyOpenClawDatabaseVerificationResults,
  runDatabaseVerifyWorker,
} from "./openclaw-database-verify.impl.js";
import * as verifier from "./openclaw-database-verify.js";
import {
  clearOpenClawAgentIntegrityVerification,
  readOpenClawAgentIntegrityVerification,
} from "./openclaw-quarantine-store.js";
import { closeOpenClawStateDatabaseForTest } from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

it.each(["DELETE", "WAL", "closed WAL"])(
  "freshly checks startup integrity off the main thread and preserves %s source artifacts",
  async (mode) => {
    const stateDir = tempDirs.make("openclaw-startup-integrity-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const agentPath = path.join(stateDir, "agents/main/agent/openclaw-agent.sqlite");
    openOpenClawAgentDatabase({ agentId: "main", path: agentPath, env });
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    // These raw writers model unclean external mutation, outside the lease owner.
    clearOpenClawAgentIntegrityVerification(agentPath, env);
    const { DatabaseSync } = requireNodeSqlite();
    const writer = mode === "closed WAL" ? undefined : new DatabaseSync(agentPath);
    writer?.exec(`PRAGMA journal_mode=${mode}; PRAGMA wal_autocheckpoint=0;`);
    const prepare = snapshots.prepareSqliteReadOnlyLocation;
    vi.spyOn(snapshots, "prepareSqliteReadOnlyLocation").mockImplementation((pathname, options) => {
      if (pathname === agentPath && mode !== "closed WAL") {
        throw new Error("No space for a full agent database snapshot");
      }
      return prepare(pathname, options);
    });
    const check = integrity.assertSqliteIntegrity;
    const mainThreadAgentChecks: string[] = [];
    vi.spyOn(integrity, "assertSqliteIntegrity").mockImplementation((database, label) => {
      if (label === agentPath) {
        mainThreadAgentChecks.push(label);
      }
      return check(database, label);
    });
    try {
      for (const damaged of [false, true]) {
        if (damaged) {
          const mutation = writer ?? new DatabaseSync(agentPath);
          try {
            mutation.exec(
              `PRAGMA foreign_keys = OFF; CREATE TABLE integrity_probe_parent(id INTEGER ${mode === "DELETE" ? "" : "PRIMARY KEY"}); CREATE TABLE integrity_probe_child(parent_id INTEGER REFERENCES integrity_probe_parent(id)); INSERT INTO integrity_probe_child VALUES (42);`,
            );
          } finally {
            if (!writer) {
              mutation.close();
            }
          }
        }
        const before = snapshotPreflightSourceManifest(
          stateDir,
          mode === "WAL" ? agentPath : undefined,
        );
        const readiness = assertOpenClawDatabasesReady({
          env,
          operation: "gateway-startup",
          config: {},
        });
        if (damaged) {
          await expect(readiness).rejects.toMatchObject({
            name: "SqliteIntegrityError",
            message: expect.stringContaining(`foreign_key_check failed for ${agentPath}`),
            ...(mode === "DELETE"
              ? {
                  cause: {
                    code: "ERR_SQLITE_ERROR",
                    errcode: 1,
                    message: expect.stringContaining("foreign key mismatch"),
                  },
                }
              : {}),
          });
        } else {
          await expect(readiness).resolves.toBeUndefined();
        }
        expect(mainThreadAgentChecks).toEqual([]);
        expect(
          snapshotPreflightSourceManifest(stateDir, mode === "WAL" ? agentPath : undefined),
        ).toEqual(before);
      }
    } finally {
      writer?.close();
    }
  },
);

it.each(process.platform === "win32" ? ["idle", "held"] : ["idle", "held", "alias"])(
  "requires exclusive source ownership for clean closed-WAL startup proof (%s)",
  async (ownership) => {
    const root = tempDirs.make("openclaw-startup-clean-wal-");
    const stateDir = path.join(root, "state");
    fs.mkdirSync(stateDir);
    const env = { OPENCLAW_STATE_DIR: stateDir };
    if (ownership === "alias") {
      env.OPENCLAW_STATE_DIR = path.join(root, "alias");
      fs.symlinkSync(stateDir, env.OPENCLAW_STATE_DIR);
    }
    const agentPath = openOpenClawAgentDatabase({ agentId: "main", env }).path;
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    const realAgentPath = fs.realpathSync.native(agentPath);
    expect(readOpenClawAgentIntegrityVerification(agentPath, env)?.clean_close).toBe(1);
    expect(
      ["-wal", "-shm", "-journal"].filter((suffix) => fs.existsSync(agentPath + suffix)),
    ).toEqual([]);
    const prepare = snapshots.prepareSqliteReadOnlyLocation;
    vi.spyOn(snapshots, "prepareSqliteReadOnlyLocation").mockImplementation((pathname, options) => {
      if (fs.realpathSync.native(pathname) === realAgentPath) {
        throw new Error("Clean restart must not copy the agent database");
      }
      return prepare(pathname, options);
    });
    const request = vi.spyOn(verifier, "requestOpenClawAgentDatabaseQuickCheck");
    const before = snapshotPreflightSourceManifest(stateDir);

    const lease =
      ownership === "held"
        ? acquireStateDatabaseHandleLease({ databasePath: agentPath, busyTimeoutMs: 0 })
        : undefined;
    try {
      const readiness = assertOpenClawDatabasesReady({
        env,
        operation: "gateway-startup",
        config: {},
      });
      if (ownership === "held") {
        await expect(readiness).rejects.toThrow("Clean restart must not copy the agent database");
        expect(request).not.toHaveBeenCalled();
      } else {
        await expect(readiness).resolves.toBeUndefined();
        expect(request).toHaveBeenCalledExactlyOnceWith({ path: agentPath, env });
      }
      expect(snapshotPreflightSourceManifest(stateDir)).toEqual(before);
      if (ownership === "alias") {
        const [queued] = request.mock.calls[0] ?? [];
        if (!queued) {
          throw new Error("Startup did not queue verification");
        }
        const agent = openOpenClawAgentDatabase({ agentId: "main", env });
        agent.db.exec(`
          CREATE TABLE startup_parent (id INTEGER PRIMARY KEY);
          CREATE TABLE startup_child (parent_id INTEGER REFERENCES startup_parent(id));
          PRAGMA foreign_keys=OFF;
          INSERT INTO startup_child VALUES (123);
          PRAGMA foreign_keys=ON;
        `);
        const targets = [
          {
            kind: "agent" as const,
            path: queued.path,
            label: "synthetic agent",
            check: "quick" as const,
          },
        ];
        const results = await runDatabaseVerifyWorker(targets);
        await applyOpenClawDatabaseVerificationResults({ env, targets, results });
        expect(agent.db.isOpen).toBe(false);
        expect(() => openOpenClawAgentDatabase({ agentId: "main", env })).toThrow(
          expect.objectContaining({ name: "SqliteIntegrityError" }),
        );
      }
    } finally {
      lease?.release();
    }
  },
);

it("isolates a corrupt foreign secondary before reporting its integrity failure", async () => {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-startup-foreign-") };
  const agentPath = openOpenClawAgentDatabase({ agentId: "worker", env }).path;
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  const writer = new (requireNodeSqlite().DatabaseSync)(agentPath);
  try {
    writer.exec(
      "PRAGMA journal_mode=DELETE; PRAGMA foreign_keys=OFF; UPDATE schema_meta SET agent_id='foreign'; CREATE TABLE probe_parent(id INTEGER PRIMARY KEY); CREATE TABLE probe_child(parent_id REFERENCES probe_parent(id)); INSERT INTO probe_child VALUES (42);",
    );
    await expect(
      assertOpenClawDatabasesReady({
        env,
        operation: "gateway-startup",
        config: { agents: { list: [{ id: "main", default: true }, { id: "worker" }] } },
      }),
    ).resolves.toBeUndefined();
    expect(readAgentDatabaseAdmissionRefusal("worker", { env })).toMatchObject({
      embeddedOwnerId: "foreign",
    });
  } finally {
    writer.close();
  }
});

it("preserves the startup maintenance-required error class across the direct child", async () => {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-startup-legacy-") };
  const agentPath = openOpenClawAgentDatabase({ agentId: "main", env }).path;
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  const writer = new (requireNodeSqlite().DatabaseSync)(agentPath);
  try {
    writer.exec(
      "PRAGMA journal_mode=DELETE; PRAGMA user_version=1; UPDATE schema_meta SET schema_version=1;",
    );
    await expect(
      assertOpenClawDatabasesReady({ env, operation: "gateway-startup", config: {} }),
    ).rejects.toBeInstanceOf(OpenClawAgentDatabaseMediaMigrationRequiredError);
  } finally {
    writer.close();
  }
});
