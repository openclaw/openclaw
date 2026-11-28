import { randomUUID } from "node:crypto";
import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { sql } from "kysely";
import type { DoctorSessionScanScope } from "../../../config/sessions/session-accessor.sqlite-canonical-inventory.js";
import { publishSessionEntryCacheInvalidation } from "../../../config/sessions/session-accessor.sqlite-entry-cache.js";
import { invalidateSessionEntryMaintenanceAgeFact } from "../../../config/sessions/session-accessor.sqlite-maintenance-age.js";
import {
  getSessionKysely,
  resolveSqliteScope,
  toDatabaseOptions,
} from "../../../config/sessions/session-accessor.sqlite-scope.js";
import { bindSessionEntryNumericChanges } from "../../../config/sessions/session-accessor.sqlite-session-row.js";
import { normalizeStatus } from "../../../config/sessions/session-accessor.sqlite-status.js";
import { markCanonicalSessionValidationPending } from "../../../config/sessions/session-canonical-key.js";
import { parseSqliteSessionEntryRecord } from "../../../config/sessions/session-entry-json.js";
import { SESSION_ENTRY_NUMERIC_FIELDS } from "../../../config/sessions/session-entry-numeric-snapshot.js";
import { attachSessionEntrySnapshots } from "../../../config/sessions/session-entry-snapshot-values.js";
import {
  sessionEntrySnapshotColumns,
  splitSessionEntrySnapshots,
  writeSessionEntrySnapshots,
} from "../../../config/sessions/session-entry-snapshots.js";
import {
  hasLegacySessionEntryState,
  LEGACY_SESSION_ENTRY_STATE_FIELDS,
} from "../../../config/sessions/session-entry-state-format.js";
import { deriveSessionPredicateColumns } from "../../../config/sessions/session-predicate-columns.js";
import { stripRuntimeOnlySessionSkillsFields } from "../../../config/sessions/store-entry-shape.js";
import { assertSupportedSessionStoreEntry } from "../../../config/sessions/supported-session-store.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import { decodeQueuedOperatorRecoverySource } from "../../../gateway/operator-run-recovery-source.codec.js";
import { withEngineStoreAdmission } from "../../../infra/database-engine/admission-scope.js";
import { jsonPathValue } from "../../../infra/database-engine/json-values.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  iterateSqliteQuerySync,
} from "../../../infra/kysely-sync.js";
import { isPostgresSqlConnection } from "../../../infra/sql-connection.js";
import {
  prepareArtifactPreservingSqliteRead,
  startSqliteReadOnlyLocationAsync,
} from "../../../infra/sqlite-snapshot-source.js";
import {
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
  type DatabaseFileIdentity,
} from "../../../infra/sqlite-worker-identity.js";
import { hasUpdateDoctorMigrationCapture } from "../../../infra/update-doctor-migration-context.js";
import { withArtifactPreservingStateReads } from "../../../state/artifact-preserving-state-reads.js";
import { agentEngineInput } from "../../../state/openclaw-agent-db-engine.js";
import { assertOpenClawAgentDatabaseIdentity } from "../../../state/openclaw-agent-db-identity.js";
import { withFreshOpenClawAgentDatabaseReadOnly } from "../../../state/openclaw-agent-db-readonly-open.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../../state/openclaw-agent-db-readonly.js";
import {
  runOpenClawAgentWriteTransaction,
  withOpenClawAgentDatabaseAsync,
  type OpenClawAgentDatabase,
} from "../../../state/openclaw-agent-db.js";
import {
  getOpenClawDatabaseMaintenanceScope,
  readCustodiedDrainedSqliteSource,
} from "../../../state/openclaw-state-maintenance-context.js";
import { chunkItems } from "../../../utils/chunk-items.js";
import {
  deliveryContextFromSession,
  sessionDeliveryChannel,
} from "../../../utils/delivery-context.read.js";
import { doctorMigrationBackupPath } from "../../doctor-migration-backup-names.js";
import {
  inspectLegacyRestartTombstone,
  migrateLegacySessionEntryState,
  migrateLegacySessionRunOutcome,
  type SessionEntryStateRepair,
} from "./session-entry-shape.js";

