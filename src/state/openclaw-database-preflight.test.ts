import fs from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import packageJson from "../../package.json" with { type: "json" };
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { collectSqliteSchemaIssues } from "../infra/sqlite-schema-contract.js";
import { createUpdateRun } from "../infra/update-run-ledger.js";
import { OpenClawAgentDatabaseMediaMigrationRequiredError } from "./openclaw-agent-db-migration-required.js";
import {
  closeOpenClawAgentDatabasesForTest,
  OPENCLAW_AGENT_SCHEMA_VERSION,
  openOpenClawAgentDatabase,
} from "./openclaw-agent-db.js";
import {
  assertOpenClawDatabasesReady,
  preflightOpenClawStateDatabasePath,
  preflightOpenClawDatabaseSchemas,
} from "./openclaw-database-preflight.js";
import {
  snapshotPreflightSourceManifest,
  snapshotSourceFamily,
} from "./openclaw-database-preflight.test-support.js";
import { repairAuditEventsSchema } from "./openclaw-state-db-audit-migration.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { OpenClawStateDatabaseSchemaMigrationRequiredError } from "./openclaw-state-db-schema-migration-required.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

describe("OpenClaw database schema preflight", () => {
  function createReleasedStateDatabase() {
    const stateDir = tempDirs.make("openclaw-startup-database-admission-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const statePath = resolveOpenClawStateSqlitePath(env);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(
      statePath,
      gunzipSync(
        fs.readFileSync(
          new URL(
            "../../test/fixtures/sqlite/openclaw-state-v2026.7.1-2.sqlite.gz",
            import.meta.url,
          ),
        ),
      ),
    );
    fs.writeFileSync(path.join(stateDir, "openclaw.json"), "{}\n");
    return { env, stateDir, statePath };
  }

  it("refuses released legacy audit state before changing any persistent artifact", async () => {
    const { env, stateDir, statePath } = createReleasedStateDatabase();
    const before = snapshotPreflightSourceManifest(stateDir);
    await expect(
      assertOpenClawDatabasesReady({ env, operation: "gateway-startup", config: {} }),
    ).rejects.toBeInstanceOf(OpenClawStateDatabaseSchemaMigrationRequiredError);
    expect(snapshotPreflightSourceManifest(stateDir)).toEqual(before);
    await expect(preflightOpenClawStateDatabasePath(statePath)).resolves.toMatchObject({
      foundVersion: 1,
    });
  });

  it.each(["configured", "registered"] as const)(
    "refuses a %s legacy agent database without mutating its WAL or creating stores",
    async (layout) => {
      const stateDir = tempDirs.make("openclaw-agent-startup-admission-");
      const env = { OPENCLAW_STATE_DIR: stateDir };
      const agentPath =
        layout === "configured"
          ? path.join(stateDir, "custom", "sessions.sqlite")
          : path.join(stateDir, "agents", "retired", "agent", "openclaw-agent.sqlite");
      const agentId = layout === "configured" ? "main" : "retired";
      openOpenClawAgentDatabase({ agentId, path: agentPath, env });
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      const { DatabaseSync } = requireNodeSqlite();
      const writer = new DatabaseSync(agentPath);
      try {
        writer.exec(
          "PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; PRAGMA user_version = 15; UPDATE schema_meta SET schema_version = 15;",
        );
        const config =
          layout === "configured"
            ? { session: { store: path.join(stateDir, "custom", "sessions.json") } }
            : {};
        const before = snapshotPreflightSourceManifest(stateDir, agentPath);
        await expect(
          assertOpenClawDatabasesReady({ env, operation: "gateway-startup", config }),
        ).rejects.toBeInstanceOf(OpenClawAgentDatabaseMediaMigrationRequiredError);
        expect(snapshotPreflightSourceManifest(stateDir, agentPath)).toEqual(before);
      } finally {
        writer.close();
      }
    },
  );

  it("rejects a canonical configured agent path owned by another agent before writes", async () => {
    const root = tempDirs.make("openclaw-configured-agent-owner-");
    const env = { OPENCLAW_STATE_DIR: path.join(root, "active") };
    const agentDir = path.join(root, "external", "agents", "alpha");
    const agentPath = path.join(agentDir, "agent", "openclaw-agent.sqlite");
    const store = path.join(agentDir, "sessions", "sessions.json");
    openOpenClawStateDatabase({ env });
    openOpenClawAgentDatabase({
      agentId: "beta",
      path: agentPath,
      env: { OPENCLAW_STATE_DIR: path.join(root, "donor") },
    });
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    const before = snapshotPreflightSourceManifest(root);
    await expect(
      assertOpenClawDatabasesReady({
        env,
        operation: "gateway-startup",
        config: { session: { store } },
      }),
    ).rejects.toThrow("belongs to agent beta; requested agent alpha");
    expect(snapshotPreflightSourceManifest(root)).toEqual(before);
  });

  it("admits supported forward state migration after the Doctor-owned audit repair", async () => {
    const { env, stateDir, statePath } = createReleasedStateDatabase();
    const { DatabaseSync } = requireNodeSqlite();
    const database = new DatabaseSync(statePath);
    try {
      expect(repairAuditEventsSchema(database)).toBe(true);
    } finally {
      database.close();
    }
    const before = snapshotPreflightSourceManifest(stateDir);
    await expect(
      assertOpenClawDatabasesReady({ env, operation: "gateway-startup", config: {} }),
    ).resolves.toBeUndefined();
    expect(snapshotPreflightSourceManifest(stateDir)).toEqual(before);
    const migrated = openOpenClawStateDatabase({ env });
    expect(migrated.db.prepare("PRAGMA user_version").get()).toEqual({
      user_version: OPENCLAW_STATE_SCHEMA_VERSION,
    });
  });

  it("treats a current-v6 additive column as incompatible with the older v6 shape", () => {
    const { DatabaseSync } = requireNodeSqlite();
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(OPENCLAW_STATE_SCHEMA_SQL);
      const olderV6Schema = OPENCLAW_STATE_SCHEMA_SQL.replace(
        "  removed_at INTEGER,\n  run_end_cleanup_json TEXT\n",
        "  removed_at INTEGER\n",
      );

      expect(collectSqliteSchemaIssues(database, olderV6Schema)).toContainEqual(
        expect.objectContaining({
          code: "unexpected-column",
          objectName: "worktrees.run_end_cleanup_json",
        }),
      );
    } finally {
      database.close();
    }
  });

  it("keeps package schema support metadata aligned", () => {
    expect(packageJson.openclaw.schemaVersions).toEqual({
      state: OPENCLAW_STATE_SCHEMA_VERSION,
      agent: OPENCLAW_AGENT_SCHEMA_VERSION,
    });
  });

  it("accepts a supported state schema", async () => {
    const stateDir = tempDirs.make("openclaw-database-preflight-supported-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    openOpenClawStateDatabase({ env });
    closeOpenClawStateDatabaseForTest();

    expect(
      await preflightOpenClawDatabaseSchemas({
        env,
        verifyCurrentSchemaShape: true,
        supportedVersions: {
          state: OPENCLAW_STATE_SCHEMA_VERSION,
          agent: OPENCLAW_AGENT_SCHEMA_VERSION,
        },
      }),
    ).toEqual({ incompatible: [], indeterminate: [] });
    await expect(
      assertOpenClawDatabasesReady({ env, operation: "gateway-restart" }),
    ).resolves.toBeUndefined();
  });

  it.each([false, true])(
    "recognizes deferred content and still checks its shape (damaged: %s)",
    async (damaged) => {
      const stateDir = tempDirs.make("openclaw-preflight-deferred-schema-");
      const env = { OPENCLAW_STATE_DIR: stateDir };
      const opened = openOpenClawStateDatabase({ env });
      const run = createUpdateRun({ trigger: "cli", before: { version: "2026.9.2" } }, { env });
      const statePath = opened.path;
      closeOpenClawStateDatabaseForTest();
      const { DatabaseSync } = requireNodeSqlite();
      const database = new DatabaseSync(statePath);
      try {
        database.exec(
          `PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION - 1}; UPDATE schema_meta SET schema_version = ${OPENCLAW_STATE_SCHEMA_VERSION - 1};`,
        );
        database
          .prepare(
            "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, ?)",
          )
          .run("state.schema.contentVersion", String(OPENCLAW_STATE_SCHEMA_VERSION), Date.now());
        if (damaged) {
          database.exec(
            "ALTER TABLE worktrees DROP COLUMN run_end_cleanup_json; ALTER TABLE worktrees ADD COLUMN run_end_cleanup_json INTEGER;",
          );
        }
      } finally {
        database.close();
      }
      const before = snapshotSourceFamily(statePath);
      const result = await preflightOpenClawDatabaseSchemas({
        env,
        verifyCurrentSchemaShape: true,
        supportedVersions: {
          state: OPENCLAW_STATE_SCHEMA_VERSION,
          agent: OPENCLAW_AGENT_SCHEMA_VERSION,
        },
      });
      expect(result.pendingMigrations).toBeUndefined();
      expect(result.incompatible).toEqual([]);
      expect(result.deferredSchemaPublications).toEqual([
        expect.objectContaining({
          kind: "state",
          path: statePath,
          foundVersion: OPENCLAW_STATE_SCHEMA_VERSION - 1,
          contentVersion: OPENCLAW_STATE_SCHEMA_VERSION,
          runId: run.runId,
          message: expect.stringContaining(
            `version publication deferred until update run ${run.runId} finishes`,
          ),
        }),
      ]);
      expect(result.indeterminate).toEqual(
        damaged
          ? [
              expect.objectContaining({
                kind: "state",
                reason: expect.stringContaining("column definitions differ for worktrees"),
              }),
            ]
          : [],
      );
      expect(snapshotSourceFamily(statePath)).toEqual(before);
      if (!damaged) {
        await expect(
          preflightOpenClawDatabaseSchemas({
            env,
            supportedVersions: {
              state: OPENCLAW_STATE_SCHEMA_VERSION - 1,
              agent: OPENCLAW_AGENT_SCHEMA_VERSION,
            },
          }),
        ).resolves.toMatchObject({
          incompatible: [expect.objectContaining({ foundVersion: OPENCLAW_STATE_SCHEMA_VERSION })],
        });
        await expect(preflightOpenClawStateDatabasePath(statePath)).resolves.toMatchObject({
          status: "exact",
          foundVersion: OPENCLAW_STATE_SCHEMA_VERSION - 1,
          contentVersion: OPENCLAW_STATE_SCHEMA_VERSION,
          deferredPublication: expect.objectContaining({ runId: run.runId }),
        });
      }
    },
  );

  it("accepts an older v6 state database without the lazy setup id during restart preflight", async () => {
    const stateDir = tempDirs.make("openclaw-database-preflight-older-v6-setup-id-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const statePath = openOpenClawStateDatabase({ env }).path;
    closeOpenClawStateDatabaseForTest();

    const { DatabaseSync } = requireNodeSqlite();
    const state = new DatabaseSync(statePath);
    try {
      state.exec("ALTER TABLE device_bootstrap_tokens DROP COLUMN setup_id;");
    } finally {
      state.close();
    }
    await expect(
      assertOpenClawDatabasesReady({ env, operation: "gateway-restart" }),
    ).resolves.toBeUndefined();
  });

  it("reports a current but noncanonical state schema as indeterminate", async () => {
    const stateDir = tempDirs.make("openclaw-database-preflight-noncanonical-state-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const statePath = openOpenClawStateDatabase({ env }).path;
    closeOpenClawStateDatabaseForTest();

    const { DatabaseSync } = requireNodeSqlite();
    const state = new DatabaseSync(statePath);
    try {
      state.exec(
        "ALTER TABLE worktrees DROP COLUMN run_end_cleanup_json; " +
          "ALTER TABLE worktrees ADD COLUMN run_end_cleanup_json INTEGER;",
      );
    } finally {
      state.close();
    }

    expect(
      await preflightOpenClawDatabaseSchemas({
        env,
        verifyCurrentSchemaShape: true,
        supportedVersions: {
          state: OPENCLAW_STATE_SCHEMA_VERSION,
          agent: OPENCLAW_AGENT_SCHEMA_VERSION,
        },
      }),
    ).toEqual({
      incompatible: [],
      indeterminate: [
        {
          kind: "state",
          path: statePath,
          reason: expect.stringContaining("column definitions differ for worktrees"),
        },
      ],
    });
    await expect(
      assertOpenClawDatabasesReady({ env, operation: "gateway-restart" }),
    ).rejects.toThrow(/Gateway refused restart.*column definitions differ for worktrees/su);
  });

  it.each(["default", "configured"])(
    "holds an unregistered %s store without deletion history or creating shared state",
    async (layout) => {
      const stateDir = tempDirs.make("openclaw-unregistered-readiness-");
      const env = { OPENCLAW_STATE_DIR: stateDir };
      const customPath = path.join(tempDirs.make("openclaw-configured-readiness-"), "agent.sqlite");
      const agent = openOpenClawAgentDatabase({
        agentId: "main",
        env,
        ...(layout === "configured" ? { path: customPath } : {}),
      });
      const statePath = resolveOpenClawStateSqlitePath(env);
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      fs.unlinkSync(statePath);
      const { DatabaseSync } = requireNodeSqlite();
      const database = new DatabaseSync(agent.path);
      // Consolidate the fixture so ordinary SQLite WAL coordination is not
      // mistaken for readiness creating or migrating a persistent database.
      database.exec("PRAGMA journal_mode = DELETE;");
      database.close();
      const options = {
        env,
        operation: "doctor" as const,
        configuredAgentDatabaseTargets:
          layout === "configured" ? [{ agentId: "main", path: agent.path }] : [],
        onAgentInspection: vi.fn(),
      };
      const before = snapshotSourceFamily(agent.path);
      await expect(assertOpenClawDatabasesReady(options)).resolves.toBeUndefined();
      expect(snapshotSourceFamily(agent.path)).toEqual(before);
      expect(fs.existsSync(statePath)).toBe(false);
      const legacyWriter = new DatabaseSync(agent.path);
      legacyWriter.exec(
        "DROP TABLE session_participants; PRAGMA user_version = 17; UPDATE schema_meta SET schema_version = 17;",
      );
      legacyWriter.close();
      const legacy = snapshotSourceFamily(agent.path);
      await expect(assertOpenClawDatabasesReady(options)).resolves.toBeUndefined();
      expect(options.onAgentInspection).toHaveBeenCalledTimes(2);
      expect(options.onAgentInspection.mock.calls).toEqual([
        [{ schemaProcessCount: 0, schemaInspectionCount: 0, schemaSnapshotCount: 0 }],
        [{ schemaProcessCount: 0, schemaInspectionCount: 0, schemaSnapshotCount: 0 }],
      ]);
      const onAgentDatabaseDiscovery = vi.fn();
      await expect(
        preflightOpenClawDatabaseSchemas({ ...options, onAgentDatabaseDiscovery }),
      ).resolves.toEqual({ incompatible: [], indeterminate: [] });
      expect(onAgentDatabaseDiscovery).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          discovery: expect.objectContaining({
            targets: [],
            retainedDeletions: "unavailable",
            registryRemovals: [],
            failures: [],
            warnings: [
              expect.stringContaining(
                `Held agent main database ${agent.path} (deletion journal unavailable); run openclaw doctor --fix`,
              ),
            ],
          }),
        }),
      );
      expect(snapshotSourceFamily(agent.path)).toEqual(legacy);
      expect(fs.existsSync(statePath)).toBe(false);
    },
  );

  it("leaves archive-only state alone when no runtime database exists", async () => {
    const stateDir = tempDirs.make("openclaw-readiness-archive-only-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const archivePath = path.join(
      stateDir,
      "agents",
      "main",
      "sessions",
      "old.jsonl.deleted.2026-07-24T01-02-04.000Z",
    );
    fs.mkdirSync(path.dirname(archivePath), { recursive: true });
    fs.writeFileSync(archivePath, "unreadable archive\n");
    const before = snapshotSourceFamily(archivePath);
    await expect(
      assertOpenClawDatabasesReady({
        env,
        operation: "doctor",
        configuredAgentDatabaseTargets: [],
      }),
    ).resolves.toBeUndefined();
    expect(snapshotSourceFamily(archivePath)).toEqual(before);
    expect(fs.existsSync(resolveOpenClawStateSqlitePath(env))).toBe(false);
    expect(fs.existsSync(path.join(stateDir, "agents", "main", "agent"))).toBe(false);
  });

  it("collects newer state and registered agent schemas with writer builds", async () => {
    const stateDir = tempDirs.make("openclaw-database-preflight-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const statePath = openOpenClawStateDatabase({ env }).path;
    const agentPath = openOpenClawAgentDatabase({ agentId: "worker-1", env }).path;
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();

    const { DatabaseSync } = requireNodeSqlite();
    const state = new DatabaseSync(statePath);
    try {
      state.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION + 1};`);
      state
        .prepare("UPDATE schema_meta SET app_version = ? WHERE meta_key = 'primary'")
        .run("state-writer-build");
    } finally {
      state.close();
    }
    const agent = new DatabaseSync(agentPath);
    try {
      agent.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION + 1};`);
      agent
        .prepare("UPDATE schema_meta SET app_version = ? WHERE meta_key = 'primary'")
        .run("agent-writer-build");
    } finally {
      agent.close();
    }

    expect(
      await preflightOpenClawDatabaseSchemas({
        env,
        supportedVersions: {
          state: OPENCLAW_STATE_SCHEMA_VERSION,
          agent: OPENCLAW_AGENT_SCHEMA_VERSION,
        },
      }),
    ).toEqual({
      incompatible: [
        {
          kind: "state",
          path: statePath,
          foundVersion: OPENCLAW_STATE_SCHEMA_VERSION + 1,
          supportedVersion: OPENCLAW_STATE_SCHEMA_VERSION,
          writerAppVersion: "state-writer-build",
        },
        {
          kind: "agent",
          path: agentPath,
          agentId: "worker-1",
          foundVersion: OPENCLAW_AGENT_SCHEMA_VERSION + 1,
          supportedVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
          writerAppVersion: "agent-writer-build",
        },
      ],
      indeterminate: [],
    });
  });

  it.each(["absent", "installed", "drifted"])(
    "preflights the %s transcript eligibility index without repairing it",
    async (shape) => {
      const stateDir = tempDirs.make("openclaw-transcript-eligibility-preflight-");
      const env = { OPENCLAW_STATE_DIR: stateDir };
      const agentPath = openOpenClawAgentDatabase({ agentId: "worker-1", env }).path;
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      const { DatabaseSync } = requireNodeSqlite();
      const agent = new DatabaseSync(agentPath);
      try {
        if (shape !== "installed") {
          agent.exec("DROP INDEX idx_agent_transcript_context_pending");
          if (shape === "absent") {
            agent.exec("ALTER TABLE session_transcript_active_events DROP COLUMN context_eligible");
          } else {
            agent.exec(
              "CREATE INDEX idx_agent_transcript_context_pending ON session_transcript_active_events(event_seq)",
            );
          }
        }
      } finally {
        agent.close();
      }
      const result = await preflightOpenClawDatabaseSchemas({
        env,
        verifyCurrentSchemaShape: true,
        supportedVersions: {
          state: OPENCLAW_STATE_SCHEMA_VERSION,
          agent: OPENCLAW_AGENT_SCHEMA_VERSION,
        },
      });
      expect(result.incompatible).toEqual([]);
      expect(result.indeterminate).toEqual(
        shape === "drifted"
          ? [
              {
                kind: "agent",
                path: agentPath,
                reason: expect.stringContaining("idx_agent_transcript_context_pending"),
              },
            ]
          : [],
      );
      const inspected = new DatabaseSync(agentPath, { readOnly: true });
      try {
        expect(
          inspected
            .prepare(
              "SELECT name FROM pragma_table_info('session_transcript_active_events') WHERE name = 'context_eligible'",
            )
            .get(),
        ).toEqual(shape === "absent" ? undefined : { name: "context_eligible" });
        expect(inspected.prepare("PRAGMA user_version").get()).toEqual({
          user_version: OPENCLAW_AGENT_SCHEMA_VERSION,
        });
      } finally {
        inspected.close();
      }
    },
  );

  it("checks every registered owner before permitting Gateway restart", async () => {
    const stateDir = tempDirs.make("openclaw-preflight-conflicting-owners-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const agentPath = openOpenClawAgentDatabase({ agentId: "main", env }).path;
    const statePath = resolveOpenClawStateSqlitePath(env);
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    const { DatabaseSync } = requireNodeSqlite();
    const registry = new DatabaseSync(statePath);
    registry
      .prepare(
        "INSERT INTO agent_databases (agent_id, path, schema_version, last_seen_at, size_bytes) VALUES (?, ?, ?, ?, ?)",
      )
      .run("ops", agentPath, OPENCLAW_AGENT_SCHEMA_VERSION, 1, null);
    registry.close();

    await expect(
      assertOpenClawDatabasesReady({ env, operation: "gateway-restart" }),
    ).rejects.toThrow(/Gateway refused restart.*belongs to agent main; requested agent ops/s);
    const result = await preflightOpenClawDatabaseSchemas({
      env,
      supportedVersions: {
        state: OPENCLAW_STATE_SCHEMA_VERSION,
        agent: OPENCLAW_AGENT_SCHEMA_VERSION,
      },
      verifyCurrentSchemaShape: true,
      configuredAgentDatabaseCandidatePaths: [agentPath],
    });
    expect(result.indeterminate).toEqual([
      {
        kind: "agent",
        path: agentPath,
        reason: expect.stringContaining("belongs to agent main; requested agent ops"),
      },
    ]);
  });

  it("reports a current but noncanonical registered agent schema as indeterminate", async () => {
    const stateDir = tempDirs.make("openclaw-database-preflight-noncanonical-agent-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const agentPath = openOpenClawAgentDatabase({ agentId: "worker-1", env }).path;
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();

    const { DatabaseSync } = requireNodeSqlite();
    const agent = new DatabaseSync(agentPath);
    try {
      agent.exec(
        "ALTER TABLE schema_meta ADD COLUMN unexpected TEXT CHECK (length(unexpected) > 0);",
      );
    } finally {
      agent.close();
    }

    expect(
      await preflightOpenClawDatabaseSchemas({
        env,
        verifyCurrentSchemaShape: true,
        supportedVersions: {
          state: OPENCLAW_STATE_SCHEMA_VERSION,
          agent: OPENCLAW_AGENT_SCHEMA_VERSION,
        },
      }),
    ).toEqual({
      incompatible: [],
      indeterminate: [
        {
          kind: "agent",
          path: agentPath,
          reason: expect.stringContaining("column definitions differ for schema_meta"),
        },
      ],
    });
  });

  it("reports an existing unreadable state database as indeterminate", async () => {
    const stateDir = tempDirs.make("openclaw-database-preflight-unreadable-state-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const statePath = openOpenClawStateDatabase({ env }).path;
    closeOpenClawStateDatabaseForTest();
    fs.writeFileSync(statePath, "not a sqlite database");

    expect(
      await preflightOpenClawDatabaseSchemas({
        env,
        supportedVersions: {
          state: OPENCLAW_STATE_SCHEMA_VERSION,
          agent: OPENCLAW_AGENT_SCHEMA_VERSION,
        },
      }),
    ).toEqual({
      incompatible: [],
      indeterminate: [
        { kind: "state", path: statePath, reason: expect.stringMatching(/database|file/iu) },
      ],
    });
  });

  it("reports a failed agent registry query as indeterminate", async () => {
    const stateDir = tempDirs.make("openclaw-database-preflight-registry-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const statePath = openOpenClawStateDatabase({ env }).path;
    closeOpenClawStateDatabaseForTest();
    const { DatabaseSync } = requireNodeSqlite();
    const state = new DatabaseSync(statePath);
    try {
      state.exec("DROP TABLE agent_databases; CREATE TABLE agent_databases (bad TEXT) STRICT;");
    } finally {
      state.close();
    }

    expect(
      await preflightOpenClawDatabaseSchemas({
        env,
        supportedVersions: {
          state: OPENCLAW_STATE_SCHEMA_VERSION,
          agent: OPENCLAW_AGENT_SCHEMA_VERSION,
        },
      }),
    ).toEqual({
      incompatible: [],
      indeterminate: [
        {
          kind: "state",
          path: statePath,
          reason: expect.stringContaining("agent database registry query failed"),
        },
      ],
    });
  });

  it("reports an existing unreadable registered agent database as indeterminate", async () => {
    const stateDir = tempDirs.make("openclaw-database-preflight-unreadable-agent-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const agentPath = openOpenClawAgentDatabase({ agentId: "worker-1", env }).path;
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    fs.writeFileSync(agentPath, "not a sqlite database");

    expect(
      await preflightOpenClawDatabaseSchemas({
        env,
        supportedVersions: {
          state: OPENCLAW_STATE_SCHEMA_VERSION,
          agent: OPENCLAW_AGENT_SCHEMA_VERSION,
        },
      }),
    ).toEqual({
      incompatible: [],
      indeterminate: [
        { kind: "agent", path: agentPath, reason: expect.stringMatching(/database|file/iu) },
      ],
    });
  });

  it.runIf(process.platform !== "win32")(
    "keeps partial configured-store inventory when one candidate lookup is denied",
    async () => {
      const stateDir = tempDirs.make("openclaw-configured-candidate-lookup-");
      const env = { OPENCLAW_STATE_DIR: stateDir };
      openOpenClawStateDatabase({ env });
      closeOpenClawStateDatabaseForTest();
      const visibleDir = tempDirs.make("openclaw-configured-visible-");
      const deniedDir = tempDirs.make("openclaw-configured-denied-");
      const visiblePath = path.join(visibleDir, "newer.sqlite");
      const deniedPath = path.join(deniedDir, "owned.sqlite");
      const absentPath = path.join(visibleDir, "absent.sqlite");
      const { DatabaseSync } = requireNodeSqlite();
      for (const databasePath of [visiblePath, deniedPath]) {
        const database = new DatabaseSync(databasePath);
        database.exec(
          `PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION + (databasePath === visiblePath ? 1 : 0)};`,
        );
        database.close();
      }

      fs.chmodSync(deniedDir, 0o000);
      let result: Awaited<ReturnType<typeof preflightOpenClawDatabaseSchemas>>;
      try {
        result = await preflightOpenClawDatabaseSchemas({
          env,
          supportedVersions: {
            state: OPENCLAW_STATE_SCHEMA_VERSION,
            agent: OPENCLAW_AGENT_SCHEMA_VERSION,
          },
          configuredAgentDatabaseCandidatePaths: [visiblePath, deniedPath, absentPath],
        });
      } finally {
        fs.chmodSync(deniedDir, 0o700);
      }

      expect(result).toEqual({
        incompatible: [
          {
            kind: "agent",
            path: visiblePath,
            foundVersion: OPENCLAW_AGENT_SCHEMA_VERSION + 1,
            supportedVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
          },
        ],
        indeterminate: [
          {
            kind: "agent",
            path: deniedPath,
            reason: expect.stringMatching(/EACCES|permission denied/iu),
          },
        ],
      });
    },
  );
});
