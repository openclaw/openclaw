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
import {
  appendMeetingTranscriptUtterance,
  meetingTranscriptDb,
} from "../../transcripts/store-sqlite.js";
import { executeSqliteQuerySync, executeSqliteQueryTakeFirstSync } from "../kysely-sync.js";
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

      it.each(["list", "count"] as const)(
        "uses literal OAuth requester prefixes for %s",
        (operation) =>
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
            if (operation === "list") {
              expect(listMcpOAuthStoreKeysInDatabase(database.db, prefix)).toEqual([
                `${prefix}authorized`,
                `${prefix}empty`,
              ]);
            } else {
              expect(countMcpOAuthPrincipalsInDatabase(database.db, prefix)).toBe(1);
            }
          }),
      );

      it.each(["sessions", "utterances"] as const)(
        "finds case-insensitive literal substrings in transcript %s",
        (operation) =>
          withEngineStoreAdmission(() => {
            const database = openOpenClawStateDatabase();
            ensureMeetingTranscriptsSchema({ database });
            const providerId = `portguard-${operation}`;
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
            if (operation === "sessions") {
              const result = queryTranscriptReadEntries(database.db, {
                providerId,
                query: "needle_%",
              });
              expect(result.entries.map((entry) => entry.selector)).toEqual([
                `${providerId}-a`,
                textId,
              ]);
            } else {
              const result = readTranscriptLibraryEntry(database.db, {
                selector: textId,
                includeUtterances: true,
                query: "needle_%",
              });
              expect(result.page).toMatchObject({
                utterances: [{ sequence: 0, text: "The NeedLE_% is retained." }],
                hasMore: false,
              });
            }
          }),
      );

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
            executeSqliteQuerySync(
              database.db,
              meetingTranscriptDb(database.db)
                .selectFrom("meeting_transcript_utterances")
                .select(["sequence", "utterance_id", "final", "metadata_json"])
                .where("session_id", "=", sessionId)
                .orderBy("sequence", "asc"),
            ).rows,
          ).toEqual([
            {
              sequence: 0,
              utterance_id: "full",
              final: 1,
              metadata_json: '{"source":"synthetic"}',
            },
            { sequence: 1, utterance_id: "bare", final: null, metadata_json: null },
            {
              sequence: 2,
              utterance_id: "full",
              final: 0,
              metadata_json: '{"source":"synthetic"}',
            },
            { sequence: 3, utterance_id: "bare", final: null, metadata_json: "{}" },
          ]);
          expect(
            executeSqliteQueryTakeFirstSync(
              database.db,
              meetingTranscriptDb(database.db)
                .selectFrom("meeting_transcript_sessions")
                .select("next_utterance_seq")
                .where("session_id", "=", sessionId),
            ),
          ).toEqual({ next_utterance_seq: 4 });
        }));
    },
  );
}
