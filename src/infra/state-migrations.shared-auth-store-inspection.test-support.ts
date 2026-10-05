import { expect } from "vitest";
import {
  inspectSharedAuthPluginArtifactsReadOnly,
  withFreshOpenClawAgentDatabaseReadOnly,
} from "../plugin-sdk/sqlite-runtime.js";
import { runSqliteDeferredTransactionSync } from "../plugin-sdk/sqlite-worker-runtime.js";
import { writePersistedInstalledPluginIndex } from "../plugins/installed-plugin-index-store-write.js";
import { createInstalledPluginIndex } from "../plugins/test-helpers/installed-plugin-index.js";
import * as stateDb from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { readSqliteArtifactBytesFromChild } from "./sqlite-posix-locks.test-support.js";
import {
  recordLegacyMigrationSource,
  recordLegacyMigrationRun,
} from "./state-migrations.receipts.js";
import * as migration from "./state-migrations.shared-auth-store.js";

export async function verifySupportedSharedAuthArtifactInspection(fixture: {
  env: NodeJS.ProcessEnv;
  sourcePath: string;
  stateDir: string;
}) {
  const detected = migration.detectSharedAuthStoreMigration({
    stateDir: fixture.stateDir,
    doctorOnlyStateMigrations: true,
  });
  await migration.migrateSharedAuthStore({ detected, stateDir: fixture.stateDir });
  const files = [fixture.sourcePath, resolveOpenClawStateSqlitePath(fixture.env)];
  const observation = withFreshOpenClawAgentDatabaseReadOnly(
    (native) =>
      runSqliteDeferredTransactionSync(native.db, () => {
        // This is the observer delta inside existing admission, not pristine cold-open preservation.
        const bytes = files.map(readSqliteArtifactBytesFromChild);
        const value = inspectSharedAuthPluginArtifactsReadOnly(native, { env: fixture.env });
        expect(files.map(readSqliteArtifactBytesFromChild)).toEqual(bytes);
        expect(native.db.isOpen).toBe(true);
        return value;
      }),
    { agentId: "main", path: fixture.sourcePath, env: fixture.env },
  );
  expect(observation.found).toBe(true);
  if (!observation.found || observation.value.status !== "observed") {
    throw new Error("Expected supported callback observation");
  }
  const facts = observation.value.facts;
  expect(facts).toMatchObject({
    canonicalValidation: false,
    ownership: { location: "state-db" },
    pendingCleanup: false,
    source: { store: { rowCount: 0 }, state: { rowCount: 0 } },
    target: { store: { rowCount: 0 }, state: { rowCount: 0 } },
    migration: { sourceCount: 2, unexpectedSourceCount: 0, runCount: 1, unexpectedRunCount: 0 },
    pluginInstallState: { status: "missing" },
  });
  for (const receipt of facts.migration.sources) {
    expect(receipt).toMatchObject({
      status: "present",
      sourcePathMatches: true,
      targetMatches: true,
      sourceRecordCount: 0,
      sourceSha256: "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b",
      stage: "completed",
      removedSource: true,
      removalValid: true,
      sourceReportMatches: true,
      run: { present: true, expectedRunMatches: true, stage: "completed", reportMatches: true },
    });
  }
  expect(JSON.stringify(facts)).not.toContain(fixture.stateDir);
  const inspectPlugin = () =>
    withFreshOpenClawAgentDatabaseReadOnly(
      (native) => inspectSharedAuthPluginArtifactsReadOnly(native, { env: fixture.env }),
      { agentId: "main", path: fixture.sourcePath, env: fixture.env },
    );
  await writePersistedInstalledPluginIndex(createInstalledPluginIndex({ plugins: [] }), {
    env: fixture.env,
  });
  expect(inspectPlugin()).toMatchObject({
    found: true,
    value: {
      status: "observed",
      facts: {
        pluginInstallState: { status: "valid", recordCount: 0 },
      },
    },
  });
  const secret = "synthetic-private-plugin-payload";
  await writePersistedInstalledPluginIndex(
    createInstalledPluginIndex({
      plugins: [],
      installRecords: { demo: { source: "npm", spec: secret } },
    }),
    { env: fixture.env },
  );
  const populated = inspectPlugin();
  expect(populated).toMatchObject({
    found: true,
    value: {
      status: "observed",
      facts: {
        pluginInstallState: { status: "valid", recordCount: 1 },
      },
    },
  });
  expect(JSON.stringify(populated)).not.toContain(secret);
  stateDb.runOpenClawStateWriteTransaction(
    ({ db }) => {
      recordLegacyMigrationRun(db, {
        runId: "shared-auth-store:fixture-extra",
        startedAt: 1,
        finishedAt: null,
        status: "copied",
        reportJson: "synthetic-private-report",
      });
      recordLegacyMigrationSource(db, {
        sourceKey: "fixture-extra",
        migrationKind: "shared-auth-store-state-db",
        sourcePath: fixture.sourcePath,
        targetTable: "auth_profile_stores",
        sourceSha256: null,
        sourceSizeBytes: null,
        sourceRecordCount: null,
        runId: "shared-auth-store:fixture-extra",
        status: "copied",
        importedAt: 1,
        reportJson: "synthetic-private-report",
      });
    },
    { env: fixture.env },
  );
  const unexpected = inspectPlugin();
  expect(unexpected).toMatchObject({
    found: true,
    value: {
      status: "observed",
      facts: {
        pendingCleanup: true,
        migration: {
          sourceCount: 3,
          unexpectedSourceCount: 1,
          runCount: 2,
          unexpectedRunCount: 1,
        },
      },
    },
  });
  expect(JSON.stringify(unexpected)).not.toContain("synthetic-private-report");
}
