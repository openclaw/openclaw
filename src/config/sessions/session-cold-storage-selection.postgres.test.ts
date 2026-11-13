import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { zstdCompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { withEngineStoreAdmission as admit } from "../../infra/database-engine/admission-scope.js";
import {
  mixedAgentConnection,
  useMixedAgentPair,
} from "../../infra/database-engine/mixed-agent.conformance.test-support.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { observeStatementEvents } from "../../infra/postgres-sync/sql.test-support.js";
import { isPostgresSqlConnection } from "../../infra/sql-connection.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { readSessionStateDeleteSnapshot } from "./session-accessor.sqlite-delete-snapshot.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { appendTranscriptEventsInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import { decodeSessionColdRecords } from "./session-cold-storage-codec.js";
import { selectSessionColdBatch } from "./session-cold-storage-selection.js";
import { transcriptEventJsonSql } from "./transcript-payload.js";

describe.skipIf(!mixedAgentConnection)("PostgreSQL cold transcript selection", () => {
  useMixedAgentPair("postgres", "postgres");

  it("skips protection reads only for full externalization batches and preserves incoming references", () => {
    const options = { agentId: "main" };
    const database = admit(() => openOpenClawAgentDatabase(options));
    expect(isPostgresSqlConnection(database.db)).toBe(true);
    const hotId = "hot-window";
    const coldId = "embedded-window";
    const referenceKey = "agent:main:reference";
    const snapshot = admit(() =>
      runOpenClawAgentWriteTransaction((writer) => {
        const db = getNodeSqliteKysely<DB>(writer.db);
        for (const sessionId of [hotId, coldId]) {
          const sessionKey = `agent:main:${sessionId}`;
          writeSessionEntry(writer, sessionKey, { sessionId, updatedAt: 1 });
          appendTranscriptEventsInTransaction(writer, { ...options, sessionKey, sessionId }, [
            { type: "metadata", timestamp: new Date(1).toISOString(), content: sessionId },
          ]);
        }
        writeSessionEntry(writer, referenceKey, {
          sessionId: "reference-window",
          updatedAt: 1,
          previousSessionId: hotId,
        });
        executeSqliteQuerySync(
          writer.db,
          db.updateTable("session_windows").set({ updated_at: 1, transcript_updated_at: 1 }),
        );
        const coldSnapshot = readSessionStateDeleteSnapshot(writer.db, coldId);
        assert(coldSnapshot.generation && coldSnapshot.lastSeq !== null);
        const rows = executeSqliteQuerySync(
          writer.db,
          db
            .selectFrom("transcript_events")
            .select(["seq", "created_at", transcriptEventJsonSql(writer.db).as("event_json")])
            .where("session_id", "=", coldId)
            .orderBy("seq"),
        ).rows;
        assert(rows.length > 0);
        const content =
          [
            { kind: "header", version: 1, sessionId: coldId, generation: coldSnapshot.generation },
            ...rows.map((row) => ({ kind: "event", row })),
          ]
            .map((row) => JSON.stringify(row))
            .join("\n") + "\n";
        const bytes = zstdCompressSync(Buffer.from(content));
        const hash = createHash("sha256").update(bytes).digest("hex");
        const archive = {
          session_id: coldId,
          generation: coldSnapshot.generation,
          archive_name: `${hash}.jsonl.zst`,
          archive_sha256: hash,
          event_count: rows.length,
          raw_bytes: rows.reduce((total, row) => total + Buffer.byteLength(row.event_json) + 1, -1),
          archive_bytes: bytes.length,
          last_seq: coldSnapshot.lastSeq,
          archived_at: 1,
          storage: "sqlite" as const,
          archive_blob: bytes,
        };
        // Keep a valid embedded archive and the generation that owns it, as real archival does.
        expect([...decodeSessionColdRecords(bytes, archive)]).toHaveLength(rows.length + 1);
        executeSqliteQuerySync(
          writer.db,
          db.insertInto("session_transcript_cold_archives").values(archive),
        );
        executeSqliteQuerySync(
          writer.db,
          db.deleteFrom("transcript_events").where("session_id", "=", coldId),
        );
        executeSqliteQuerySync(
          writer.db,
          db.deleteFrom("session_transcript_index_state").where("session_id", "=", coldId),
        );
        return readSessionStateDeleteSnapshot(writer.db, hotId);
      }, options),
    );
    const input = {
      databaseOptions: { ...options, path: database.path },
      admissionIdentities: [],
      liveSessionKeys: [],
      cooledSessionIds: [],
      beforeMs: 100,
      maxTranscripts: 1,
      maxBytes: 64 * 1024 * 1024,
    };
    for (const maxTranscripts of [1, 2]) {
      using observation = observeStatementEvents();
      const selected = admit(() => selectSessionColdBatch({ ...input, maxTranscripts }));
      assert(selected.found);
      expect(selected.value.externalizations.map((archive) => archive.session_id)).toEqual([
        coldId,
      ]);
      expect(selected.value.plans).toEqual([]);
      const protectionRead = expect.objectContaining({
        engine: "postgres",
        outcome: "ok",
        sql: expect.stringMatching(
          /select .*"last_activity_at".*"last_interaction_at".*from "session_nodes"/,
        ),
      });
      if (maxTranscripts === 1) {
        expect(observation.events).not.toEqual(expect.arrayContaining([protectionRead]));
      } else {
        expect(observation.events).toEqual(expect.arrayContaining([protectionRead]));
      }
    }
    admit(() =>
      runOpenClawAgentWriteTransaction((writer) => {
        writeSessionEntry(writer, referenceKey, { sessionId: "reference-window", updatedAt: 1 });
      }, options),
    );
    const selected = admit(() => selectSessionColdBatch({ ...input, maxTranscripts: 2 }));
    assert(selected.found);
    expect(selected.value.plans).toEqual([
      { databaseOptions: input.databaseOptions, sessionId: hotId, snapshot },
    ]);
  });
});
