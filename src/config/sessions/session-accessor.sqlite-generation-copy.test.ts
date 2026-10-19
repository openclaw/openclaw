import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  prepareTrajectoryPayload,
  readTrajectoryPayload,
} from "../../trajectory/runtime-payload.js";
import {
  copySqliteSessionGenerationRows,
  readSqliteSessionGenerationComparison,
  readSqliteSessionGenerationWindows,
} from "./session-accessor.sqlite-generation-copy.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import { appendTranscriptEventsInTransaction } from "./session-accessor.sqlite-transcript-store.js";

it("treats a streaming copy onto its source as a no-op without deleting any rows", async () => {
  await withOpenClawTestState({ label: "generation-self-copy" }, async (state) => {
    const scope = {
      agentId: "main",
      env: state.env,
      sessionKey: "agent:main:copy",
      sessionId: "copy",
    };
    runOpenClawAgentWriteTransaction(
      (database) => {
        appendTranscriptEventsInTransaction(database, scope, [
          { type: "session", version: 3, id: scope.sessionId },
          {
            type: "message",
            id: "message",
            parentId: null,
            message: { role: "user", content: "Preserve these exact bytes." },
          },
        ]);
        const snapshot = () => ({
          events: database.db.prepare("SELECT * FROM transcript_events ORDER BY seq").all(),
          identities: database.db
            .prepare("SELECT * FROM transcript_event_identities ORDER BY event_id")
            .all(),
        });
        const before = snapshot();
        expect(before.events).toHaveLength(2);
        expect(() =>
          copySqliteSessionGenerationRows({
            destination: database,
            source: database,
            sessionId: scope.sessionId,
            sourceWindowPresent: true,
          }),
        ).not.toThrow();
        expect(snapshot()).toEqual(before);
      },
      { agentId: scope.agentId, env: scope.env },
    );
  });
});

it.each(["UTF-8", "UTF-16le"])(
  "preserves mixed trajectory bytes and logical fingerprints when copying to %s",
  async (encoding) => {
    await withOpenClawTestState({ label: "generation-trajectory-copy" }, async (state) => {
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
      const compressedJson = JSON.stringify({
        type: "model.completed",
        data: { messagesSnapshot: [{ role: "user", content: "retained 🦞 bytes ".repeat(256) }] },
      });
      const rowQuery = (database: typeof source) =>
        getSessionKysely(database.db)
          .selectFrom("trajectory_runtime_events")
          .selectAll()
          .where("session_id", "=", sessionId)
          .orderBy("seq");
      for (const options of [sourceOptions, destinationOptions]) {
        runOpenClawAgentWriteTransaction((database) => {
          appendTranscriptEventsInTransaction(
            database,
            { ...options, sessionId, sessionKey: `agent:${options.agentId}:trajectory-copy` },
            [{ type: "session", version: 3, id: sessionId }],
          );
        }, options);
      }
      runOpenClawAgentWriteTransaction((database) => {
        const payload = prepareTrajectoryPayload(database.db, compressedJson);
        expect(payload.event_codec).not.toBeNull();
        database.db
          .prepare(
            "INSERT INTO trajectory_runtime_events(session_id,seq,run_id,event_json,created_at) VALUES(?,0,'run',?,1)",
          )
          .run(sessionId, legacyJson);
        executeSqliteQuerySync(
          database.db,
          getSessionKysely(database.db)
            .insertInto("trajectory_runtime_events")
            .values({
              session_id: sessionId,
              seq: 1,
              run_id: "run",
              created_at: 2,
              ...payload,
            }),
        );
      }, sourceOptions);
      const before = executeSqliteQuerySync(source.db, rowQuery(source)).rows;
      runOpenClawAgentWriteTransaction((database) => {
        copySqliteSessionGenerationRows({
          destination: database,
          sessionId,
          source,
          sourceWindowPresent: true,
        });
      }, destinationOptions);
      const copied = executeSqliteQuerySync(destination.db, rowQuery(destination)).rows;
      expect(copied.map(readTrajectoryPayload)).toEqual([legacyJson, compressedJson]);
      expect(executeSqliteQuerySync(source.db, rowQuery(source)).rows).toEqual(before);
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
        const [window] = readSqliteSessionGenerationWindows(database, [], [sessionId]);
        if (!window) {
          throw new Error("Fixture session window is missing");
        }
        return readSqliteSessionGenerationComparison(database, window).contentFingerprint;
      };
      expect(comparison(destination)).toBe(comparison(source));
    });
  },
);
