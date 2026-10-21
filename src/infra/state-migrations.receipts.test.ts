import { createHash } from "node:crypto";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import {
  markLegacyMigrationSourceRemoved,
  readLegacyMigrationReceipt,
  recordLegacyMigrationReceipt,
  recordLegacyMigrationRun,
  recordLegacyMigrationSource,
  resolveLegacyMigrationSourceKey,
} from "./state-migrations.receipts.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    cleanup();
  });
});

function createFixture() {
  const stateDir = tempDirs.make("openclaw-migration-receipts-");
  const sourcePath = path.join(stateDir, "legacy.json");
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const receipt = {
    sourceKey: resolveLegacyMigrationSourceKey("test-json", sourcePath),
    migrationKind: "legacy-test-json",
    sourcePath,
    targetTable: "device_identities",
    sourceSha256: "a".repeat(64),
    sourceSizeBytes: 12,
    sourceRecordCount: 1,
    runId: "legacy-test-run",
    now: 123,
    reportJson: '{"preserved":true}',
  };
  const { db } = openOpenClawStateDatabase({ env });
  const write = (run: (connection: typeof db) => void) =>
    runOpenClawStateWriteTransaction(({ db: connection }) => run(connection), { env });
  write((connection) => recordLegacyMigrationReceipt(connection, receipt));
  const source = () =>
    db.prepare("SELECT * FROM migration_sources WHERE source_key = ?").get(receipt.sourceKey);
  const read = () => readLegacyMigrationReceipt(receipt.sourceKey, env);
  const remove = (label?: string) =>
    markLegacyMigrationSourceRemoved(receipt.sourceKey, env, label);
  return { receipt, db, source, write, read, remove };
}

it("preserves persisted source-key hashing with optional ownership scope", () => {
  const sourcePath = path.join("fixtures", "legacy.json");
  const resolvedPath = path.resolve(sourcePath);
  const digest = createHash("sha256").update(resolvedPath).digest("hex");
  const scopedDigest = createHash("sha256").update(`workspace-a\0${resolvedPath}`).digest("hex");

  expect(resolveLegacyMigrationSourceKey("test-json", sourcePath)).toBe(`test-json:${digest}`);
  expect(resolveLegacyMigrationSourceKey("test-json", sourcePath, "workspace-a")).toBe(
    `test-json:${scopedDigest}`,
  );
  expect(resolveLegacyMigrationSourceKey("test-json", sourcePath, "workspace-b")).not.toBe(
    `test-json:${scopedDigest}`,
  );
});

it("records, rejects duplicates, removes, and resumes a receipt without replacing its report", () => {
  const { receipt, db: database, source, write, read, remove } = createFixture();
  const { sourceKey, reportJson } = receipt;
  const preserved = { sourceKey, reportJson, removedSource: false };
  expect(read()).toEqual({ ...preserved, sourceSha256: receipt.sourceSha256 });
  expect(() => write((db) => recordLegacyMigrationReceipt(db, receipt))).toThrow();

  remove("test migration cleanup");

  expect(read()?.removedSource).toBe(true);
  expect(source()).toMatchObject({
    migration_kind: receipt.migrationKind,
    target_table: receipt.targetTable,
    source_size_bytes: receipt.sourceSizeBytes,
    source_record_count: receipt.sourceRecordCount,
    status: "completed",
    removed_source: 1,
  });
  remove();
  write((db) => {
    recordLegacyMigrationRun(db, {
      runId: receipt.runId,
      startedAt: receipt.now + 1,
      finishedAt: receipt.now + 2,
      status: "archived",
      reportJson: '{"resumed":true}',
      upsert: true,
    });
    recordLegacyMigrationSource(db, {
      ...receipt,
      sourceSha256: "b".repeat(64),
      sourceSizeBytes: 24,
      sourceRecordCount: 2,
      status: "archived",
      importedAt: receipt.now + 2,
      reportJson: '{"preserved":false}',
      upsert: true,
      updateReportOnConflict: false,
    });
  });

  expect(
    database.prepare("SELECT * FROM migration_runs WHERE id = ?").get(receipt.runId),
  ).toMatchObject({
    started_at: receipt.now,
    finished_at: receipt.now + 2,
    status: "archived",
    report_json: '{"resumed":true}',
  });
  expect(read()).toEqual({ ...preserved, sourceSha256: "b".repeat(64) });
  expect(source()).toMatchObject({ source_size_bytes: 24, source_record_count: 2 });
});