const DOCTOR_SESSION_REWRITE_BATCH_SIZE = 64;

type StartupSessionRow = Parameters<typeof parseSqliteSessionEntryRecord>[0] & {
  session_key: string;
};

export function iterateDoctorSessionKeyBatches(sessionKeys: readonly string[]): string[][] {
  return chunkItems(uniqueStrings(sessionKeys).toSorted(), DOCTOR_SESSION_REWRITE_BATCH_SIZE);
}

/** Select legacy state before loading raw rows into canonical validation or runtime projection. */
export async function scanDoctorSessionEntryRecords(
  scope: DoctorSessionScanScope,
  visit: (record: { sessionKey: string; entry: Record<string, unknown> }) => void,
  expectedIdentity: DatabaseFileIdentity,
  visitStartupRow?: (row: StartupSessionRow, database: Pick<OpenClawAgentDatabase, "db">) => void,
): Promise<void> {
  const resolved = resolveSqliteScope({ ...scope, sessionKey: "" });
  const databaseOptions = toDatabaseOptions(resolved);
  const captured = hasUpdateDoctorMigrationCapture() && !agentEngineInput();
  const maintenance = getOpenClawDatabaseMaintenanceScope();
  const assertSourceCurrent = () => {
    if (!maintenance?.ownsSchemaMaintenance) {
      throw new Error("Captured Doctor inspection requires schema maintenance custody.");
    }
    maintenance.assertAdmission();
    assertExistingDatabaseIdentity(
      scope.storePath,
      expectedIdentity.key,
      expectedIdentity.birthtime,
    );
  };
  // The snapshot owner removes its copy immediately; its reader must not enter the idle cache.
  const readDatabase = captured
    ? withFreshOpenClawAgentDatabaseReadOnly
    : withOpenClawAgentDatabaseReadOnly;
  const scan = (options: typeof databaseOptions, identity: DatabaseFileIdentity) =>
    withEngineStoreAdmission(() =>
      readDatabase((database) => {
        assertOpenClawAgentDatabaseIdentity(database, identity);
        const legacyState = isPostgresSqlConnection(database.db)
          ? /* kysely-allow-raw: native JSON filtering bounds parsing; JSON.parse owns duplicate-key precedence. */ sql<boolean>`CASE WHEN entry_json IS JSON OBJECT THEN EXISTS (
            SELECT 1 FROM json_each(entry_json::json)
            WHERE key IN (${sql.join(LEGACY_SESSION_ENTRY_STATE_FIELDS)})
              OR key IN ('provider', 'lastProvider', 'room')
              OR key = 'mainRestartRecovery'
              OR key = 'resumeAfterRestart'
              OR (key = 'pendingFinalDelivery' AND json_typeof(value) = 'boolean')
              OR (key = 'status' AND value #>> '{}' IN ('running', 'queued'))
              OR (key IN (${sql.join(SESSION_ENTRY_NUMERIC_FIELDS)}) AND json_typeof(value) = 'string')
          ) WHEN entry_json IS JSON THEN FALSE ELSE TRUE END`
          : /* kysely-allow-raw: native JSON filtering bounds parsing; JSON.parse owns duplicate-key precedence. */ sql<boolean>`CASE WHEN json_valid(entry_json) THEN EXISTS (
            SELECT 1 FROM json_each(entry_json)
            WHERE key IN (${sql.join(LEGACY_SESSION_ENTRY_STATE_FIELDS)})
              OR key IN ('provider', 'lastProvider', 'room')
              OR key = 'mainRestartRecovery'
              OR key = 'resumeAfterRestart'
              OR (key = 'pendingFinalDelivery' AND type IN ('true', 'false'))
              OR (key = 'status' AND value IN ('running', 'queued'))
              OR (key IN (${sql.join(SESSION_ENTRY_NUMERIC_FIELDS)}) AND type = 'text')
          ) ELSE 1 END`;
        const query = getSessionKysely(database.db)
          .selectFrom("session_nodes")
          .select(["session_key", "entry_json"]);
        const visitLegacyRow = (row: { session_key: string; entry_json: string }) => {
          const entry = safeParseJsonRecord(row.entry_json);
          if (entry) {
            assertSupportedSessionStoreEntry(entry);
            visit({ sessionKey: row.session_key, entry });
          }
        };
        if (visitStartupRow) {
          for (const row of iterateSqliteQuerySync(
            database.db,
            query
              .select(["current_session_id", "updated_at"])
              .select(legacyState.as("legacy_state")),
          )) {
            visitStartupRow(row, database);
            if (row.legacy_state) {
              visitLegacyRow(row);
            }
          }
        } else {
          for (const row of iterateSqliteQuerySync(database.db, query.where(legacyState))) {
            visitLegacyRow(row);
          }
        }
      }, options),
    );
  const read = async () => {
    if (!captured) {
      await prepareArtifactPreservingSqliteRead(scope.storePath);
      return scan(databaseOptions, expectedIdentity);
    }
    assertSourceCurrent();
    if (readCustodiedDrainedSqliteSource(scope.storePath)) {
      // The backup owner has already drained WAL under the same maintenance custody.
      const inPlace = withArtifactPreservingStateReads(
        () => scan(databaseOptions, expectedIdentity),
        { agentDatabases: true },
      );
      assertSourceCurrent();
      return inPlace;
    }
    // The child pins the original source identity; the reader keeps its private identity.
    await using capturedSnapshot = {
      preparation: startSqliteReadOnlyLocationAsync(scope.storePath, {
        preserveSourceArtifacts: true,
        expectedSourceIdentity: expectedIdentity,
      }),
      async [Symbol.asyncDispose]() {
        await this.preparation.startClose().result;
      },
    };
    const snapshot = await capturedSnapshot.preparation.result;
    assertSourceCurrent();
    const result = scan(
      { ...databaseOptions, path: snapshot.location },
      readDatabasePathIdentitySync(snapshot.location),
    );
    assertSourceCurrent();
    return result;
  };
  const result = await read();
  if (!result.found) {
    throw new Error(`Session database unavailable during raw state inspection: ${result.reason}`);
  }
}

