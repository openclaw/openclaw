import { describe, expect, it } from "vitest";
import {
  countMcpOAuthPrincipalsInDatabase,
  listMcpOAuthStoreKeysInDatabase,
  replaceMcpOAuthStoreInDatabase,
} from "../../agents/mcp-oauth-store.kernel.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import type { TranscriptUtterance } from "../../transcripts/provider-types.js";
import { ensureMeetingTranscriptsSchema } from "../../transcripts/sqlite-schema.js";
import {
  queryTranscriptReadEntries,
  readTranscriptLibraryEntry,
} from "../../transcripts/store-read.js";
import { writeMeetingTranscriptSessionInDatabase } from "../../transcripts/store-sqlite-write.js";
import { appendMeetingTranscriptUtterance } from "../../transcripts/store-sqlite.js";
import type { EngineConnection } from "../sql-connection.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { mixedAgentConnection, useMixedAgentPair } from "./mixed-agent.conformance.test-support.js";

const startedAt = "2026-10-20T00:00:00.000Z";

function writeSession(
  db: EngineConnection,
  sessionId: string,
  title: string | null,
  providerId: string,
) {
  const session = { sessionId, startedAt };
  writeMeetingTranscriptSessionInDatabase(db, {
    session,
    sessionValues: {
      started_at_ms: 1792454400000,
      selector: sessionId,
      export_key: sessionId,
      session_slug: sessionId,
      provider_id: providerId,
      title,
      source_json: JSON.stringify({ providerId }),
      stopped_at: null,
      metadata_json: null,
    },
    now: 100,
  });
  return session;
}

for (const engine of ["sqlite", "postgres"] as const) {
  describe.skipIf(engine === "postgres" && !mixedAgentConnection)(
    `${engine} store text comparisons`,
    () => {
      useMixedAgentPair(engine, engine);

      it("uses literal OAuth requester prefixes for keys and principal counts", () =>
        withEngineStoreAdmission(() => {
          const database = openOpenClawStateDatabase();
          const prefix = "portguard_%/";
          runOpenClawStateWriteTransaction(
            ({ db }) => {
              for (const key of [
                `${prefix}authorized`,
                `${prefix}empty`,
                "portguard_ax/other",
                `other/${prefix}embedded`,
              ]) {
                replaceMcpOAuthStoreInDatabase(
                  db,
                  key,
                  key.endsWith("empty")
                    ? {}
                    : { tokens: { access_token: "synthetic", token_type: "Bearer" } },
                );
              }
            },
            { database },
          );
          expect(listMcpOAuthStoreKeysInDatabase(database.db, prefix)).toEqual([
            `${prefix}authorized`,
            `${prefix}empty`,
          ]);
          expect(countMcpOAuthPrincipalsInDatabase(database.db, prefix)).toBe(1);
        }));

      it("finds case-insensitive literal substrings in transcript sessions and utterances", () =>
        withEngineStoreAdmission(() => {
          const database = openOpenClawStateDatabase();
          ensureMeetingTranscriptsSchema({ database });
          const providerId = "portguard-search";
          const textId = `${providerId}-b`;
          runOpenClawStateWriteTransaction(
            ({ db }) => {
              writeSession(db, `${providerId}-a`, "Budget NEEDLE_% review", providerId);
              const textSession = writeSession(db, textId, null, providerId);
              writeSession(db, `${providerId}-c`, "Budget needleXY review", providerId);
              for (const text of ["The NeedLE_% is retained.", "Unrelated notes."]) {
                appendMeetingTranscriptUtterance({
                  database: db,
                  session: textSession,
                  utterance: { text },
                  metadataJson: null,
                  now: 100,
                });
              }
            },
            { database },
          );
          expect(
            queryTranscriptReadEntries(database.db, { providerId, query: "needle_%" }).entries.map(
              (entry) => entry.selector,
            ),
          ).toEqual([`${providerId}-a`, textId]);
          expect(
            readTranscriptLibraryEntry(database.db, {
              selector: textId,
              includeUtterances: true,
              query: "needle_%",
            }).page,
          ).toMatchObject({
            utterances: [{ sequence: 0, text: "The NeedLE_% is retained." }],
            hasMore: false,
          });
        }));

      it("deduplicates identified utterances with nullable fields without losing changed payloads", () =>
        withEngineStoreAdmission(() => {
          const database = openOpenClawStateDatabase();
          ensureMeetingTranscriptsSchema({ database });
          const sessionId = "portguard-dedupe";
          const full: TranscriptUtterance = {
            id: "full",
            text: "Synthetic speech",
            startedAt,
            endedAt: "2026-10-20T00:00:01.000Z",
            speaker: { id: "speaker", label: "Synthetic speaker" },
            final: true,
          };
          runOpenClawStateWriteTransaction(
            ({ db }) => {
              const session = writeSession(db, sessionId, null, "portguard-dedupe");
              for (const [utterance, metadataJson] of [
                [full, '{"source":"synthetic"}'],
                [{ id: "bare", text: "Synthetic speech" }, null],
                [{ ...full, final: false }, '{"source":"synthetic"}'],
                [{ id: "bare", text: "Synthetic speech" }, "{}"],
              ] satisfies [TranscriptUtterance, string | null][]) {
                for (let copy = 0; copy < 2; copy++) {
                  appendMeetingTranscriptUtterance({
                    database: db,
                    session,
                    utterance,
                    metadataJson,
                    now: 100,
                  });
                }
              }
            },
            { database },
          );
          expect(
            database.db
              .prepare(
                "SELECT sequence, utterance_id, final, metadata_json FROM meeting_transcript_utterances WHERE session_id = ? ORDER BY sequence",
              )
              .all(sessionId)
              .map(({ sequence, utterance_id, final, metadata_json }) => [
                sequence,
                utterance_id,
                final,
                metadata_json,
              ]),
          ).toEqual([
            [0, "full", 1, '{"source":"synthetic"}'],
            [1, "bare", null, null],
            [2, "full", 0, '{"source":"synthetic"}'],
            [3, "bare", null, "{}"],
          ]);
          expect(
            database.db
              .prepare(
                "SELECT next_utterance_seq FROM meeting_transcript_sessions WHERE session_id = ?",
              )
              .get(sessionId),
          ).toEqual({ next_utterance_seq: 4 });
        }));
    },
  );
}
