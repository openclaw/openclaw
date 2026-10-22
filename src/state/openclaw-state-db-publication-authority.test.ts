import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveGatewayLockDir } from "../config/paths.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { resolveGatewayStateOwnerPath } from "../infra/gateway-state-owner.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { createUpdateRun } from "../infra/update-run-ledger.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import {
  expectRow,
  expectRows,
  readRow,
  readRows,
} from "./openclaw-state-db-fixtures.test-support.js";
import {
  ensureGitHubPublicationSchema,
  ensureGitHubPublicationSessionLifecycleSchema,
  ensureRepositoryGitHubPublicationSchema,
} from "./openclaw-state-db-schema-additive.js";
import { tableExists, tableHasColumn } from "./openclaw-state-db-schema-helpers.js";
import {
  closeOpenClawStateDatabaseForTest,
  detectOpenClawStateDatabaseSchemaMigrations,
  openOpenClawStateDatabase,
  repairOpenClawStateDatabaseSchema,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import {
  addPreCutoverClientCredentialTablesForTest,
  withStateMigrationBackupForTest,
} from "./openclaw-state-schema.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const authorityTables = [
  "github_publication_session_lifecycles",
  "github_repository_publication_requests",
] as const;
const migrationPaths = ["runtime open", "doctor repair"] as const;

afterEach(() => closeOpenClawStateDatabaseForTest());

function readSnapshot(db: EngineConnection) {
  return {
    version: readRow(db, "PRAGMA user_version"),
    metadata: readRows(db, "SELECT * FROM schema_meta"),
    machineState: readRows(db, "SELECT * FROM config_machine_state ORDER BY state_key"),
    schema: readRows(db, "SELECT type, name, sql FROM sqlite_schema ORDER BY type, name"),
    receipts: Object.fromEntries(
      ["github_publication_requests", ...authorityTables].map(
        (table) =>
          [
            table,
            tableExists(db, table)
              ? readRows(db, `SELECT rowid, * FROM ${table} ORDER BY request_id`)
              : [],
          ] as const,
      ),
    ),
  };
}

function createV17PublicationState(options: { populated?: boolean; deferred?: boolean } = {}) {
  const databaseOptions = {
    env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-publication-v17-") },
  };
  const initial = openOpenClawStateDatabase(databaseOptions);
  if (options.deferred) {
    createUpdateRun({ trigger: "cli", before: { version: "2026.9.2" } }, databaseOptions);
  }
  if (options.populated !== false) {
    ensureGitHubPublicationSchema(initial.db);
    ensureGitHubPublicationSessionLifecycleSchema(initial.db);
    ensureRepositoryGitHubPublicationSchema(initial.db);
  }
  const databasePath = initial.path;
  closeOpenClawStateDatabaseForTest();
  using legacy = openNodeSqliteDatabase(databasePath);
  addPreCutoverClientCredentialTablesForTest(legacy);
  if (options.populated !== false) {
    for (const table of authorityTables) {
      if (tableHasColumn(legacy, table, "requester_authority_json")) {
        legacy.exec(`ALTER TABLE ${table} DROP COLUMN requester_authority_json;`);
      }
    }
    for (const status of ["requested", "published"] as const) {
      const url = status === "published" ? "https://github.com/example/project/pull/1" : null;
      legacy
        .prepare(`INSERT INTO github_publication_requests (
          request_id, idempotency_key, request_digest, session_id, session_key, agent_id,
          worktree_id, repository_fingerprint, identity_source, identity_profile_id,
          identity_account_id, identity_login, status, repository, branch, base_branch,
          head_commit, pull_request_url, created_at_ms, updated_at_ms
        ) VALUES (?, ?, 'digest', 'session', 'agent:main:publication', 'main',
          'worktree', 'fingerprint', 'system-configured', 'publisher-profile',
          42, 'publisher', ?, 'example/project', 'changes', 'main', ?, ?, 10, 20)`)
        .run(`local-${status}`, status, status, "a".repeat(40), url);
      legacy
        .prepare(`INSERT INTO github_publication_session_lifecycles
          (publication_kind, request_id, lifecycle_revision)
          VALUES ('shared', ?, 'original-lifecycle')`)
        .run(`local-${status}`);
      legacy
        .prepare(`INSERT INTO github_repository_publication_requests (
          request_id, idempotency_key, request_digest, session_id, session_lifecycle_revision,
          session_key, agent_id, workspace_id, identity_source, identity_profile_id,
          identity_account_id, identity_login, status, push_repository, repository,
          branch, base_branch, head_commit, pull_request_url, last_effect, effect_state,
          created_at_ms, updated_at_ms
        ) VALUES (?, ?, 'digest', 'session', 'original-lifecycle',
          'agent:main:publication', 'main', 'workspace', 'system-configured', 'publisher-profile',
          42, 'publisher', ?, 'example/project', 'example/project',
          'changes', 'main', ?, ?, ?, ?, 10, 20)`)
        .run(
          `repository-${status}`,
          status,
          status,
          "a".repeat(40),
          url,
          url ? "pull_request" : null,
          url ? "observed" : null,
        );
    }
    legacy.exec(`INSERT INTO github_publication_session_lifecycles
        (publication_kind, request_id, lifecycle_revision) VALUES ('personal', 'personal-history', NULL);`);
  }
  legacy.exec("PRAGMA user_version = 17; UPDATE schema_meta SET schema_version = 17;");
  if (options.deferred) {
    legacy.exec(`
        PRAGMA user_version = 15;
        UPDATE schema_meta SET schema_version = 15;
        INSERT INTO config_machine_state (state_key, value_json, updated_at_ms)
          VALUES ('state.schema.contentVersion', '17', 1);
      `);
  }
  return { options: databaseOptions, databasePath, before: readSnapshot(legacy) };
}