/** Rotated cuts copied a tree and appended a leaf; in-place cuts marked the displaced branch. */
function readUncountedCutWindow(
  database: Pick<OpenClawAgentDatabase, "db">,
  entry: Record<string, unknown> | null,
): string | undefined {
  if (typeof entry?.sessionId !== "string" || entry.compactionCount !== undefined) {
    return undefined;
  }
  const rotated = typeof entry.previousSessionId === "string";
  if (!rotated && typeof entry.lifecycleRevision !== "string") {
    return undefined;
  }
  const leaves = getSessionKysely(database.db)
    .selectFrom("transcript_event_identities as leaf")
    .where("leaf.session_id", "=", entry.sessionId)
    .where("leaf.event_type", "=", "leaf");
  if (rotated) {
    return executeSqliteQueryTakeFirstSync(database.db, leaves.select("leaf.seq").limit(1))
      ? entry.sessionId
      : undefined;
  }
  const rows = iterateSqliteQuerySync(
    database.db,
    leaves
      .innerJoin("transcript_events as event", (join) =>
        join.onRef("event.session_id", "=", "leaf.session_id").onRef("event.seq", "=", "leaf.seq"),
      )
      .select((eb) =>
        eb.fn
          .coalesce(
            "event.event_json",
            jsonPathValue(
              database.db,
              eb.ref("event.navigation_json"),
              eb.val("$.report.entry"),
              "json",
            ),
          )
          .as("marker"),
      )
      .orderBy("leaf.seq", "desc"),
  );
  for (const { marker } of rows) {
    if (marker && safeParseJsonRecord(marker)?.billsDisplaced === true) {
      return entry.sessionId;
    }
  }
  return undefined;
}

