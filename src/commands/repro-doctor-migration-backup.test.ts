import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { installSqliteFtsTokenizerMismatch } from "../infra/sqlite-index-corruption.test-support.js";
import { prepareAgentDatabaseMigrationDiscovery } from "../infra/state-migrations.media-persistence-targets.js";
import { migrateLegacyMediaPersistence } from "../infra/state-migrations.media-persistence.js";
import { runWithDoctorMigrationBackup } from "../infra/update-doctor-migration-attribution.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db.js";
import { preflightOpenClawDatabaseSchemas } from "../state/openclaw-database-preflight.js";
import { CLIENT_CREDENTIAL_CUTOVER_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { markStateDatabaseVersion } from "../state/openclaw-state-db-historical-fixtures.test-support.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { captureFreshDoctorMigrationTables } from "./doctor-migration-backup.js";
import { prepareDoctorDatabaseMigrations } from "./doctor-schema-migrations.js";
import { withMaintenance } from "./doctor-schema-migrations.test-support.js";

it("repairs canonical FTS damage during pending agent and credential migrations", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const sharedPath = openOpenClawStateDatabase({ env: state.env }).path;
    await closeOpenClawStateDatabaseAsync();
    const pathname = state.statePath("agents", "main", "agent", "openclaw-agent.sqlite");
    await closeOpenClawAgentDatabasesAsync();
    const fixtureAgentPath = path.resolve(
      process.cwd(),
      "test/fixtures/state-corpus-populated/2026.10.10/state/agents/main/agent/openclaw-agent.sqlite",
    );
    fs.mkdirSync(path.dirname(pathname), { recursive: true });
    fs.copyFileSync(fixtureAgentPath, pathname);
    fs.rmSync(`${pathname}.seal`, { force: true });
    {
      using database = new DatabaseSync(pathname);
      database.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_index_chunks_fts USING fts5(
          text,
          id UNINDEXED,
          path UNINDEXED,
          source UNINDEXED,
          model UNINDEXED,
          start_line UNINDEXED,
          end_line UNINDEXED
        );
        INSERT INTO memory_index_chunks_fts(text) VALUES ('ab'||char(65534)||'cd');
      `);
      database.exec("INSERT INTO session_transcript_fts(text) VALUES ('ab'||char(65534)||'cd')");
    }
    installSqliteFtsTokenizerMismatch(pathname, "memory_index_chunks_fts");
    installSqliteFtsTokenizerMismatch(pathname, "session_transcript_fts");
    {
      using database = new DatabaseSync(sharedPath);
      markStateDatabaseVersion(database, CLIENT_CREDENTIAL_CUTOVER_SCHEMA_VERSION - 1);
    }

    const configuredAgentDatabaseTargets = [{ agentId: "main", path: pathname }];
    const preflight = await preflightOpenClawDatabaseSchemas({
      env: state.env,
      configuredAgentDatabaseTargets,
      verifyCurrentSchemaShape: true,
    });
    expect(preflight.indeterminate).toEqual([
      expect.objectContaining({
        kind: "agent",
        path: pathname,
        reason: expect.stringContaining("schema version 27"),
      }),
    ]);
    expect(preflight.pendingMigrations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "state",
          foundVersion: CLIENT_CREDENTIAL_CUTOVER_SCHEMA_VERSION - 1,
        }),
      ]),
    );
    expect(preflight.pendingMigrations).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "agent", foundVersion: 27 })]),
    );

    const discovery = prepareAgentDatabaseMigrationDiscovery({
      env: state.env,
      configuredAgentDatabaseTargets,
    });
    await withMaintenance(() =>
      runWithDoctorMigrationBackup(captureFreshDoctorMigrationTables, async () => {
        const prepared = await prepareDoctorDatabaseMigrations({
          env: state.env,
          check: "full",
          pendingDatabasePaths: preflight.pendingMigrations!.map((entry) => entry.path),
          pendingMigrations: preflight.pendingMigrations,
          databasePaths: [pathname],
          agentDatabaseTargets: [
            { agentId: "main", path: pathname, realPath: pathname, source: "disk" },
          ],
        });
        expect(prepared.warnings).toEqual([]);
        discovery.versionMigrations = prepared.versionMigrations;
        const repaired = await migrateLegacyMediaPersistence({
          env: state.env,
          integrityCheck: "full",
          preparedDiscovery: discovery,
        });
        expect(repaired.warnings).toEqual([]);
      }),
    );

    const agentBackups = fs
      .readdirSync(path.dirname(pathname))
      .filter(
        (name) =>
          name.startsWith(`${path.basename(pathname)}.pre-startup-migration-`) &&
          name.endsWith(".bak"),
      );
    expect(agentBackups).toHaveLength(1);
    using agentBackup = new DatabaseSync(path.join(path.dirname(pathname), agentBackups[0]!), {
      readOnly: true,
    });
    const backupFindings = agentBackup
      .prepare("PRAGMA integrity_check")
      .all()
      .map((row) => row.integrity_check);
    expect(backupFindings).toEqual(
      expect.arrayContaining([
        "malformed inverted index for FTS5 table main.memory_index_chunks_fts",
        "malformed inverted index for FTS5 table main.session_transcript_fts",
      ]),
    );
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();

    const after = await preflightOpenClawDatabaseSchemas({
      env: state.env,
      configuredAgentDatabaseTargets,
      verifyCurrentSchemaShape: true,
    });
    expect(after.pendingMigrations ?? []).toEqual([]);
    using agent = new DatabaseSync(pathname, { readOnly: true });
    expect(agent.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
  });
});
