import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
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
import { normalizeStatus } from "../../../config/sessions/session-accessor.sqlite-status.js";
import { markCanonicalSessionValidationPending } from "../../../config/sessions/session-canonical-key.js";
import { parseSqliteSessionEntryRecord } from "../../../config/sessions/session-entry-json.js";
import { attachSessionEntrySnapshots } from "../../../config/sessions/session-entry-snapshot-values.js";
import {
  sessionEntrySnapshotColumns,
  splitSessionEntrySnapshots,
  writeSessionEntrySnapshots,
} from "../../../config/sessions/session-entry-snapshots.js";
import { LEGACY_SESSION_ENTRY_STATE_FIELDS } from "../../../config/sessions/session-entry-state-format.js";
import { deriveSessionPredicateColumns } from "../../../config/sessions/session-predicate-columns.js";
import { stripRuntimeOnlySessionSkillsFields } from "../../../config/sessions/store-entry-shape.js";
import { assertSupportedSessionStoreEntry } from "../../../config/sessions/supported-session-store.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import { withEngineStoreAdmission } from "../../../infra/database-engine/admission-scope.js";
import { executeSqliteQuerySync, iterateSqliteQuerySync } from "../../../infra/kysely-sync.js";
import { isPostgresSqlConnection } from "../../../infra/sql-connection.js";
import { runWithSqliteCleanup } from "../../../infra/sqlite-lifecycle-errors.js";
import { SqliteSnapshotCleanupError } from "../../../infra/sqlite-readonly-location-cleanup.js";
import { prepareSqliteReadOnlyLocationSync } from "../../../infra/sqlite-snapshot-source.js";
import {
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
  type DatabaseFileIdentity,
} from "../../../infra/sqlite-worker-identity.js";
import { hasUpdateDoctorMigrationCapture } from "../../../infra/update-doctor-migration-attribution.js";
import { agentEngineInput } from "../../../state/openclaw-agent-db-engine.js";
import { assertOpenClawAgentDatabaseIdentity } from "../../../state/openclaw-agent-db-identity.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../../state/openclaw-agent-db-readonly.js";
import {
  runOpenClawAgentWriteTransaction,
  withOpenClawAgentDatabaseAsync,
} from "../../../state/openclaw-agent-db.js";
import { getOpenClawDatabaseMaintenanceScope } from "../../../state/openclaw-state-maintenance-context.js";
import { chunkItems } from "../../../utils/chunk-items.js";
import {
  deliveryContextFromSession,
  sessionDeliveryChannel,
} from "../../../utils/delivery-context.read.js";
import { migrateLegacySessionRunOutcome } from "./session-entry-shape.js";

const DOCTOR_SESSION_REWRITE_BATCH_SIZE = 64;

export function iterateDoctorSessionKeyBatches(sessionKeys: readonly string[]): string[][] {
  return chunkItems(uniqueStrings(sessionKeys).toSorted(), DOCTOR_SESSION_REWRITE_BATCH_SIZE);
}

/** Select legacy state before loading raw rows into canonical validation or runtime projection. */
export function scanDoctorSessionEntryRecords(
  scope: DoctorSessionScanScope,
  visit: (record: { sessionKey: string; entry: Record<string, unknown> }) => void,
  expectedIdentity: DatabaseFileIdentity,
): void {
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
  const scan = (options: typeof databaseOptions, identity: DatabaseFileIdentity) =>
    withOpenClawAgentDatabaseReadOnly((database) => {
      assertOpenClawAgentDatabaseIdentity(database, identity);
      for (const row of iterateSqliteQuerySync(
        database.db,
        getSessionKysely(database.db)
          .selectFrom("session_nodes")
          .select(["session_key", "entry_json"])
          .where(
            isPostgresSqlConnection(database.db)
              ? /* kysely-allow-raw: native JSON filtering bounds parsing; JSON.parse owns duplicate-key precedence. */ sql<boolean>`CASE WHEN entry_json IS JSON OBJECT THEN EXISTS (
                SELECT 1 FROM json_each(entry_json::json)
                WHERE key IN (${sql.join(LEGACY_SESSION_ENTRY_STATE_FIELDS)})
                  OR key IN ('provider', 'lastProvider', 'room')
                  OR (key = 'pendingFinalDelivery' AND json_typeof(value) = 'boolean')
                  OR (key = 'status' AND value #>> '{}' IN ('running', 'queued'))
              ) WHEN entry_json IS JSON THEN FALSE ELSE TRUE END`
              : /* kysely-allow-raw: native JSON filtering bounds parsing; JSON.parse owns duplicate-key precedence. */ sql<boolean>`CASE WHEN json_valid(entry_json) THEN EXISTS (
            SELECT 1 FROM json_each(entry_json)
            WHERE key IN (${sql.join(LEGACY_SESSION_ENTRY_STATE_FIELDS)})
              OR key IN ('provider', 'lastProvider', 'room')
              OR (key = 'pendingFinalDelivery' AND type IN ('true', 'false'))
              OR (key = 'status' AND value IN ('running', 'queued'))
          ) ELSE 1 END`,
          ),
      )) {
        const entry = safeParseJsonRecord(row.entry_json);
        if (entry) {
          assertSupportedSessionStoreEntry(entry);
          visit({ sessionKey: row.session_key, entry });
        }
      }
    }, options);
  const read = () => {
    if (!captured) {
      return scan(databaseOptions, expectedIdentity);
    }
    assertSourceCurrent();
    // The child pins the original source identity; the reader keeps its private identity.
    const snapshot = prepareSqliteReadOnlyLocationSync(scope.storePath, expectedIdentity);
    return runWithSqliteCleanup(
      {
        release() {
          if (!snapshot.cleanup()) {
            throw new SqliteSnapshotCleanupError(
              "Doctor session inspection snapshot cleanup failed.",
            );
          }
        },
      },
      "Doctor session inspection",
      () => {
        assertSourceCurrent();
        const result = scan(
          { ...databaseOptions, path: snapshot.location },
          readDatabasePathIdentitySync(snapshot.location),
        );
        assertSourceCurrent();
        return result;
      },
    );
  };
  const result = read();
  if (!result.found) {
    throw new Error(`Session database unavailable during raw state inspection: ${result.reason}`);
  }
}