/** Normalize legacy entries before canonical reads; clean stores stay read-only. */
export async function repairLegacyStartupSessionEntries(
  scope: DoctorSessionScanScope,
  assertCurrent: () => void,
  visitStartupEntry: (
    entry: ReturnType<typeof parseSqliteSessionEntryRecord>,
    sessionKey: string,
  ) => void,
  warn: (message: string) => void,
): Promise<{ repaired: number; terminalUnmatched: number }> {
  assertCurrent();
  const expectedIdentity = readDatabasePathIdentitySync(scope.storePath);
  const runKeys = new Set<string>();
  const cutKeys = new Set<string>();
  const tombstones = new Set<string>();
  const warnings = new Map<string, string>();
  let terminalUnmatched = 0;
  const reportWarnings = () => {
    for (const [sessionKey, warning] of warnings) {
      warn(`${sessionKey}: ${warning}`);
    }
  };
  await scanDoctorSessionEntryRecords(
    scope,
    ({ entry, sessionKey }) => {
      const tombstone = inspectLegacyRestartTombstone(entry);
      if (tombstone?.doctorOnly) {
        terminalUnmatched += 1;
      }
      if (tombstone && !tombstone.doctorOnly) {
        warnings.set(sessionKey, tombstone.warning);
      }
      if (
        (tombstone?.retire && !tombstone.doctorOnly) ||
        (tombstone && hasLegacySessionEntryState(entry))
      ) {
        tombstones.add(sessionKey);
      }
      const resume = entry.resumeAfterRestart;
      if (
        entry.status === "running" ||
        entry.status === "queued" ||
        tombstones.has(sessionKey) ||
        (isRecord(resume) && ("queuedInputIds" in resume || "queuedInputSources" in resume))
      ) {
        runKeys.add(sessionKey);
      }
    },
    expectedIdentity,
    (row, database) => {
      const entry = parseSqliteSessionEntryRecord(row);
      visitStartupEntry(entry, row.session_key);
      if (readUncountedCutWindow(database, entry) !== undefined) {
        cutKeys.add(row.session_key);
      }
    },
  );
  assertCurrent();
  if (runKeys.size === 0 && cutKeys.size === 0) {
    reportWarnings();
    return { repaired: 0, terminalUnmatched };
  }
  const assertRepairCurrent = () => {
    assertCurrent();
    assertExistingDatabaseIdentity(
      scope.storePath,
      expectedIdentity.key,
      expectedIdentity.birthtime,
    );
  };
  if (tombstones.size > 0) {
    const { createVerifiedSqliteSnapshot } = await import("../../../infra/sqlite-snapshot.js");
    await createVerifiedSqliteSnapshot({
      sourcePath: scope.storePath,
      targetPath: doctorMigrationBackupPath(scope.storePath, randomUUID(), "restart-recovery"),
      preserveRowIds: true,
      beforePublish: assertRepairCurrent,
    });
    assertRepairCurrent();
  }
  const countCut = cutKeys.size
    ? (await import("../../../config/sessions/session-accessor.sqlite-compaction-selection.js"))
        .countRetainedCutCompactions
    : undefined;
  const repair = () =>
    withEngineStoreAdmission(() => {
      assertRepairCurrent();
      return rewriteDoctorSessionEntries({
        scope,
        sessionKeys: [...runKeys, ...cutKeys],
        rawTransform: (stored, sessionKey, updatedAt, database) => {
          const cut = cutKeys.has(sessionKey)
            ? readUncountedCutWindow(database, stored)
            : undefined;
          const entry =
            countCut && cut !== undefined
              ? { ...stored, compactionCount: countCut(database, cut) }
              : stored;
          if (!runKeys.has(sessionKey)) {
            return { entry };
          }
          const tombstone = inspectLegacyRestartTombstone(entry);
          if (tombstone && !tombstone.doctorOnly) {
            warnings.set(sessionKey, tombstone.warning);
          }
          const entryRepair: SessionEntryStateRepair = tombstone
            ? migrateLegacySessionEntryState(entry, updatedAt, {
                preserveTerminalRestartCustody: true,
              })
            : { entry: migrateLegacySessionRunOutcome(entry, updatedAt) };
          const resume = entry.resumeAfterRestart;
          if (isRecord(resume) && ("queuedInputIds" in resume || "queuedInputSources" in resume)) {
            const inputs: NonNullable<SessionEntryStateRepair["pendingInputOrigins"]>["inputs"] =
              [];
            if (isRecord(resume.queuedInputSources) && typeof entry.sessionId === "string") {
              for (const [inputId, origin] of Object.entries(resume.queuedInputSources)) {
                if (!isRecord(origin) || typeof origin.runId !== "string") {
                  continue;
                }
                try {
                  const source = decodeQueuedOperatorRecoverySource(origin.source);
                  if (source.kind !== "unavailable") {
                    inputs.push({
                      inputId,
                      runId: origin.runId,
                      sourceJson: JSON.stringify(source),
                    });
                  }
                } catch {
                  // Invalid legacy provenance cannot restore authority; row recovery reports its absence.
                }
              }
              entryRepair.pendingInputOrigins = { sessionId: entry.sessionId, inputs };
            }
            const marker = { ...resume };
            delete marker.queuedInputIds;
            delete marker.queuedInputSources;
            entryRepair.entry = { ...entryRepair.entry, resumeAfterRestart: marker };
          }
          return entryRepair;
        },
        expectedIdentity,
        assertCurrent,
      });
    });
  const repaired = await (agentEngineInput()
    ? repair()
    : withOpenClawAgentDatabaseAsync(
        toDatabaseOptions(resolveSqliteScope({ ...scope, sessionKey: "" })),
        repair,
        assertRepairCurrent,
      ));
  reportWarnings();
  return { repaired, terminalUnmatched };
}

