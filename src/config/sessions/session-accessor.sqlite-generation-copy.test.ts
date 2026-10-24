import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction as write,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  prepareTrajectoryPayload,
  readTrajectoryPayload,
} from "../../trajectory/runtime-payload.js";
import {
  copySqliteSessionGenerationRows as copyRows,
  readSqliteSessionGenerationComparison as readComparison,
  readSqliteSessionGenerationWindows as readWindows,
} from "./session-accessor.sqlite-generation-copy.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import { appendTranscriptEventsInTransaction } from "./session-accessor.sqlite-transcript-store.js";

it("treats a streaming copy onto its source as a no-op without deleting any rows", () =>
  withOpenClawTestState({ label: "generation-self-copy" }, async (state) => {
    const options = { agentId: "main", env: state.env };
    const scope = { ...options, sessionKey: "agent:main:copy", sessionId: "copy" };
    write((database) => {
      appendTranscriptEventsInTransaction(database, scope, [
        { type: "session", version: 3, id: scope.sessionId },
        {
          type: "message",
          id: "message",
          parentId: null,
          message: { role: "user", content: "kept" },
        },
      ]);
      const rows = (sql: string) => database.db.prepare(sql).all();
      const snapshot = () => ({
        events: rows("SELECT * FROM transcript_events ORDER BY seq"),
        identities: rows("SELECT * FROM transcript_event_identities ORDER BY event_id"),
      });
      const before = snapshot();
      expect(before.events).toHaveLength(2);
      copyRows({
        destination: database,
        source: database,
        sessionId: scope.sessionId,
        sourceWindowPresent: true,
      });
      expect(snapshot()).toEqual(before);
    }, options);
  }));

it.each(["UTF-8", "UTF-16le"])(
  "preserves mixed trajectory bytes and logical fingerprints when copying to %s",
  (encoding) =>
    withOpenClawTestState({ label: "generation-trajectory-copy" }, async (state) => {
      const sessionId = "trajectory-copy";
      const sourceOptions = { agentId: "main", env: state.env };
      const destinationOptions = {
        agentId: "destination",
        env: state.env,
        path: state.statePath("destination.sqlite"),
      };
      if (encoding !== "UTF-8") {
        using database = new DatabaseSync(destinationOptions.path);
        database.exec(
          "PRAGMA encoding = 'UTF-16le'; CREATE TABLE seed (id INTEGER); DROP TABLE seed;",
        );
      }
      const source = openOpenClawAgentDatabase(sourceOptions);
      const destination = openOpenClawAgentDatabase(destinationOptions);
      const legacyJson = '{ "type": "legacy", "value": "retained exact whitespace" }';
      const compressedJson = JSON.stringify({ text: "retained 🦞 bytes ".repeat(256) });
      const readRows = (database: typeof source) =>
        executeSqliteQuerySync(
          database.db,
          getSessionKysely(database.db)
            .selectFrom("trajectory_runtime_events")
            .selectAll()
            .where("session_id", "=", sessionId)
            .orderBy("seq"),
        ).rows;
      for (const options of [sourceOptions, destinationOptions]) {
        write((database) => {
          appendTranscriptEventsInTransaction(
            database,
            { ...options, sessionId, sessionKey: `agent:${options.agentId}:trajectory-copy` },
            [{ type: "session", version: 3, id: sessionId }],
          );
        }, options);
      }
      write((database) => {
        const payload = prepareTrajectoryPayload(database.db, compressedJson);
        expect(payload.event_codec).not.toBeNull();
        const legacy = {
          event_json: legacyJson,
          event_payload: null,
          event_codec: null,
          event_utf8_bytes: null,
        };
        const metadata = { session_id: sessionId, run_id: "run" };
        executeSqliteQuerySync(
          database.db,
          getSessionKysely(database.db)
            .insertInto("trajectory_runtime_events")
            .values([
              { ...metadata, seq: 0, created_at: 1, ...legacy },
              { ...metadata, seq: 1, created_at: 2, ...payload },
            ]),
        );
      }, sourceOptions);
      const before = readRows(source);
      write(
        (database) =>
          copyRows({
            destination: database,
            sessionId,
            source,
            sourceWindowPresent: true,
          }),
        destinationOptions,
      );
      const copied = readRows(destination);
      expect(copied.map(readTrajectoryPayload)).toEqual([legacyJson, compressedJson]);
      expect(readRows(source)).toEqual(before);
      if (encoding === "UTF-8") {
        expect(copied).toEqual(before);
      } else {
        expect(
          copied.map((row) => [row.event_codec, row.event_payload, row.event_utf8_bytes]),
        ).toEqual([
          [null, null, null],
          [null, null, null],
        ]);
      }
      const comparison = (database: typeof source) => {
        const [window] = readWindows(database, [], [sessionId]);
        if (!window) {
          throw new Error("Fixture session window is missing");
        }
        return readComparison(database, window).contentFingerprint;
      };
      expect(comparison(destination)).toBe(comparison(source));
    }),
);
