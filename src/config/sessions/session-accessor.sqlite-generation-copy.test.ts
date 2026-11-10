import { DatabaseSync } from "node:sqlite";
import { assert, expect, it } from "vitest";
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
import { messageEvent } from "./transcript-message.test-support.js";

it.each(["self", "UTF-8", "UTF-16le"])(
  "preserves generation rows and payloads on %s copy",
  (encoding) =>
    withOpenClawTestState({ label: "generation-copy" }, async (state) => {
      const sessionId = "copy";
      const sourceOptions = { agentId: "main", env: state.env };
      const path = state.statePath("destination.sqlite");
      const destinationOptions =
        encoding === "self" ? sourceOptions : { agentId: "destination", env: state.env, path };
      if (encoding === "UTF-16le") {
        using seed = new DatabaseSync(path);
        seed.exec("PRAGMA encoding = 'UTF-16le'; CREATE TABLE seed (id INTEGER); DROP TABLE seed;");
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
      const events = [
        { type: "session", version: 3, id: sessionId },
        messageEvent("message", null, { role: "user", content: "kept" }),
      ];
      for (const options of new Set([sourceOptions, destinationOptions])) {
        const scope = { ...options, sessionId, sessionKey: `agent:${options.agentId}:copy` };
        write((database) => appendTranscriptEventsInTransaction(database, scope, events), options);
      }
      write((database) => {
        const payload = prepareTrajectoryPayload(database.db, compressedJson);
        expect(payload.event_codec).not.toBeNull();
        const metadata = { session_id: sessionId, run_id: "run" };
        executeSqliteQuerySync(
          database.db,
          getSessionKysely(database.db)
            .insertInto("trajectory_runtime_events")
            .values([
              {
                ...metadata,
                seq: 0,
                created_at: 1,
                event_json: legacyJson,
                event_payload: null,
                event_codec: null,
                event_utf8_bytes: null,
              },
              { ...metadata, seq: 1, created_at: 2, ...payload },
            ]),
        );
      }, sourceOptions);
      const snapshot = () => ({
        events: source.db.prepare("SELECT * FROM transcript_events ORDER BY seq").all(),
        identities: source.db
          .prepare("SELECT * FROM transcript_event_identities ORDER BY event_id")
          .all(),
        trajectory: readRows(source),
      });
      const before = snapshot();
      expect(before.events).toHaveLength(2);
      write(
        (target) => copyRows({ destination: target, source, sessionId, sourceWindowPresent: true }),
        destinationOptions,
      );
      const copied = readRows(destination);
      expect(snapshot()).toEqual(before);
      expect(copied.map(readTrajectoryPayload)).toEqual([legacyJson, compressedJson]);
      if (encoding !== "UTF-16le") {
        expect(copied).toEqual(before.trajectory);
      } else {
        expect(
          copied.map((row) => [row.event_codec, row.event_payload, row.event_utf8_bytes]),
        ).toEqual([
          [null, null, null],
          [null, null, null],
        ]);
      }
      const fingerprint = (database: typeof source) => {
        const [window] = readWindows(database, [], [sessionId]);
        assert(window, "Fixture session window is missing");
        return readComparison(database, window).contentFingerprint;
      };
      expect(fingerprint(destination)).toBe(fingerprint(source));
    }),
);
