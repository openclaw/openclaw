import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { DuplicateAgentError } from "../agents/agent-create-error.js";
import { readLegacyMigrationReceiptFromDatabase } from "../infra/state-migrations.receipts.js";
import { normalizeAgentId } from "../routing/session-key.js";
import type {
  AgentDeletionRecoveryHoldPredicate,
  HeldAgentDatabase,
} from "./agent-deletion-journal.types.js";
import type { OpenClawStateDatabase } from "./openclaw-state-db-contract.js";
import { resolveOpenClawRegisteredAgentDatabasePath } from "./openclaw-state-db.paths.js";

export type RecoveryDatabase = Pick<OpenClawStateDatabase, "db" | "path">;
export type RecoveryReport = { description: string; held: HeldAgentDatabase[] };
export type { AgentDeletionRecoveryHoldPredicate } from "./agent-deletion-journal.types.js";

export const AGENT_DELETION_RECOVERY_SOURCE_KEY = "agent-deletion-journal-reconstruction";

export function readReport(database: RecoveryDatabase): RecoveryReport | undefined {
  const receipt = readLegacyMigrationReceiptFromDatabase(
    database.db,
    AGENT_DELETION_RECOVERY_SOURCE_KEY,
  );
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

export function decodeHolds(database: RecoveryDatabase, held: readonly HeldAgentDatabase[]) {
  return held.map((entry) => ({
    agentId: entry.agentId,
    path: resolveOpenClawRegisteredAgentDatabasePath(database.path, entry.path),
  }));
}

/** Read recovery facts from this exact shared-state generation without opening another database. */
export function readAgentDeletionRecoveryHolds(database: RecoveryDatabase): HeldAgentDatabase[] {
  return decodeHolds(database, readReport(database)?.held ?? []);
}

export function assertAgentDeletionRecoveryHoldPredicate(
  database: RecoveryDatabase,
  predicate?: AgentDeletionRecoveryHoldPredicate,
): void {
  if (
    predicate?.applies &&
    readAgentDeletionRecoveryHolds(database).some(
      (entry) =>
        entry.agentId === predicate.agentId &&
        !predicate.held.some(
          (previous) => previous.agentId === entry.agentId && previous.path === entry.path,
        ),
    )
  ) {
    throw new DuplicateAgentError(
      `Agent ${predicate.agentId} has held databases. Restore its original agentDir and session.store configuration, then run agents add explicitly to restore the preserved store.`,
    );
  }
}
