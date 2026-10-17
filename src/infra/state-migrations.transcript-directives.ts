import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { sql } from "kysely";
import { updateSqliteTranscriptEventJsonInTransaction } from "../config/sessions/session-accessor.sqlite-transcript-store.js";
import { transcriptEventJsonSql } from "../config/sessions/transcript-payload.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import type { OpenClawAgentDatabase } from "../state/openclaw-agent-db-contract.js";
import {
  OpenClawAgentDatabaseLeaseActiveError,
  assertNoOpenClawAgentDatabaseLeases,
} from "../state/openclaw-agent-db-lease.js";
import { assertAgentDatabaseMaintenanceAuthority } from "../state/openclaw-agent-db-maintenance-authority.js";
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
  type ArchiveSessionLineTransform,
  migrateTranscriptDirectiveArchives,
  recoverPendingTranscriptArchivePublication,
  TRANSCRIPT_DIRECTIVE_MIGRATION_BATCH_SIZE,
  transcriptDirectiveArchiveRecoveryPending,
  transcriptDirectiveArchivesNeedMigration,
} from "./state-migrations.transcript-directives-archives.js";
import {
  createMaskedProviderResolver,
  type MaskedProviderResolver,
  recordRestoredProviders,
} from "./state-migrations.transcript-directives-providers.js";
import {
  type HistoricalTranscriptLineResult,
  type HistoricalTranscriptRepairScope,
  MASKED_PROVIDER_JSON,
  MASKED_TRANSCRIPT_PROVIDER,
  repairHistoricalTranscriptEventJson,
} from "./state-migrations.transcript-directives-transform.js";
import type { MigrationMessages } from "./state-migrations.types.js";

const MIGRATION_META_KEY = "historical-transcript-directives-v1";
// Version 2 added masked-provider repair. Unversioned cursors were written by version 1.
const MIGRATION_CURSOR_VERSION = 2;

type TranscriptDirectiveMigrationDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  "schema_meta" | "transcript_events"
>;

type MigrationCursor =
  | { phase: "transcripts"; scope: HistoricalTranscriptRepairScope; sessionId: string }
  | {
      generation: string;
      phase: "archives";
      scope: HistoricalTranscriptRepairScope;
      sessionId: string;
    }
  | { phase: "complete" };

type TranscriptRowPlan = {
  directivesChanged: boolean;
  eventJson: string;
  maskedProvider?: HistoricalTranscriptLineResult["maskedProvider"];
  rewrittenEventJson: string;
  seq: number;
};

type MaskedProviderCounts = { restored: number; unresolved: number };

type DatabaseMigrationResult = {
  archivedTranscripts: number;
  maskedProviders: MaskedProviderCounts;
  transcriptSessions: number;
  warnings: string[];
};