describe("GitHub publication requester authority schema migration", () => {
  it("keeps schema 17 unchanged while local identity loads beside a published Gateway owner", async () => {
    const { options, databasePath, before } = createV17PublicationState();
    const projectionPath = path.join(
      resolveGatewayLockDir(options.env.OPENCLAW_STATE_DIR),
      "gateway.state.lock",
    );
    const previousOwner = JSON.stringify({
      pid: process.pid,
      createdAt: new Date().toISOString(),
      configPath: path.join(options.env.OPENCLAW_STATE_DIR, "openclaw.json"),
      role: "gateway",
    });
    // v2026.9.4 holds this file alongside its retired SQLite coordinator; it
    // does not know the replacement external sidecar.
    fs.mkdirSync(path.dirname(projectionPath), { recursive: true });
    fs.writeFileSync(projectionPath, previousOwner, { flag: "wx" });
    try {
      expect(loadOrCreateDeviceIdentity(options).deviceId).toMatch(/^[a-f0-9]{64}$/u);
      {
        using unchanged = openNodeSqliteDatabase(databasePath, { readOnly: true });
        expect(readSnapshot(unchanged)).toEqual(before);
      }
      expect(fs.readFileSync(projectionPath, "utf8")).toBe(previousOwner);
      expect(fs.existsSync(resolveGatewayStateOwnerPath(databasePath))).toBe(false);
    } finally {
      fs.rmSync(projectionPath);
    }
    expect(loadOrCreateDeviceIdentity(options).deviceId).toMatch(/^[a-f0-9]{64}$/u);
    await withStateMigrationBackupForTest(options, () => openOpenClawStateDatabase(options));
    const migrated = openOpenClawStateDatabase(options);
    expectRow(migrated.db, "PRAGMA user_version", {
      user_version: OPENCLAW_STATE_SCHEMA_VERSION,
    });
    expect(fs.existsSync(projectionPath)).toBe(false);
  });

  it.each([
    { via: "runtime open", deferred: false },
    { via: "doctor repair", deferred: false },
    { via: "doctor repair", deferred: true },
  ] as const)(
    "preserves receipts and unknown requesters through captured $via (deferred: $deferred)",
    async ({ via, deferred }) => {
      const { options, databasePath, before } = createV17PublicationState({ deferred });
      expect(detectOpenClawStateDatabaseSchemaMigrations(options)).toEqual([
        { kind: "github-publication-requester-authority-v18", path: databasePath },
        { kind: "predicate-columns-v21", path: databasePath },
        { kind: "portable-identity-columns-v22", path: databasePath },
        { kind: "meeting-transcript-start-time", path: databasePath },
        { kind: "task-run-indexes-v24", path: databasePath },
        { kind: "subagent-operator-recovery-v25", path: databasePath },
        { kind: "session-state-head-layout-v26", path: databasePath },
        { kind: "state-write-indexes-v27", path: databasePath },
        { kind: "github-publication-draft-v28", path: databasePath },
        { kind: "local-client-credentials-v29", path: databasePath },
        { kind: "automation-policy-fence-v30", path: databasePath },
      ]);
      if (via === "doctor repair") {
        expect(
          await withStateMigrationBackupForTest(options, () =>
            repairOpenClawStateDatabaseSchema(options),
          ),
        ).toEqual({
          changes: [
            "Added original requester authority to GitHub publication receipts (v18)",
            "Replaced retained task indexes with ordered cron history indexes (v24)",
            "Removed redundant replay and skill indexes and narrowed the lease-owner index (v27)",
          ],
          warnings: [],
        });
      }
      await withStateMigrationBackupForTest(options, () => openOpenClawStateDatabase(options));
      const { db } = openOpenClawStateDatabase(options);
      expect(readSnapshot(db).receipts).toEqual(
        Object.fromEntries(
          Object.entries(before.receipts).map(([table, rows]) => [
            table,
            rows.map((row) =>
              table === "github_publication_requests"
                ? row
                : { ...row, requester_authority_json: null },
            ),
          ]),
        ),
      );
      const publishedVersion = deferred ? 15 : OPENCLAW_STATE_SCHEMA_VERSION;
      expectRow(db, "PRAGMA user_version", { user_version: publishedVersion });
      expectRow(db, "SELECT schema_version FROM schema_meta", {
        schema_version: publishedVersion,
      });
      if (deferred) {
        expectRow(
          db,
          "SELECT value_json FROM config_machine_state WHERE state_key = ?",
          { value_json: String(OPENCLAW_STATE_SCHEMA_VERSION) },
          "state.schema.contentVersion",
        );
      }
      expectRows(db, "PRAGMA foreign_key_check", []);
      expectRow(db, "PRAGMA integrity_check", { integrity_check: "ok" });
      const after = readSnapshot(db);
      closeOpenClawStateDatabaseForTest();
      expect(readSnapshot(openOpenClawStateDatabase(options).db)).toEqual(after);
    },
  );

  it.each(migrationPaths)(
    "rolls back receipt columns and version facts after failed %s",
    async (via) => {
      const { options, databasePath } = createV17PublicationState();
      const legacy = openNodeSqliteDatabase(databasePath);
      legacy.exec(`CREATE TRIGGER fixture_reject_upgrade BEFORE UPDATE ON schema_meta
      BEGIN SELECT RAISE(ABORT, 'publication authority migration rollback'); END;`);
      const before = readSnapshot(legacy);
      legacy.close();
      if (via === "runtime open") {
        await expect(
          withStateMigrationBackupForTest(options, () => openOpenClawStateDatabase(options)),
        ).rejects.toThrow(/publication authority migration rollback/);
      } else {
        expect(
          await withStateMigrationBackupForTest(options, () =>
            repairOpenClawStateDatabaseSchema(options),
          ),
        ).toEqual({
          changes: [],
          warnings: [expect.stringContaining("publication authority migration rollback")],
        });
      }
      using preserved = openNodeSqliteDatabase(databasePath, { readOnly: true });
      expect(readSnapshot(preserved)).toEqual(before);
    },
  );

  it("keeps unused tables absent and creates the new columns only with their first write", async () => {
    const { options } = createV17PublicationState({ populated: false });
    await withStateMigrationBackupForTest(options, () => openOpenClawStateDatabase(options));
    const { db } = openOpenClawStateDatabase(options);
    const ensureTables = () => {
      ensureGitHubPublicationSessionLifecycleSchema(db);
      ensureRepositoryGitHubPublicationSchema(db);
    };
    const hasTables = () => authorityTables.map((table) => tableExists(db, table));
    expect(hasTables()).toEqual([false, false]);
    expect(() =>
      runOpenClawStateWriteTransaction(() => {
        ensureTables();
        throw new Error("admission refused");
      }, options),
    ).toThrow("admission refused");
    expect(hasTables()).toEqual([false, false]);
    runOpenClawStateWriteTransaction(ensureTables, options);
    for (const table of authorityTables) {
      expect(db.prepare(`PRAGMA table_info(${table})`).all()).toContainEqual(
        expect.objectContaining({
          name: "requester_authority_json",
          type: "TEXT",
          notnull: 0,
          dflt_value: null,
        }),
      );
    }
  });
});
