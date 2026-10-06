import type { DatabaseSync } from "node:sqlite";
import type { Selectable } from "kysely";
import { executeSqliteQuerySync, executeSqliteQueryTakeFirstSync } from "../infra/kysely-sync.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import type { TranscriptSessionDescriptor } from "./provider-types.js";
import { TranscriptSessionConflictError, TranscriptsSummaryChangedError } from "./store-errors.js";
import {
  parseTranscriptExportManifest,
  parseTranscriptPendingExports,
} from "./store-export-state.js";
import {
  readTranscriptCanonicalSessionRow,
  readTranscriptExportOwnership,
} from "./store-sqlite-read.js";
import {
  meetingTranscriptDb,
  meetingTranscriptSessionQuery,
  parseOptionalJsonRecord,
  type MeetingTranscriptSessionRow,
  readTranscriptSummaryInputRevision,
  readStoredTranscriptSummaryRevision,
  sessionFromRow,
  transcriptSummaryInputRevisionFromRow,
} from "./store-sqlite.js";
import type { TranscriptSummaryWriteGuard } from "./store-types.js";

type TranscriptSessionValues = Pick<
  MeetingTranscriptSessionRow,
  | "selector"
  | "export_key"
  | "session_slug"
  | "provider_id"
  | "title"
  | "source_json"
  | "stopped_at"
  | "metadata_json"
>;
type TranscriptSummaryValues = Pick<
  Selectable<DB["meeting_transcript_summaries"]>,
  "generated_at" | "summary_json" | "markdown" | "utterance_count"
>;

function assertMeetingTranscriptSelectorAvailableInDatabase(
  database: DatabaseSync,
  session: Pick<TranscriptSessionDescriptor, "sessionId" | "startedAt">,
  selector: string,
): void {
  const owner = readTranscriptCanonicalSessionRow(database, selector);
  if (owner && (owner.session_id !== session.sessionId || owner.started_at !== session.startedAt)) {
    throw new TranscriptSessionConflictError();
  }
}

export function writeMeetingTranscriptSessionInDatabase(
  database: DatabaseSync,
  params: {
    session: Pick<TranscriptSessionDescriptor, "sessionId" | "startedAt">;
    sessionValues: TranscriptSessionValues;
    now: number;
    expectedInputRevision?: string;
  },
): void {
  const { session, sessionValues, now, expectedInputRevision } = params;
  if (
    expectedInputRevision !== undefined &&
    readTranscriptSummaryInputRevision(database, session) !== expectedInputRevision
  ) {
    throw new TranscriptsSummaryChangedError();
  }
  assertMeetingTranscriptSelectorAvailableInDatabase(database, session, sessionValues.selector);
  const previous = executeSqliteQueryTakeFirstSync(
    database,
    meetingTranscriptSessionQuery(database, session).selectAll(),
  );
  if (previous) {
    // ID origin belongs to admission, including the absence of that fact in legacy rows.
    const admittedMetadata = sessionFromRow(previous).metadata;
    let metadata = parseOptionalJsonRecord(sessionValues.metadata_json);
    if (admittedMetadata && Object.hasOwn(admittedMetadata, "sessionIdOrigin")) {
      metadata = { ...metadata, sessionIdOrigin: admittedMetadata.sessionIdOrigin };
    } else if (metadata) {
      delete metadata.sessionIdOrigin;
    }
    sessionValues.metadata_json = metadata ? JSON.stringify(metadata) : null;
  }
  executeSqliteQuerySync(
    database,
    meetingTranscriptDb(database)
      .insertInto("meeting_transcript_sessions")
      .values({
        session_id: session.sessionId,
        started_at: session.startedAt,
        ...sessionValues,
        export_manifest_json: "{}",
        export_pending_json: "[]",
        next_utterance_seq: 0,
        created_at_ms: now,
        updated_at_ms: now,
      })
      .onConflict((conflict) =>
        conflict.columns(["session_id", "started_at"]).doUpdateSet({
          ...sessionValues,
          updated_at_ms: now,
        }),
      ),
  );
}