function parseMigrationCursor(value: string | null | undefined, pathname: string): MigrationCursor {
  if (!value) {
    return { phase: "transcripts", scope: "all", sessionId: "" };
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
  if (parsed.version === undefined) {
    // A completed version 1 pass reopens once for masked-provider repair alone. An
    // interrupted one restarts both idempotent transforms so no earlier session is skipped.
    if (parsed.phase === "complete") {
      return { phase: "transcripts", scope: "masked-provider", sessionId: "" };
    }
    if (parsed.phase === "transcripts" || parsed.phase === "archives") {
      return { phase: "transcripts", scope: "all", sessionId: "" };
    }
    throw new Error(`${pathname} has an invalid historical transcript migration cursor`);
  }
  if (parsed.version !== MIGRATION_CURSOR_VERSION) {
    throw new Error(`${pathname} has an invalid historical transcript migration cursor`);
  }
  if (parsed.phase === "complete") {
    return { phase: "complete" };
  }
  const scope = parsed.scope;
  if (scope !== "all" && scope !== "masked-provider") {
    throw new Error(`${pathname} has an invalid historical transcript migration cursor`);
  }
  if (parsed.phase === "transcripts" && typeof parsed.sessionId === "string") {
    return { phase: "transcripts", scope, sessionId: parsed.sessionId };
  }
  if (
    parsed.phase === "archives" &&
    typeof parsed.sessionId === "string" &&
    typeof parsed.generation === "string"
  ) {
    return {
      generation: parsed.generation,
      phase: "archives",
      scope,
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
    app_version: JSON.stringify({ ...cursor, version: MIGRATION_CURSOR_VERSION }),
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

/**
 * Candidate rows without decoding every payload. Identity rows hold the masked value in
 * `event_json`; compressed rows always carry a navigation projection that keeps
 * `message.provider`, so only matching compressed rows are decoded.
 */
function transcriptCandidateFilter(database: DatabaseSync, scope: HistoricalTranscriptRepairScope) {
  const maskedProvider = /* kysely-allow-raw: substring prefilter over stored JSON columns; parsed events decide. */ sql<boolean>`(instr(transcript_events.event_json, ${MASKED_PROVIDER_JSON}) > 0 OR instr(transcript_events.navigation_json, ${MASKED_PROVIDER_JSON}) > 0)`;
  return scope === "masked-provider"
    ? maskedProvider
    : /* kysely-allow-raw: directive rows still need the decoded payload predicate. */ sql<boolean>`(${transcriptEventJsonSql(database)} LIKE '%[[%' OR ${maskedProvider})`;
}

/**
 * Candidate sessions after the cursor, from one rowid-order scan. Ordering, DISTINCT or a
 * session range would walk the primary-key index and fetch every row out of order, which
 * is several times slower on large databases.
 */
function listTranscriptCandidateSessions(
  database: DatabaseSync,
  scope: HistoricalTranscriptRepairScope,
  afterSessionId: string,
): string[] {
  const db = getNodeSqliteKysely<TranscriptDirectiveMigrationDatabase>(database);
  const rows = executeSqliteQuerySync(
    database,
    db
      .selectFrom("transcript_events")
      .select("session_id")
      .where(transcriptCandidateFilter(database, scope)),
  ).rows;
  return [...new Set(rows.map((row) => row.session_id))]
    .filter((sessionId) => sessionId > afterSessionId)
    .toSorted();
}

function readTranscriptSessionRows(
  database: DatabaseSync,
  scope: HistoricalTranscriptRepairScope,
  sessionId: string,
) {
  const db = getNodeSqliteKysely<TranscriptDirectiveMigrationDatabase>(database);
  return executeSqliteQuerySync(
    database,
    db
      .selectFrom("transcript_events")
      .select([transcriptEventJsonSql(database).as("event_json"), "seq"])
      .where("session_id", "=", sessionId)
      .where(transcriptCandidateFilter(database, scope))
      .orderBy("seq", "asc"),
  ).rows;
}

function planTranscriptSession(params: {
  database: DatabaseSync;
  pathname: string;
  resolveMaskedProvider: MaskedProviderResolver;
  scope: HistoricalTranscriptRepairScope;
  sessionId: string;
}): TranscriptRowPlan[] {
  const resolveMaskedProvider = params.resolveMaskedProvider(params.sessionId);
  return readTranscriptSessionRows(params.database, params.scope, params.sessionId).map((row) => {
    const repaired = repairHistoricalTranscriptEventJson({
      raw: row.event_json,
      owner: `${params.pathname}:${params.sessionId}:${row.seq}`,
      scope: params.scope,
      resolveMaskedProvider,
    });
    return {
      directivesChanged: repaired.directivesChanged,
      eventJson: row.event_json,
      maskedProvider: repaired.maskedProvider,
      rewrittenEventJson: repaired.content,
      seq: row.seq,
    };
  });
}

function assertTranscriptSessionSourceUnchanged(
  database: DatabaseSync,
  scope: HistoricalTranscriptRepairScope,
  sessionId: string,
  planned: readonly TranscriptRowPlan[],
): void {
  const current = readTranscriptSessionRows(database, scope, sessionId);
  if (
    current.length !== planned.length ||
    current.some(
      (row, index) =>
        row.seq !== planned[index]?.seq || row.event_json !== planned[index]?.eventJson,
    )
  ) {
    throw new Error(`Transcript source changed before migration commit for ${sessionId}`);
  }
}

function transcriptSessionsNeedMigration(
  database: DatabaseSync,
  pathname: string,
  start: Extract<MigrationCursor, { phase: "transcripts" }>,
  resolveMaskedProvider: MaskedProviderResolver,
): boolean {
  return listTranscriptCandidateSessions(database, start.scope, start.sessionId).some((sessionId) =>
    planTranscriptSession({
      database,
      pathname,
      resolveMaskedProvider,
      scope: start.scope,
      sessionId,
    }).some((row) => row.rewrittenEventJson !== row.eventJson),
  );
}

type ArchiveRepairObservations = {
  directivesChanged: boolean;
  // Changed archives are streamed twice (inspect, then re-encode); key outcomes by line owner.
  maskedProviderLines: Map<string, "restored" | "unresolved">;
  unrecordedRestoredLines: Set<string>;
};

function createArchiveLineTransform(
  scope: HistoricalTranscriptRepairScope,
  resolveMaskedProvider: MaskedProviderResolver,
  observed?: ArchiveRepairObservations,
): ArchiveSessionLineTransform {
  return (raw, owner, sessionId) => {
    const repaired = repairHistoricalTranscriptEventJson({
      raw,
      owner,
      scope,
      resolveMaskedProvider: resolveMaskedProvider(sessionId),
    });
    if (observed) {
      observed.directivesChanged ||= repaired.directivesChanged;
      if (repaired.maskedProvider) {
        observed.maskedProviderLines.set(owner, repaired.maskedProvider);
      }
      if (repaired.maskedProvider === "restored") {
        observed.unrecordedRestoredLines.add(owner);
      }
    }
    return repaired;
  };
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
  maskedProviders: MaskedProviderCounts;
  owner: OpenClawAgentDatabase;
  pathname: string;
  resolveMaskedProvider: MaskedProviderResolver;
  start: Extract<MigrationCursor, { phase: "transcripts" }>;
  backupBeforeDirectiveRewrite: () => void;
}): Promise<number> {
  const { scope } = params.start;
  let rewrittenSessions = 0;
  const sessionIds = listTranscriptCandidateSessions(
    params.database,
    scope,
    params.start.sessionId,
  );
  for (const [index, sessionId] of sessionIds.entries()) {
    const planned = planTranscriptSession({
      database: params.database,
      pathname: params.pathname,
      resolveMaskedProvider: params.resolveMaskedProvider,
      scope,
      sessionId,
    });
    const changedRows = planned.filter((row) => row.rewrittenEventJson !== row.eventJson);
    const directivesChanged = changedRows.some((row) => row.directivesChanged);
    const restoredSeqs = planned
      .filter((row) => row.maskedProvider === "restored")
      .map((row) => row.seq);
    runSqliteImmediateTransactionSync(
      params.database,
      () => {
        assertAgentDatabaseMaintenanceAuthority();
        assertTranscriptSessionSourceUnchanged(params.database, scope, sessionId, planned);
        if (directivesChanged) {
          params.backupBeforeDirectiveRewrite();
        }
        updateSqliteTranscriptEventJsonInTransaction(
          params.owner,
          sessionId,
          changedRows.map((row) => ({
            eventJson: row.rewrittenEventJson,
            seq: row.seq,
          })),
          // A provider is not part of any indexed fact.
          { indexUnchanged: !directivesChanged },
        );
        if (restoredSeqs.length > 0) {
          recordRestoredProviders(params.database, params.agentId, (record) => {
            record.transcriptRows[sessionId] = [
              ...(record.transcriptRows[sessionId] ?? []),
              ...restoredSeqs,
            ];
          });
        }
        writeMigrationCursor(params.database, params.agentId, {
          phase: "transcripts",
          scope,
          sessionId,
        });
        assertAgentDatabaseMaintenanceAuthority();
      },
      {
        busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
        databaseLabel: params.pathname,
        operationLabel: "historical-transcript-directives",
      },
    );
    rewrittenSessions += changedRows.length > 0 ? 1 : 0;
    for (const row of planned) {
      if (row.maskedProvider) {
        params.maskedProviders[row.maskedProvider] += 1;
      }
    }
    if ((index + 1) % TRANSCRIPT_DIRECTIVE_MIGRATION_BATCH_SIZE === 0) {
      // Keep the caller responsive between bounded batches. The next transaction
      // revalidates maintenance ownership before mutating state.
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    }
  }
  runSqliteImmediateTransactionSync(
    params.database,
    () => {
      assertAgentDatabaseMaintenanceAuthority();
      writeMigrationCursor(params.database, params.agentId, {
        generation: "",
        phase: "archives",
        scope,
        sessionId: "",
      });
      assertAgentDatabaseMaintenanceAuthority();
    },
    {
      databaseLabel: params.pathname,
      operationLabel: "historical-transcript-directives.cursor",
    },
  );
  return rewrittenSessions;
}

async function migrateAgentDatabase(
  params: { agentId: string; pathname: string; changes: string[] },
  maintenance: OpenClawStateLeaseContext,
): Promise<DatabaseMigrationResult> {
  // Schema maintenance verifies the whole database. A converged current schema needs no
  // repeat before row rewrites; Doctor's schema steps own that verification.
  if (!readAgentDatabaseSchemaCurrent(params)) {
    await migrateOpenClawAgentDatabaseForMaintenance(params, maintenance);
  }
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
      return {
        archivedTranscripts: 0,
        maskedProviders: { restored: 0, unresolved: 0 },
        transcriptSessions: 0,
        warnings,
      };
    }
    const owner = createMigrationDatabaseHandle(database, params.agentId, params.pathname);
    const resolveMaskedProvider = createMaskedProviderResolver(database);
    const maskedProviders: MaskedProviderCounts = { restored: 0, unresolved: 0 };
    const archiveObservations: ArchiveRepairObservations = {
      directivesChanged: false,
      maskedProviderLines: new Map(),
      unrecordedRestoredLines: new Set(),
    };
    let preserved = false;
    // Directive edits keep the full pre-repair backup; provider restores are undone from
    // their recorded rows.
    const backupBeforeDirectiveRewrite = () => {
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
            maskedProviders,
            owner,
            pathname: params.pathname,
            resolveMaskedProvider,
            start: cursor,
            backupBeforeDirectiveRewrite,
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
            // Runs inside each archive rewrite transaction, after its batch was planned.
            beforeRewrite: () => {
              if (archiveObservations.directivesChanged) {
                backupBeforeDirectiveRewrite();
              }
              const lines = [...archiveObservations.unrecordedRestoredLines];
              if (lines.length > 0) {
                recordRestoredProviders(database, params.agentId, (record) => {
                  record.archiveLines.push(...lines);
                });
                archiveObservations.unrecordedRestoredLines.clear();
              }
            },
            transformLine: createArchiveLineTransform(
              archiveCursor.scope,
              resolveMaskedProvider,
              archiveObservations,
            ),
            writeCursor: (next) =>
              writeMigrationCursor(
                database,
                params.agentId,
                "phase" in next ? next : { ...next, phase: "archives", scope: archiveCursor.scope },
              ),
          })
        : { rewrittenArchives: 0, warnings: [] };
    for (const outcome of archiveObservations.maskedProviderLines.values()) {
      maskedProviders[outcome] += 1;
    }
    return {
      archivedTranscripts: archives.rewrittenArchives,
      maskedProviders,
      transcriptSessions,
      warnings: archives.warnings,
    };
  } finally {
    clearNodeSqliteKyselyCacheForDatabase(database);
    database.close();
  }
}

