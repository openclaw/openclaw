import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { prepareTranscriptPayload } from "../config/sessions/transcript-payload.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { readOnlySqliteDbStats } from "../infra/session-sqlite-migration-readers.js";

describe("read-only SQLite transcript statistics", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it.each([true])(
    "reports logical bytes without decoding compressed bodies (corrupt frame: %s)",
    (corruptFrame) => {
      const sqlitePath = path.join(tempDirs.make("openclaw-reader-stats-"), "agent.sqlite");
      const database = openNodeSqliteDatabase(sqlitePath);
      const compressedJson = JSON.stringify({ type: "custom", data: "雪🦞é".repeat(1024) });
      const identityJson = JSON.stringify({ type: "custom", data: "λ🦞" });
      try {
        database.exec(`CREATE TABLE transcript_events (
          session_id TEXT, seq INTEGER, event_json TEXT, event_zstd BLOB,
          event_utf8_bytes INTEGER, navigation_json TEXT
        ) STRICT`);
        const compressed = prepareTranscriptPayload(database, compressedJson);
        expect(compressed.event_zstd).not.toBeNull();
        const identity = prepareTranscriptPayload(database, identityJson);
        expect(identity.event_json).toBe(identityJson);
        const insert = database.prepare("INSERT INTO transcript_events VALUES (?, ?, ?, ?, ?, ?)");
        for (const [sessionId, seq, payload] of [
          ["compressed", 0, compressed],
          ["compressed", 1, identity],
          ["identity", 0, identity],
        ] as const) {
          insert.run(
            sessionId,
            seq,
            payload.event_json,
            payload.event_zstd,
            payload.event_utf8_bytes,
            payload.navigation_json,
          );
        }
        if (corruptFrame) {
          database
            .prepare(
              "UPDATE transcript_events SET event_zstd = x'010203' WHERE event_zstd IS NOT NULL",
            )
            .run();
        }
      } finally {
        database.close();
      }

      const compressedBytes = Buffer.byteLength(compressedJson);
      const identityBytes = Buffer.byteLength(identityJson);
      const result = readOnlySqliteDbStats({ agentId: "main", storePath: sqlitePath, sqlitePath });
      expect(result).toMatchObject({
        ok: true,
        stats: {
          integrityCheck: "ok",
          totalTranscriptRowBytes: compressedBytes + 2 * identityBytes,
          largestSessions: [
            { sessionId: "compressed", events: 2, rowBytes: compressedBytes + identityBytes },
            { sessionId: "identity", events: 1, rowBytes: identityBytes },
          ],
        },
      });
    },
  );
});
