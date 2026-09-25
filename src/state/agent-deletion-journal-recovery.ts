import { randomUUID } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import {
  readLegacyMigrationReceiptFromDatabase,
  recordLegacyMigrationReceipt,
} from "../infra/state-migrations.receipts.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { createOpenClawAgentDatabasePathMatcher } from "./openclaw-agent-db.paths.js";
import type { OpenClawStateDatabase } from "./openclaw-state-db-contract.js";
import {
  assertAgentDeletionJournalAvailable,
  reconstructAgentDeletionJournalSchema,
} from "./openclaw-state-db-schema-additive.js";
import type { DB } from "./openclaw-state-db.generated.js";
import {
  resolveOpenClawAgentDatabaseStoredPath,
  resolveOpenClawRegisteredAgentDatabasePath,
} from "./openclaw-state-db.paths.js";

export type HeldAgentDatabase = { agentId: string; path: string };
type RecoveryDatabase = Pick<OpenClawStateDatabase, "db" | "path">;
type RecoveryReport = { description: string; held: HeldAgentDatabase[] };
type RecoveryTables = Pick<DB, "migration_sources">;

const SOURCE_KEY = "agent-deletion-journal-reconstruction";
const JOURNAL_TABLE = "agent_deletion_journal";
const DESCRIPTION =
  "Reconstructed the missing agent deletion journal; held databases require explicit agent restore or delete.";

function readReport(database: RecoveryDatabase): RecoveryReport | undefined {
  const receipt = readLegacyMigrationReceiptFromDatabase(database.db, SOURCE_KEY);
  if (!receipt) {
    return undefined;
  }
  const report: unknown = JSON.parse(receipt.reportJson);
  if (!isRecord(report) || typeof report.description !== "string" || !Array.isArray(report.held)) {
    throw new Error("Invalid agent deletion journal reconstruction receipt.");
  }
  const held = report.held.map((entry: unknown) => {
    if (
      !isRecord(entry) ||
      typeof entry.agentId !== "string" ||
      entry.agentId !== normalizeAgentId(entry.agentId) ||
      typeof entry.path !== "string" ||
      !entry.path.trim()
    ) {
      throw new Error("Invalid agent database hold in deletion journal reconstruction receipt.");
    }
    return { agentId: entry.agentId, path: entry.path };
  });
  return { description: report.description, held };
}

function decodeHolds(database: RecoveryDatabase, held: readonly HeldAgentDatabase[]) {
  return held.map((entry) => ({
    agentId: entry.agentId,
    path: resolveOpenClawRegisteredAgentDatabasePath(database.path, entry.path),
  }));
}

/** Read recovery facts from this exact shared-state generation without opening another database. */
export function readAgentDeletionRecoveryHolds(database: RecoveryDatabase): HeldAgentDatabase[] {
  return decodeHolds(database, readReport(database)?.held ?? []);
}

/** Schema and Doctor producers cannot infer permission to repair an unverified store. */
export function assertAgentDeletionRecoveryAllowsMutation(
  database: RecoveryDatabase,
  pathname: string,
): void {
  assertAgentDeletionJournalAvailable(database.db);
  const samePath = createOpenClawAgentDatabasePathMatcher();
  const held = readAgentDeletionRecoveryHolds(database).find((entry) =>
    samePath(entry.path, pathname),
  );
  if (held) {
    throw new Error(
      `Agent database ${held.path} is held after deletion journal reconstruction. Run openclaw doctor --fix for explicit restoration guidance before repairing agent ${held.agentId}.`,
    );
  }
}

/** The caller's transaction commits canonical reconstruction and its receipt together. */
export function reconstructAgentDeletionJournal(
  database: RecoveryDatabase,
  held: readonly HeldAgentDatabase[],
  now = Date.now(),
): HeldAgentDatabase[] {
  if (!database.db.isTransaction) {
    throw new Error("Agent deletion journal reconstruction requires a shared-state transaction.");
  }
  const previous = readReport(database);
  if (!reconstructAgentDeletionJournalSchema(database.db, database.path)) {
    return decodeHolds(database, previous?.held ?? []);
  }
  const entries = new Map<string, HeldAgentDatabase>();
  for (const entry of [
    ...(previous?.held ?? []),
    ...held.map((target) => ({
      agentId: normalizeAgentId(target.agentId),
      path: resolveOpenClawAgentDatabaseStoredPath(database.path, target.path),
    })),
  ]) {
    entries.set(JSON.stringify([entry.agentId, entry.path]), entry);
  }
  const report: RecoveryReport = { description: DESCRIPTION, held: [...entries.values()] };
  recordLegacyMigrationReceipt(database.db, {
    sourceKey: SOURCE_KEY,
    migrationKind: SOURCE_KEY,
    sourcePath: database.path,
    targetTable: JOURNAL_TABLE,
    sourceSha256: null,
    sourceSizeBytes: null,
    sourceRecordCount: null,
    runId: `${SOURCE_KEY}:${randomUUID()}`,
    now,
    reportJson: JSON.stringify(report),
    upsert: true,
  });
  return decodeHolds(database, report.held);
}

/** Resolve only explicit targets; the immutable run report keeps the original reconstruction. */
export function resolveAgentDeletionRecoveryHolds(
  database: RecoveryDatabase,
  agentId: string,
  targetPaths: readonly string[],
): number {
  if (!database.db.isTransaction) {
    throw new Error("Agent deletion recovery resolution requires a shared-state transaction.");
  }
  const report = readReport(database);
  if (!report) {
    return 0;
  }
  const id = normalizeAgentId(agentId);
  const targets = new Set(
    targetPaths.map((pathname) => resolveOpenClawAgentDatabaseStoredPath(database.path, pathname)),
  );
  const held = report.held.filter((entry) => entry.agentId !== id || !targets.has(entry.path));
  const removed = report.held.length - held.length;
  if (removed > 0) {
    executeSqliteQuerySync(
      database.db,
      getNodeSqliteKysely<RecoveryTables>(database.db)
        .updateTable("migration_sources")
        .set({ report_json: JSON.stringify({ ...report, held }) })
        .where("source_key", "=", SOURCE_KEY),
    );
  }
  return removed;
}
