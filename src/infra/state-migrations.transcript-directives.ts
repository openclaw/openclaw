import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { updateSqliteTranscriptEventJsonInTransaction } from "../config/sessions/session-accessor.sqlite-transcript-store.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import type { OpenClawAgentDatabase } from "../state/openclaw-agent-db-contract.js";
import {
  OpenClawAgentDatabaseLeaseActiveError,
  assertAgentDatabaseMaintenanceAuthority,
  assertNoOpenClawAgentDatabaseLeases,
} from "../state/openclaw-agent-db-lease.js";
import { withAgentDatabaseMaintenanceLease } from "../state/openclaw-agent-db-maintenance-lease.js";
import {
  assertOpenClawAgentDatabaseForMaintenance,
  migrateOpenClawAgentDatabaseForMaintenance,
} from "../state/openclaw-agent-db-maintenance.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "../state/openclaw-state-db.js";
import type { OpenClawStateLeaseContext } from "../state/openclaw-state-lease.js";
import {
  clearNodeSqliteKyselyCacheForDatabase,
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { backupDoctorSqliteRepair } from "./sqlite-index-recovery.js";
import { resolveSqliteInspectionSignal } from "./sqlite-readonly-worker.js";
import { admitSqliteSchema } from "./sqlite-schema-facts.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";
import { createMigrationDatabaseHandle } from "./state-migrations.agent-database.js";
import {
  resolveAgentDatabaseMigrationTargets,
  type AgentDatabaseMigrationTarget,
  type PreparedAgentDatabaseMigrationDiscovery,
} from "./state-migrations.media-persistence-targets.js";
import {
  migrateTranscriptDirectiveArchives,
  recoverPendingTranscriptArchivePublication,
  transcriptDirectiveArchiveRecoveryPending,
  transcriptDirectiveArchivesNeedMigration,
} from "./state-migrations.transcript-directives-archives.js";
import {
  assertTranscriptSessionSourceUnchanged,
  listTranscriptCandidateSessions,
  planTranscriptSession,
} from "./state-migrations.transcript-directives-rows.js";
import type { MigrationMessages } from "./state-migrations.types.js";
import { Utf8InputError } from "./utf8-input.js";

const MIGRATION_META_KEY = "historical-transcript-directives-v1";

type TranscriptDirectiveMigrationDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  "schema_meta" | "transcript_events"
>;

type MigrationCursor =
  | { phase: "transcripts"; sessionId: string }
  | { generation: string; phase: "archives"; sessionId: string }
  | { phase: "complete" };

type DatabaseMigrationResult = {
  archivedTranscripts: number;
  transcriptSessions: number;
  warnings: string[];
};

function parseMigrationCursor(value: string | null | undefined, pathname: string): MigrationCursor {
  if (!value) {
    return { phase: "transcripts", sessionId: "" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`${pathname} has an invalid historical transcript migration cursor`, {
      cause: error,
    });
  }
  if (!isRecord(parsed)) {
    throw new Error(`${pathname} has an invalid historical transcript migration cursor`);
  }
  if (parsed.phase === "complete") {
    return { phase: "complete" };
  }
  if (parsed.phase === "transcripts" && typeof parsed.sessionId === "string") {
    return { phase: "transcripts", sessionId: parsed.sessionId };
  }
  if (
    parsed.phase === "archives" &&
    typeof parsed.sessionId === "string" &&
    typeof parsed.generation === "string"
  ) {
    return {
      generation: parsed.generation,
      phase: "archives",
      sessionId: parsed.sessionId,
    };
  }
  throw new Error(`${pathname} has an invalid historical transcript migration cursor`);
}

function readMigrationCursor(database: DatabaseSync, pathname: string): MigrationCursor {
  const db = getNodeSqliteKysely<TranscriptDirectiveMigrationDatabase>(database);
  const row = executeSqliteQueryTakeFirstSync(
    database,
    db.selectFrom("schema_meta").select("app_version").where("meta_key", "=", MIGRATION_META_KEY),
  );
  return parseMigrationCursor(row?.app_version, pathname);
}

function writeMigrationCursor(
  database: DatabaseSync,
  agentId: string,
  cursor: MigrationCursor,
): void {
  const now = Date.now();
  const db = getNodeSqliteKysely<TranscriptDirectiveMigrationDatabase>(database);
  const row = {
    agent_id: agentId,
    app_version: JSON.stringify(cursor),
    role: "agent",
    schema_version: 1,
    updated_at: now,
  };
  executeSqliteQuerySync(
    database,
    db
      .insertInto("schema_meta")
      .values({
        ...row,
        created_at: now,
        meta_key: MIGRATION_META_KEY,
      })
      .onConflict((conflict) => conflict.column("meta_key").doUpdateSet(row)),
  );
}

function transcriptSessionsNeedMigration(
  database: DatabaseSync,
  pathname: string,
  afterSessionId: string,
): boolean {
  for (const sessionId of listTranscriptCandidateSessions(database, afterSessionId)) {
    for (const planned of planTranscriptSession(database, pathname, sessionId)) {
      if (planned.rows.some((row) => row.rewrittenEventJson !== row.eventJson)) {
        return true;
      }
    }
  }
  return false;
}

function hasActiveAgentDatabaseLease(agentId: string, env: NodeJS.ProcessEnv): boolean {
  try {
    assertNoOpenClawAgentDatabaseLeases(agentId, { env });
    return false;
  } catch (error) {
    if (error instanceof OpenClawAgentDatabaseLeaseActiveError) {
      return true;
    }
    throw error;
  }
}

async function migrateTranscriptSessions(params: {
  agentId: string;
  database: DatabaseSync;
  owner: OpenClawAgentDatabase;
  pathname: string;
  start: Extract<MigrationCursor, { phase: "transcripts" }>;
  beforeRewrite: () => void;
}): Promise<number> {
  let rewrittenSessions = 0;
  const sessionIds = listTranscriptCandidateSessions(params.database, params.start.sessionId);
  for (const sessionId of sessionIds) {
    let changed = false;
    for (const planned of planTranscriptSession(params.database, params.pathname, sessionId)) {
      const changedRows = planned.rows.filter((row) => row.rewrittenEventJson !== row.eventJson);
      runSqliteImmediateTransactionSync(
        params.database,
        () => {
          assertAgentDatabaseMaintenanceAuthority();
          assertTranscriptSessionSourceUnchanged(params.database, sessionId, planned);
          if (changedRows.length > 0) {
            params.beforeRewrite();
          }
          updateSqliteTranscriptEventJsonInTransaction(
            params.owner,
            sessionId,
            changedRows.map((row) => ({ eventJson: row.rewrittenEventJson, seq: row.seq })),
          );
          // An interrupted session remains discoverable; repaired rows are
          // idempotent and the existing cursor advances only after its last batch.
          if (planned.complete) {
            writeMigrationCursor(params.database, params.agentId, {
              phase: "transcripts",
              sessionId,
            });
          }
          assertAgentDatabaseMaintenanceAuthority();
        },
        {
          busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
          databaseLabel: params.pathname,
          operationLabel: "historical-transcript-directives",
        },
      );
      changed ||= changedRows.length > 0;
      // The next transaction revalidates maintenance ownership after yielding.
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    }
    rewrittenSessions += Number(changed);
  }
  runSqliteImmediateTransactionSync(
    params.database,
    () => {
      assertAgentDatabaseMaintenanceAuthority();
      writeMigrationCursor(params.database, params.agentId, {
        generation: "",
        phase: "archives",
        sessionId: "",
      });
      assertAgentDatabaseMaintenanceAuthority();
    },
    { databaseLabel: params.pathname, operationLabel: "historical-transcript-directives.cursor" },
  );
  return rewrittenSessions;
}

async function migrateAgentDatabase(
  params: { agentId: string; pathname: string; changes: string[] },
  maintenance: OpenClawStateLeaseContext,
): Promise<DatabaseMigrationResult> {
  await migrateOpenClawAgentDatabaseForMaintenance(params, maintenance);
  maintenance.assertOwned();
  const database = openNodeSqliteDatabase(params.pathname);
  try {
    database.exec(`PRAGMA busy_timeout = ${OPENCLAW_SQLITE_BUSY_TIMEOUT_MS};`);
    assertOpenClawAgentDatabaseForMaintenance(database, params);
    admitSqliteSchema(database);
    const cursor = readMigrationCursor(database, params.pathname);
    if (cursor.phase === "complete") {
      const warnings = await recoverPendingTranscriptArchivePublication({
        agentId: params.agentId,
        database,
        pathname: params.pathname,
        signal: resolveSqliteInspectionSignal(maintenance.signal),
      });
      return { archivedTranscripts: 0, transcriptSessions: 0, warnings };
    }
    const owner = createMigrationDatabaseHandle(database, params.agentId, params.pathname);
    let preserved = false;
    const beforeRewrite = () => {
      if (!preserved) {
        const backup = backupDoctorSqliteRepair(params.pathname, "transcript-directives");
        preserved = true;
        params.changes.push(`Saved pre-repair SQLite backup: ${backup}`);
      }
    };
    const transcriptSessions =
      cursor.phase === "transcripts"
        ? await migrateTranscriptSessions({
            agentId: params.agentId,
            database,
            owner,
            pathname: params.pathname,
            start: cursor,
            beforeRewrite,
          })
        : 0;
    const archiveCursor = readMigrationCursor(database, params.pathname);
    const archives =
      archiveCursor.phase === "archives"
        ? await migrateTranscriptDirectiveArchives({
            agentId: params.agentId,
            database,
            pathname: params.pathname,
            signal: maintenance.signal,
            start: archiveCursor,
            beforeRewrite,
            writeCursor: (next) =>
              writeMigrationCursor(
                database,
                params.agentId,
                "phase" in next ? next : { ...next, phase: "archives" },
              ),
          })
        : { rewrittenArchives: 0, warnings: [] };
    return {
      archivedTranscripts: archives.rewrittenArchives,
      transcriptSessions,
      warnings: archives.warnings,
    };
  } finally {
    clearNodeSqliteKyselyCacheForDatabase(database);
    database.close();
  }
}

async function agentDatabaseNeedsTranscriptDirectiveMigration(params: {
  agentId: string;
  env: NodeJS.ProcessEnv;
  pathname: string;
}): Promise<boolean> {
  const database = openNodeSqliteDatabase(params.pathname, { readOnly: true });
  try {
    const userVersion = Number(database.prepare("PRAGMA user_version").get()?.user_version ?? 0);
    if (userVersion !== OPENCLAW_AGENT_SCHEMA_VERSION) {
      return true;
    }
    try {
      assertOpenClawAgentDatabaseForMaintenance(database, params);
    } catch {
      return true;
    }
    const cursor = readMigrationCursor(database, params.pathname);
    if (cursor.phase === "complete") {
      return transcriptDirectiveArchiveRecoveryPending(database);
    }
    if (
      cursor.phase === "transcripts" &&
      transcriptSessionsNeedMigration(database, params.pathname, cursor.sessionId)
    ) {
      return true;
    }
    if (
      await transcriptDirectiveArchivesNeedMigration(
        database,
        cursor.phase === "archives"
          ? { generation: cursor.generation, sessionId: cursor.sessionId }
          : { generation: "", sessionId: "" },
      )
    ) {
      return true;
    }
    return !hasActiveAgentDatabaseLease(params.agentId, params.env);
  } finally {
    clearNodeSqliteKyselyCacheForDatabase(database);
    database.close();
  }
}

/** Doctor normalization of historical inline assistant directives into typed delivery facts. */
export async function migrateHistoricalTranscriptDirectives(
  params: {
    configuredAgentDatabaseTargets?: readonly { agentId: string; path: string }[];
    preparedDiscovery?: PreparedAgentDatabaseMigrationDiscovery;
    preparedTargets?: readonly AgentDatabaseMigrationTarget[];
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<MigrationMessages> {
  const signal = resolveSqliteInspectionSignal();
  signal?.throwIfAborted();
  const env = params.env ?? process.env;
  const changes: string[] = [];
  const warnings: string[] = [];
  let recoverableWarningCount = 0;
  try {
    const discovery = params.preparedTargets
      ? { targets: params.preparedTargets, recoverableWarningCount: 0 }
      : resolveAgentDatabaseMigrationTargets({
          changes,
          configuredAgentDatabaseTargets: params.configuredAgentDatabaseTargets ?? [],
          env,
          warnings,
          preparedDiscovery: params.preparedDiscovery,
        });
    recoverableWarningCount = discovery.recoverableWarningCount;
    const targets: AgentDatabaseMigrationTarget[] = [];
    for (const target of discovery.targets) {
      try {
        assertMigrationTargetPathCurrent(target);
        if (
          await agentDatabaseNeedsTranscriptDirectiveMigration({
            agentId: target.agentId,
            env,
            pathname: target.path,
          })
        ) {
          targets.push(target);
        }
      } catch (error) {
        if (signal?.aborted && error === signal.reason) {
          throw error;
        }
        warnings.push(
          `Skipped historical transcript directive migration preflight for ${target.path}: ${String(error)}`,
        );
        recoverableWarningCount += Number(error instanceof Utf8InputError);
      }
    }
    if (targets.length > 0) {
      await withAgentDatabaseMaintenanceLease({ env }, async (maintenance) => {
        for (const target of targets.toSorted(
          (a, b) => a.agentId.localeCompare(b.agentId) || a.path.localeCompare(b.path),
        )) {
          try {
            assertMigrationTargetPathCurrent(target);
            const result = await migrateAgentDatabase(
              { agentId: target.agentId, pathname: target.path, changes },
              maintenance,
            );
            warnings.push(...result.warnings);
            recoverableWarningCount += result.warnings.length;
            if (result.transcriptSessions > 0 || result.archivedTranscripts > 0) {
              changes.push(
                `Migrated historical transcript directives in ${target.path}: ${result.transcriptSessions} active session(s), ${result.archivedTranscripts} archived transcript(s).`,
              );
            }
          } catch (error) {
            if (signal?.aborted && error === signal.reason) {
              throw error;
            }
            warnings.push(
              `Skipped historical transcript directive migration for ${target.path}: ${String(error)}`,
            );
            recoverableWarningCount += Number(error instanceof Utf8InputError);
          }
        }
      });
    }
  } catch (error) {
    if (signal?.aborted && error === signal.reason) {
      throw error;
    }
    warnings.push(`Skipped historical transcript directive migration: ${String(error)}`);
  }
  return {
    changes,
    warnings,
    ...(warnings.length > 0 && warnings.length === recoverableWarningCount
      ? { warningDisposition: "recoverable" as const }
      : {}),
  };
}

function assertMigrationTargetPathCurrent(target: AgentDatabaseMigrationTarget): void {
  if (fs.realpathSync.native(target.path) !== target.realPath) {
    throw new Error(`Agent database path changed since migration discovery: ${target.path}`);
  }
}