/** Rewrites bounded entry batches after rereading each authoritative row inside its commit. */
export function rewriteDoctorSessionEntries(
  params: {
    scope: DoctorSessionScanScope;
    sessionKeys: readonly string[];
    updateDeliveryProjection?: boolean;
    assertCurrent?: () => void;
    expectedIdentity?: DatabaseFileIdentity;
    integrityCheck?: "quick" | "full";
  } & (
    | { transform: (entry: SessionEntry, sessionKey: string) => SessionEntry; rawTransform?: never }
    | {
        rawTransform: (
          entry: Record<string, unknown>,
          sessionKey: string,
          updatedAt: number,
          database: Pick<OpenClawAgentDatabase, "db">,
        ) => SessionEntryStateRepair;
        transform?: never;
      }
  ),
): number {
  const resolved = resolveSqliteScope({ ...params.scope, sessionKey: "" });
  const databaseOptions = toDatabaseOptions(resolved);
  let rewritten = 0;
  for (const batch of iterateDoctorSessionKeyBatches(params.sessionKeys)) {
    params.assertCurrent?.();
    rewritten += runOpenClawAgentWriteTransaction(
      (database) => {
        const assertRepairCurrent = () => {
          params.assertCurrent?.();
          if (params.expectedIdentity) {
            assertOpenClawAgentDatabaseIdentity(database, params.expectedIdentity);
          }
        };
        assertRepairCurrent();
        const db = getSessionKysely(database.db);
        let batchRewritten = 0;
        for (const sessionKey of batch) {
          const row = executeSqliteQuerySync(
            database.db,
            db
              .selectFrom("session_nodes")
              .select([
                "session_key",
                "current_session_id",
                "entry_json",
                "updated_at",
                "entry_valid",
              ])
              .select(sessionEntrySnapshotColumns)
              .where("session_key", "=", sessionKey),
          ).rows[0];
          if (!row) {
            continue;
          }
          let entryJson: string;
          let nextEntry: SessionEntry | undefined;
          let deliveryProjectionEntry: SessionEntry | undefined;
          let runOutcome: { status?: unknown; endedAt?: unknown } | undefined;
          let numericProjection: ReturnType<typeof bindSessionEntryNumericChanges> | undefined;
          let snapshots: ReturnType<typeof splitSessionEntrySnapshots>["snapshots"] | undefined;
          let entryValid = row.entry_valid;
          let retiresArchiveUndo: boolean;
          if (params.rawTransform) {
            const entry = safeParseJsonRecord(row.entry_json);
            if (!entry) {
              continue;
            }
            assertSupportedSessionStoreEntry(entry);
            const previousSessionId = entry.sessionId;
            const previousUpdatedAt = entry.updatedAt;
            const previousFields = new Map(
              Object.entries(entry).map(([key, value]) => [key, JSON.stringify(value)]),
            );
            const repair = params.rawTransform(entry, sessionKey, row.updated_at, database);
            const transformed = repair.entry;
            if (repair.pendingInputOrigins?.inputs.length) {
              for (const origin of repair.pendingInputOrigins.inputs) {
                executeSqliteQuerySync(
                  database.db,
                  db
                    .updateTable("session_pending_inputs")
                    .set({ origin_source_json: origin.sourceJson })
                    .where("session_key", "=", sessionKey)
                    .where("session_id", "=", row.current_session_id)
                    .where("session_id", "=", repair.pendingInputOrigins.sessionId)
                    .where("input_id", "=", origin.inputId)
                    .where("run_id", "=", origin.runId)
                    .where("state", "=", "queued")
                    .where("consumed_event_id", "is", null)
                    .where("origin_source_json", "is", null),
                );
              }
            }
            numericProjection = repair.numericChanges
              ? bindSessionEntryNumericChanges(repair.numericChanges)
              : undefined;
            if (
              transformed.sessionId !== previousSessionId ||
              transformed.updatedAt !== previousUpdatedAt
            ) {
              throw new Error("Raw session state repair cannot change session identity");
            }
            let patched = sql.val(row.entry_json);
            for (const key of new Set([...previousFields.keys(), ...Object.keys(transformed)])) {
              const value = JSON.stringify(transformed[key]);
              if (value === previousFields.get(key)) {
                continue;
              }
              const jsonPath = `$.${JSON.stringify(key)}`;
              // Keep untouched numeric values in SQL instead of rounding them through JSON.parse.
              if (isPostgresSqlConnection(database.db)) {
                patched =
                  value === undefined
                    ? /* kysely-allow-raw: migration removes one bound top-level member. */ sql<string>`(${patched}::jsonb - ${key}::text)::text`
                    : /* kysely-allow-raw: a bound text[] names one exact member, including dots and quotes. */ sql<string>`jsonb_set(${patched}::jsonb, ARRAY[${key}]::text[], ${value}::jsonb)::text`;
              } else {
                patched =
                  value === undefined
                    ? /* kysely-allow-raw: migration removes only changed top-level JSON fields. */ sql<string>`json_remove(${patched}, ${jsonPath})`
                    : /* kysely-allow-raw: migration changes only owned top-level JSON fields. */ sql<string>`json_set(${patched}, ${jsonPath}, json(${value}))`;
              }
            }
            entryJson = executeSqliteQuerySync(
              database.db,
              db.selectNoFrom(patched.as("entry_json")),
            ).rows[0]!.entry_json;
            if (entryJson === row.entry_json) {
              continue;
            }
            retiresArchiveUndo = ["pinnedAt", "archivedAt", "lifecycleRevision", "sessionId"].some(
              (key) => previousFields.get(key) !== JSON.stringify(transformed[key]),
            );
            if (previousFields.get("status") !== JSON.stringify(transformed.status)) {
              runOutcome = transformed;
            }
            // Invalid identities remain for canonical-key repair; scalar migration cannot certify them.
            const parsedEntry = parseSqliteSessionEntryRecord({
              ...row,
              entry_json: entryJson,
            });
            if (!parsedEntry) {
              entryValid = 0;
            } else if (
              params.updateDeliveryProjection &&
              previousFields.get("delivery") !== JSON.stringify(transformed.delivery)
            ) {
              deliveryProjectionEntry = parsedEntry;
            }
          } else {
            const entry = parseSqliteSessionEntryRecord(row);
            if (!entry) {
              continue;
            }
            assertSupportedSessionStoreEntry(entry);
            attachSessionEntrySnapshots(entry, row);
            const previousJson = JSON.stringify(entry);
            const previousStatus = entry.status;
            const archiveFacts = (candidate: SessionEntry) => [
              candidate.sessionId,
              candidate.lifecycleRevision,
              candidate.archivedAt,
              candidate.pinnedAt,
            ];
            const previousArchive = archiveFacts(entry);
            const transformedEntry = params.transform(entry, sessionKey);
            if (JSON.stringify(transformedEntry) === previousJson) {
              continue;
            }
            retiresArchiveUndo = archiveFacts(transformedEntry).some(
              (value, index) => value !== previousArchive[index],
            );
            nextEntry = stripRuntimeOnlySessionSkillsFields(transformedEntry);
            ({ entryJson, snapshots } = splitSessionEntrySnapshots(nextEntry));
            entryValid = 1;
            if (previousStatus !== nextEntry.status) {
              runOutcome = nextEntry;
            }
          }
          assertRepairCurrent();
          invalidateSessionEntryMaintenanceAgeFact(database.db);
          markCanonicalSessionValidationPending(database, [sessionKey]);
          const runProjection = runOutcome
            ? {
                status: normalizeStatus(runOutcome.status),
                ended_at: asFiniteNumber(runOutcome.endedAt) ?? null,
              }
            : undefined;
          const predicateColumns = deriveSessionPredicateColumns(entryJson);
          executeSqliteQuerySync(
            database.db,
            db
              .updateTable("session_nodes")
              .set({
                entry_json: entryJson,
                ...(retiresArchiveUndo ? { archive_undo_marker: null } : {}),
                ...numericProjection?.node,
                ...predicateColumns,
                session_started_at: /* kysely-allow-raw: exact int64 bind; generated INTEGER reads are numbers. */ sql<
                  number | null
                >`${predicateColumns.session_started_at}`,
                entry_valid: entryValid,
                ...(runProjection ? { status: runProjection.status } : {}),
              })
              .where("session_key", "=", sessionKey),
          );
          if (snapshots) {
            writeSessionEntrySnapshots(database, sessionKey, snapshots);
          }
          const projected = deliveryProjectionEntry ?? nextEntry;
          const deliveryProjection =
            projected && params.updateDeliveryProjection
              ? {
                  account_id: deliveryContextFromSession(projected)?.accountId ?? null,
                  channel: sessionDeliveryChannel(projected) ?? null,
                }
              : undefined;
          if (deliveryProjection || runProjection || numericProjection?.window) {
            executeSqliteQuerySync(
              database.db,
              db
                .updateTable("session_windows")
                .set({ ...numericProjection?.window, ...deliveryProjection, ...runProjection })
                .where("session_id", "=", row.current_session_id),
            );
          }
          // Repair rows do not yet supply complete canonical runtime and side-table facts.
          publishSessionEntryCacheInvalidation(database, { sessionKey });
          batchRewritten += 1;
        }
        assertRepairCurrent();
        return batchRewritten;
      },
      databaseOptions,
      {
        operationLabel: "doctor.rewrite-session-entries",
        repairAdmission: {
          integrityCheck: params.integrityCheck,
          integrityTables: [
            "session_nodes",
            "session_entry_snapshots",
            "session_windows",
            "session_canonical_validation_pending",
          ],
          expectedIdentity: params.expectedIdentity,
          assertCurrent: params.assertCurrent,
        },
      },
    );
  }
  return rewritten;
}
