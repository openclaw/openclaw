import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  CODE_MODE_STORE_CUSTOM_TYPE,
  collectCodeModeStoreWrites,
} from "../../agents/code-mode-session-store-replay.js";
import { iterateSqliteQuerySync } from "../../infra/kysely-sync.js";
import { runSqliteReadSnapshotSync } from "../../infra/sqlite-transaction.js";
import { NESTED_TOOL_ACTIVITY_CUSTOM_TYPE } from "../../sessions/nested-tool-activity.js";
import type { OpenClawAgentReadOnlyDatabase } from "../../state/openclaw-agent-db-readonly.js";
import type { TranscriptEvent } from "./session-accessor.sqlite-contract.js";
import { readSessionEntryIdentity } from "./session-accessor.sqlite-entry-read.js";
import { readTranscriptIdentityByEventId } from "./session-accessor.sqlite-read.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import {
  loadTranscriptSuffixEventsBoundedFromDatabase,
  readPreviousIndexedTranscriptEventSync,
} from "./session-accessor.sqlite-suffix-read.js";
import { resolveTranscriptMessageAppendParent } from "./session-accessor.sqlite-transcript-parent.js";
import { readTranscriptContextVersionInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import type { SessionTranscriptRuntimeTarget } from "./session-accessor.types.js";
import { readWithCanonicalSessionAdmission } from "./session-canonical-key.js";
import { assertSessionTranscriptHot } from "./session-cold-storage-state.js";
import type {
  SessionTranscriptMaintenanceRead,
  SessionTranscriptMaintenanceFacts,
} from "./session-transcript-hydration.types.js";
import { selectTranscriptMaintenanceSuffix } from "./session-transcript-maintenance-suffix.js";
import { resolveSqliteSessionTranscriptReadFence } from "./session-transcript-read-fence.js";
import {
  readTranscriptReportEvent,
  readTranscriptReportNavigation,
} from "./session-transcript-report-read.js";
import { transcriptEventJsonSql } from "./transcript-payload.js";

export function readSessionTranscriptMaintenance(
  database: OpenClawAgentReadOnlyDatabase,
  target: SessionTranscriptRuntimeTarget,
  request: SessionTranscriptMaintenanceRead,
): SessionTranscriptMaintenanceFacts {
  if (request.operation === "custom-branch" || request.operation === "code-mode-store") {
    return readWithCanonicalSessionAdmission(database, () =>
      runSqliteReadSnapshotSync(database.db, () => {
        const fence = resolveSqliteSessionTranscriptReadFence({ database, ...target });
        assertSessionTranscriptHot(database.db, target.sessionId);
        const version = readTranscriptContextVersionInTransaction(database, target.sessionId);
        if (request.operation === "code-mode-store" && fence && version.rawSeq !== null) {
          version.rawSeq = Math.min(version.rawSeq, fence.beforeRawSeq - 1);
        }
        const customType =
          request.operation === "code-mode-store"
            ? CODE_MODE_STORE_CUSTOM_TYPE
            : request.customType;
        const checkpoint = request.operation === "code-mode-store" ? request.checkpoint : undefined;
        let events: Iterable<Record<string, unknown>> | undefined;
        if (
          checkpoint &&
          checkpoint.generation === version.generation &&
          checkpoint.rawSeq <= (version.rawSeq ?? -1)
        ) {
          const rows = iterateSqliteQuerySync(
            database.db,
            getSessionKysely(database.db)
              .selectFrom("transcript_events")
              .select(transcriptEventJsonSql(database.db).as("event_json"))
              .where("session_id", "=", target.sessionId)
              .where("seq", ">", checkpoint.rawSeq)
              .where("seq", "<=", version.rawSeq!)
              .orderBy("seq", "asc")
              .limit(257),
          );
          events = selectTranscriptMaintenanceSuffix(
            (function* () {
              for (const row of rows) {
                yield {
                  event: JSON.parse(row.event_json) as unknown,
                  bytes: row.event_json.length * 2,
                };
              }
            })(),
            checkpoint,
            request.leafEntryId,
            customType,
          );
        }
        const incremental = events !== undefined;
        if (!events) {
          const navigation = readTranscriptReportNavigation(
            database,
            target.sessionId,
            fence?.beforeRawSeq,
          );
          events = navigation.readCustomBranch(request.leafEntryId, customType, (seq) =>
            readTranscriptReportEvent(database, target.sessionId, seq),
          );
        }
        return {
          kind: "transcript-maintenance" as const,
          version,
          ...(request.operation === "code-mode-store"
            ? {
                store: events
                  ? { writes: collectCodeModeStoreWrites(events, incremental), incremental }
                  : undefined,
              }
            : { events: events && [...events] }),
        };
      }),
    );
  }
  if (request.operation === "previous") {
    return {
      kind: "transcript-maintenance",
      previous: readPreviousIndexedTranscriptEventSync(target, request.beforeSeq, {
        readOnly: true,
      })?.event,
    };
  }
  if (request.operation === "suffix") {
    return {
      kind: "transcript-maintenance",
      events: loadTranscriptSuffixEventsBoundedFromDatabase(
        database,
        target,
        request.startSeq,
        request,
      ),
    };
  }
  if (request.operation === "nested-activity") {
    return readWithCanonicalSessionAdmission(database, () =>
      runSqliteReadSnapshotSync(database.db, () => {
        const first = readTranscriptIdentityByEventId(
          database,
          target.sessionId,
          request.firstEntryId,
        );
        const last = readTranscriptIdentityByEventId(
          database,
          target.sessionId,
          request.lastEntryId,
        );
        if (!first || !last || first.seq > last.seq) {
          throw new Error("Accepted nested tool activity is no longer available");
        }
        // These exact accepted entries attest this attempt's own tool evidence,
        // including rows after its user admission and before a compaction boundary.
        const rows = iterateSqliteQuerySync(
          database.db,
          getSessionKysely(database.db)
            .selectFrom("transcript_events")
            .select(transcriptEventJsonSql(database.db).as("event_json"))
            .where("session_id", "=", target.sessionId)
            .where("seq", ">=", first.seq)
            .where("seq", "<=", last.seq)
            .orderBy("seq", "asc"),
        );
        const events: TranscriptEvent[] = [];
        for (const row of rows) {
          const event: TranscriptEvent = JSON.parse(row.event_json);
          const message = asOptionalRecord(asOptionalRecord(event)?.message);
          if (
            message?.customType === NESTED_TOOL_ACTIVITY_CUSTOM_TYPE &&
            asOptionalRecord(message.details)?.scopeId === request.scopeId
          ) {
            events.push(event);
          }
        }
        return { kind: "transcript-maintenance" as const, events };
      }),
    );
  }
  return readWithCanonicalSessionAdmission(database, () =>
    runSqliteReadSnapshotSync(
      database.db,
      (): SessionTranscriptMaintenanceFacts =>
        request.operation === "identity"
          ? {
              kind: "transcript-maintenance",
              seq: readTranscriptIdentityByEventId(database, target.sessionId, request.eventId)
                ?.seq,
            }
          : {
              kind: "transcript-maintenance",
              version: readTranscriptContextVersionInTransaction(database, target.sessionId),
              lifecycleRevision: readSessionEntryIdentity(database, target.sessionKey)
                ?.lifecycleRevision,
              appendParentId: resolveTranscriptMessageAppendParent(database, target.sessionId, {}),
            },
      { databaseLabel: database.path, operationLabel: "session transcript maintenance read" },
    ),
  );
}
