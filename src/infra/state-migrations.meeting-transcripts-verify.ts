// Verifies staged legacy transcript rows against the committed canonical store.
import type { DatabaseSync } from "node:sqlite";
import { stableStringify } from "@openclaw/normalization-core";
import { meetingTranscriptUtteranceQuery, utteranceFromRow } from "../transcripts/store-sqlite.js";
import { transcriptSessionSelector, TranscriptsStore } from "../transcripts/store.js";
import { executeSqliteQuerySync } from "./kysely-sync.js";
import {
  LEGACY_UTTERANCE_INSERT_CHUNK_SIZE,
  readStagedMeetingTranscriptUtterances,
  type LegacyMeetingTranscriptSnapshot,
} from "./state-migrations.meeting-transcripts-files.js";

export async function verifyImportedMeetingTranscriptSnapshots(params: {
  store: TranscriptsStore;
  snapshots: LegacyMeetingTranscriptSnapshot[];
  stageDatabase: DatabaseSync;
  database: DatabaseSync;
}): Promise<void> {
  for (const snapshot of params.snapshots) {
    const session = await params.store.readSession(transcriptSessionSelector(snapshot.session));
    if (!session || stableStringify(session) !== stableStringify(snapshot.session)) {
      throw new Error(`meeting transcript import verification failed: ${snapshot.relativeDir}`);
    }
    for (
      let start = 0;
      start < snapshot.utteranceCount;
      start += LEGACY_UTTERANCE_INSERT_CHUNK_SIZE
    ) {
      const expected = readStagedMeetingTranscriptUtterances({
        stageDatabase: params.stageDatabase,
        stageKey: snapshot.stageKey,
        start,
        limit: LEGACY_UTTERANCE_INSERT_CHUNK_SIZE,
      });
      const actual = executeSqliteQuerySync(
        params.database,
        meetingTranscriptUtteranceQuery(params.database, snapshot.session)
          .selectAll()
          .orderBy("sequence", "asc")
          .limit(LEGACY_UTTERANCE_INSERT_CHUNK_SIZE)
          .offset(start),
      ).rows.map((row) => ({
        ...utteranceFromRow({ ...row, metadata_json: null }),
        // Verify the exact legacy metadata, including values the runtime reader filters out.
        ...(row.metadata_json ? { metadata: JSON.parse(row.metadata_json) as unknown } : {}),
      }));
      if (stableStringify(actual) !== stableStringify(expected)) {
        throw new Error(`meeting transcript import verification failed: ${snapshot.relativeDir}`);
      }
    }
    const summary = await params.store.readSummary(session);
    if (
      stableStringify(summary.summary) !== stableStringify(snapshot.summary) ||
      stableStringify(summary.markdown?.trimEnd()) !== stableStringify(snapshot.markdown?.trimEnd())
    ) {
      throw new Error(`meeting transcript summary verification failed: ${snapshot.relativeDir}`);
    }
  }
}
