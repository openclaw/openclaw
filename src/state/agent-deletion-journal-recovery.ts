import { randomUUID } from "node:crypto";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { recordLegacyMigrationReceipt } from "../infra/state-migrations.receipts.js";
import { normalizeAgentId } from "../routing/session-key.js";
import {
  AGENT_DELETION_RECOVERY_SOURCE_KEY as SOURCE_KEY,
  assertAgentDeletionRecoveryHoldsMatch,
  decodeHolds,
  readAgentDeletionRecoveryHolds,
  readReport,
  type RecoveryDatabase,
  type RecoveryReport,
  type AgentDeletionRecoveryHoldPredicate,
} from "./agent-deletion-journal-recovery.kernel.js";
import type { HeldAgentDatabase } from "./agent-deletion-journal.types.js";
import { createOpenClawAgentDatabasePathMatcher } from "./openclaw-agent-db.paths.js";
import {
  assertAgentDeletionJournalAvailable,
  reconstructAgentDeletionJournalSchema,
} from "./openclaw-state-db-schema-additive.js";
import type { DB } from "./openclaw-state-db.generated.js";
import { resolveOpenClawAgentDatabaseStoredPath } from "./openclaw-state-db.paths.js";

type RecoveryTables = Pick<DB, "migration_sources">;

const JOURNAL_TABLE = "agent_deletion_journal";
const DESCRIPTION =
  "Reconstructed the missing agent deletion journal; held databases require explicit agent restore or delete.";

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
  return recordAgentDeletionRecoveryHolds(database, held, { now });
}

/** Quarantine and reconstruction use the same durable maintenance holds. */
export function recordAgentDeletionRecoveryHolds(
  database: RecoveryDatabase,
  held: readonly HeldAgentDatabase[],
  { now = Date.now(), description = DESCRIPTION }: { now?: number; description?: string } = {},
): HeldAgentDatabase[] {
  if (!database.db.isTransaction) {
    throw new Error("Agent deletion recovery requires a shared-state transaction.");
  }
  const previous = readReport(database);
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
  const report: RecoveryReport = { description, held: [...entries.values()] };
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
  predicate?: AgentDeletionRecoveryHoldPredicate,
): number {
  if (!database.db.isTransaction) {
    throw new Error("Agent deletion recovery resolution requires a shared-state transaction.");
  }
  const report = readReport(database);
  if (predicate) {
    assertAgentDeletionRecoveryHoldsMatch(decodeHolds(database, report?.held ?? []), predicate);
  }
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