/** Startup normalizes legacy outcomes before canonical reads; clean stores stay read-only. */
export async function repairLegacySessionRunOutcomes(
  scope: DoctorSessionScanScope,
  assertCurrent: () => void,
): Promise<number> {
  assertCurrent();
  const expectedIdentity = readDatabasePathIdentitySync(scope.storePath);
  const sessionKeys: string[] = [];
  withEngineStoreAdmission(() =>
    scanDoctorSessionEntryRecords(
      scope,
      ({ entry, sessionKey }) => {
        if (entry.status === "running" || entry.status === "queued") {
          sessionKeys.push(sessionKey);
        }
      },
      expectedIdentity,
    ),
  );
  assertCurrent();
  if (sessionKeys.length === 0) {
    return 0;
  }
  const assertRepairCurrent = () => {
    assertCurrent();
    assertExistingDatabaseIdentity(
      scope.storePath,
      expectedIdentity.key,
      expectedIdentity.birthtime,
    );
  };
  const repair = () =>
    withEngineStoreAdmission(() => {
      assertRepairCurrent();
      return rewriteDoctorSessionEntries({
        scope,
        sessionKeys,
        rawTransform: migrateLegacySessionRunOutcome,
        expectedIdentity,
        assertCurrent,
      });
    });
  return agentEngineInput()
    ? repair()
    : withOpenClawAgentDatabaseAsync(
        toDatabaseOptions(resolveSqliteScope({ ...scope, sessionKey: "" })),
        repair,
        assertRepairCurrent,
      );
}

/** Rewrites bounded entry batches after rereading each authoritative row inside its commit. */
export function rewriteDoctorSessionEntries(
  params: {
    scope: DoctorSessionScanScope;
    sessionKeys: readonly string[];
    updateDeliveryProjection?: boolean;
    assertCurrent?: () => void;
    expectedIdentity?: DatabaseFileIdentity;
  } & (
    | { transform: (entry: SessionEntry, sessionKey: string) => SessionEntry; rawTransform?: never }
    | {
        rawTransform: (
          entry: Record<string, unknown>,
          sessionKey: string,
          updatedAt: number,
        ) => Record<string, unknown>;
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
          let snapshots: ReturnType<typeof splitSessionEntrySnapshots>["snapshots"] | undefined;
          let entryValid = row.entry_valid;
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
            const transformed = params.rawTransform(entry, sessionKey, row.updated_at);
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
            if (previousFields.get("status") !== JSON.stringify(transformed.status)) {
              runOutcome = transformed;
            }
            // Invalid identities remain for canonical-key repair; scalar migration cannot certify them.
            const parsedEntry = parseSqliteSessionEntryRecord({ ...row, entry_json: entryJson });
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
            const transformedEntry = params.transform(entry, sessionKey);
            if (JSON.stringify(transformedEntry) === previousJson) {
              continue;
            }
            nextEntry = stripRuntimeOnlySessionSkillsFields(transformedEntry);
            ({ entryJson, snapshots } = splitSessionEntrySnapshots(nextEntry));
            if (!parseSqliteSessionEntryRecord({ ...row, entry_json: entryJson })) {
              continue;
            }
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
          if (deliveryProjection || runProjection) {
            executeSqliteQuerySync(
              database.db,
              db
                .updateTable("session_windows")
                .set({ ...deliveryProjection, ...runProjection })
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
          expectedIdentity: params.expectedIdentity,
          assertCurrent: params.assertCurrent,
        },
      },
    );
  }
  return rewritten;
}