function readAgentDatabaseSchemaCurrent(params: { agentId: string; pathname: string }): boolean {
  const database = openNodeSqliteDatabase(params.pathname, { readOnly: true });
  try {
    const userVersion = Number(database.prepare("PRAGMA user_version").get()?.user_version ?? 0);
    if (userVersion !== OPENCLAW_AGENT_SCHEMA_VERSION) {
      return false;
    }
    assertOpenClawAgentDatabaseForMaintenance(database, params);
    return true;
  } catch {
    return false;
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
  if (!readAgentDatabaseSchemaCurrent(params)) {
    return true;
  }
  const database = openNodeSqliteDatabase(params.pathname, { readOnly: true });
  try {
    const cursor = readMigrationCursor(database, params.pathname);
    if (cursor.phase === "complete") {
      return transcriptDirectiveArchiveRecoveryPending(database);
    }
    // With the writer stopped, the pass itself scans once. Otherwise report only real work.
    if (!hasActiveAgentDatabaseLease(params.agentId, params.env)) {
      return true;
    }
    const resolveMaskedProvider = createMaskedProviderResolver(database);
    if (
      cursor.phase === "transcripts" &&
      transcriptSessionsNeedMigration(database, params.pathname, cursor, resolveMaskedProvider)
    ) {
      return true;
    }
    if (
      await transcriptDirectiveArchivesNeedMigration(
        database,
        cursor.phase === "archives"
          ? { generation: cursor.generation, sessionId: cursor.sessionId }
          : { generation: "", sessionId: "" },
        createArchiveLineTransform(cursor.scope, resolveMaskedProvider),
      )
    ) {
      return true;
    }
    return false;
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
            const { maskedProviders } = result;
            if (maskedProviders.unresolved > 0) {
              result.warnings.push(
                `Left ${maskedProviders.unresolved} historical transcript row(s) with masked provider "${MASKED_TRANSCRIPT_PROVIDER}" in ${target.path}: no single provider was recorded for their session and model.`,
              );
            }
            warnings.push(...result.warnings);
            recoverableWarningCount += result.warnings.length;
            if (maskedProviders.restored > 0) {
              changes.push(
                `Restored masked provider on ${maskedProviders.restored} historical transcript row(s) in ${target.path} from recorded session runtime facts.`,
              );
            }
            if (result.transcriptSessions > 0 || result.archivedTranscripts > 0) {
              changes.push(
                `Repaired historical transcripts in ${target.path}: ${result.transcriptSessions} active session(s), ${result.archivedTranscripts} archived transcript(s).`,
              );
            }
          } catch (error) {
            if (signal?.aborted && error === signal.reason) {
              throw error;
            }
            warnings.push(
              `Skipped historical transcript directive migration for ${target.path}: ${String(error)}`,
            );
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