export function writeMeetingTranscriptSummaryInDatabase(
  database: DatabaseSync,
  session: Pick<TranscriptSessionDescriptor, "sessionId" | "startedAt">,
  summaryValues: TranscriptSummaryValues,
  guard?: TranscriptSummaryWriteGuard,
): void {
  if (guard) {
    // Recheck both transcript and prior notes under the same writer lock as publication.
    const row = executeSqliteQueryTakeFirstSync(
      database,
      meetingTranscriptSessionQuery(database, session).selectAll(),
    );
    if (
      !row ||
      (guard.allowAppends && row.stopped_at !== null) ||
      row.next_utterance_seq < guard.nextSequence ||
      transcriptSummaryInputRevisionFromRow({
        ...row,
        ...(guard.allowAppends ? { next_utterance_seq: guard.nextSequence } : {}),
      }) !== guard.inputRevision ||
      (readStoredTranscriptSummaryRevision(database, session) ?? "") !== guard.summaryRevision
    ) {
      throw new TranscriptsSummaryChangedError();
    }
  }
  executeSqliteQuerySync(
    database,
    meetingTranscriptDb(database)
      .insertInto("meeting_transcript_summaries")
      .values({
        session_id: session.sessionId,
        session_started_at: session.startedAt,
        ...summaryValues,
      })
      .onConflict((conflict) =>
        conflict.columns(["session_id", "session_started_at"]).doUpdateSet(summaryValues),
      ),
  );
}

function updateMeetingTranscriptExportState(
  database: DatabaseSync,
  session: Pick<TranscriptSessionDescriptor, "sessionId" | "startedAt">,
  update: (
    stored:
      | Pick<MeetingTranscriptSessionRow, "export_manifest_json" | "export_pending_json">
      | undefined,
  ) => { export_pending_json: string; export_manifest_json?: string },
): void {
  const stored = readTranscriptExportOwnership(database, session);
  executeSqliteQuerySync(
    database,
    meetingTranscriptDb(database)
      .updateTable("meeting_transcript_sessions")
      .set(update(stored))
      .where("session_id", "=", session.sessionId)
      .where("started_at", "=", session.startedAt),
  );
}

export function updateMeetingTranscriptExportManifestInDatabase(
  database: DatabaseSync,
  session: Pick<TranscriptSessionDescriptor, "sessionId" | "startedAt">,
  exportedHashes: Readonly<Record<string, string>>,
  removedExports: ReadonlySet<string>,
): void {
  updateMeetingTranscriptExportState(database, session, (stored) => {
    const manifest = stored ? parseTranscriptExportManifest(stored.export_manifest_json) : {};
    const pending = stored
      ? parseTranscriptPendingExports(stored.export_pending_json)
      : new Set<string>();
    for (const fileName of removedExports) {
      delete manifest[fileName];
    }
    for (const fileName of [...Object.keys(exportedHashes), ...removedExports]) {
      pending.delete(fileName);
    }
    return {
      export_manifest_json: JSON.stringify({ ...manifest, ...exportedHashes }),
      export_pending_json: JSON.stringify([...pending].toSorted()),
    };
  });
}

export function markMeetingTranscriptPendingExportsInDatabase(
  database: DatabaseSync,
  session: Pick<TranscriptSessionDescriptor, "sessionId" | "startedAt">,
  fileNames: string[],
): void {
  updateMeetingTranscriptExportState(database, session, (stored) => {
    if (!stored) {
      throw new Error(`transcripts session not found: ${session.sessionId}`);
    }
    const pending = parseTranscriptPendingExports(stored.export_pending_json);
    for (const fileName of fileNames) {
      pending.add(fileName);
    }
    return { export_pending_json: JSON.stringify([...pending].toSorted()) };
  });
}
