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
import { parseSqliteSessionEntryRecord } from "../../../config/sessions/session-entry-json.js";
import {
  attachSessionEntrySnapshots,
  sessionEntrySnapshotColumns,
  splitSessionEntrySnapshots,
  writeSessionEntrySnapshots,
} from "../../../config/sessions/session-entry-snapshots.js";
import { LEGACY_SESSION_ENTRY_STATE_FIELDS } from "../../../config/sessions/session-entry-state-format.js";
import { stripRuntimeOnlySessionSkillsFields } from "../../../config/sessions/store-entry-shape.js";
import { assertSupportedSessionStoreEntry } from "../../../config/sessions/supported-session-store.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import { executeSqliteQuerySync, iterateSqliteQuerySync } from "../../../infra/kysely-sync.js";
import type { DatabaseFileIdentity } from "../../../infra/sqlite-worker-identity.js";
import { assertOpenClawAgentDatabaseIdentity } from "../../../state/openclaw-agent-db-identity.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../../state/openclaw-agent-db-readonly.js";
import { runOpenClawAgentWriteTransaction } from "../../../state/openclaw-agent-db.js";
import { chunkItems } from "../../../utils/chunk-items.js";
import {
  deliveryContextFromSession,
  sessionDeliveryChannel,
} from "../../../utils/delivery-context.read.js";

const DOCTOR_SESSION_REWRITE_BATCH_SIZE = 64;

export function iterateDoctorSessionKeyBatches(sessionKeys: readonly string[]): string[][] {
  return chunkItems(uniqueStrings(sessionKeys).toSorted(), DOCTOR_SESSION_REWRITE_BATCH_SIZE);
}

function parseDoctorSessionEntryRecord(entryJson: string): Record<string, unknown> | undefined {
  try {
    const entry: unknown = JSON.parse(entryJson);
    return isRecord(entry) ? entry : undefined;
  } catch {
    return undefined;
  }
}

/** Select legacy state before loading raw rows into canonical validation or runtime projection. */
export function scanDoctorSessionEntryRecords(
  scope: DoctorSessionScanScope,
  visit: (record: { sessionKey: string; entry: Record<string, unknown> }) => void,
  expectedIdentity: DatabaseFileIdentity,
): void {
  const resolved = resolveSqliteScope({ ...scope, sessionKey: "" });
  const result = withOpenClawAgentDatabaseReadOnly((database) => {
    assertOpenClawAgentDatabaseIdentity(database, expectedIdentity);
    for (const row of iterateSqliteQuerySync(
      database.db,
      getSessionKysely(database.db)
        .selectFrom("session_nodes")
        .select(["session_key", "entry_json"])
        .where(
          /* kysely-allow-raw: coarse key filtering bounds parsing; JSON.parse owns duplicate-key precedence. */
          sql<boolean>`CASE WHEN json_valid(entry_json) THEN EXISTS (
            SELECT 1 FROM json_each(entry_json)
            WHERE key IN (${sql.join(LEGACY_SESSION_ENTRY_STATE_FIELDS)})
              OR key IN ('provider', 'lastProvider', 'room')
              OR (key = 'pendingFinalDelivery' AND type IN ('true', 'false'))
          ) ELSE 1 END`,
        ),
    )) {
      const entry = parseDoctorSessionEntryRecord(row.entry_json);
      if (entry) {
        assertSupportedSessionStoreEntry(entry);
        visit({ sessionKey: row.session_key, entry });
      }
    }
  }, toDatabaseOptions(resolved));
  if (!result.found) {
    throw new Error(`Session database unavailable during raw state inspection: ${result.reason}`);
  }
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
        params.assertCurrent?.();
        if (params.expectedIdentity) {
          assertOpenClawAgentDatabaseIdentity(database, params.expectedIdentity);
        }
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
          let snapshots: ReturnType<typeof splitSessionEntrySnapshots>["snapshots"] | undefined;
          let entryValid = row.entry_valid;
          if (params.rawTransform) {
            const entry = parseDoctorSessionEntryRecord(row.entry_json);
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
              // SQLite preserves untouched numeric tokens and opaque values outside this repair.
              patched =
                value === undefined
                  ? /* kysely-allow-raw: migration removes only changed top-level JSON fields. */ sql<string>`json_remove(${patched}, ${jsonPath})`
                  : /* kysely-allow-raw: migration changes only owned top-level JSON fields. */ sql<string>`json_set(${patched}, ${jsonPath}, json(${value}))`;
            }
            entryJson = executeSqliteQuerySync(
              database.db,
              db.selectNoFrom(patched.as("entry_json")),
            ).rows[0]!.entry_json;
            if (entryJson === row.entry_json) {
              continue;
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
          }
          params.assertCurrent?.();
          if (params.expectedIdentity) {
            assertOpenClawAgentDatabaseIdentity(database, params.expectedIdentity);
          }
          invalidateSessionEntryMaintenanceAgeFact(database.db);
          executeSqliteQuerySync(
            database.db,
            db
              .updateTable("session_nodes")
              .set({ entry_json: entryJson })
              .where("session_key", "=", sessionKey),
          );
          if (snapshots) {
            writeSessionEntrySnapshots(database, sessionKey, snapshots);
          }
          executeSqliteQuerySync(
            database.db,
            db
              .updateTable("session_nodes")
              .set({ entry_valid: entryValid })
              .where("session_key", "=", sessionKey),
          );
          const projected = deliveryProjectionEntry ?? nextEntry;
          if (projected && params.updateDeliveryProjection) {
            executeSqliteQuerySync(
              database.db,
              db
                .updateTable("session_windows")
                .set({
                  account_id: deliveryContextFromSession(projected)?.accountId ?? null,
                  channel: sessionDeliveryChannel(projected) ?? null,
                })
                .where("session_id", "=", row.current_session_id),
            );
          }
          // Repair rows do not yet supply complete canonical runtime and side-table facts.
          publishSessionEntryCacheInvalidation(database, { sessionKey });
          batchRewritten += 1;
        }
        params.assertCurrent?.();
        if (params.expectedIdentity) {
          assertOpenClawAgentDatabaseIdentity(database, params.expectedIdentity);
        }
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
