import { StatementSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { observeSqliteReadSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { listSessionEntriesCore } from "./session-accessor.entry.js";
import { upsertSessionEntryCore } from "./session-accessor.sqlite-entry.js";
import { recordSessionParticipant } from "./session-accessor.sqlite-participants.native.js";
import { persistSessionTranscriptTurn } from "./session-accessor.transcript-turn.js";

afterEach(() => closeOpenClawAgentDatabasesForTest());

it("reuses current participants across transcript appends and publishes new actors", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const scope = {
      agentId: "main",
      env: state.env,
      sessionKey: "agent:main:busy",
      sessionId: "busy",
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    recordSessionParticipant(scope, {
      identity: { type: "agent", id: "existing" },
      promptedAt: 1,
    });
    listSessionEntriesCore({ ...scope, projection: "list" });
    const database = openOpenClawAgentDatabase(scope);
    const reads = observeSqliteReadSql(StatementSync.prototype);
    const participantReads = () =>
      reads.queries.filter((sql) => sql.startsWith('select * from "session_participants"')).length;
    const append = (index: number) =>
      persistSessionTranscriptTurn(scope, {
        touchSessionEntry: true,
        updateMode: "none",
        messages: [
          {
            eventId: `message-${index}`,
            now: index + 2,
            message: { role: "assistant", content: `Message ${index}` },
          },
        ],
      });
    try {
      for (let index = 0; index < 100; index++) {
        const result = await append(index);
        expect(result).toMatchObject({
          appendedCount: 1,
          sessionEntry: {
            participants: [{ identity: { type: "agent", id: "existing" } }],
            participantCount: 1,
          },
        });
        // Returned rows cannot mutate the owner projection reused by the next append.
        const identity = result.sessionEntry?.participants?.[0]?.identity;
        if (identity) {
          identity.id = "caller-owned";
        }
      }
      expect(participantReads()).toBe(0);
      recordSessionParticipant(scope, {
        identity: { type: "agent", id: "new" },
        promptedAt: 2,
      });
      expect(await append(100)).toMatchObject({
        appendedCount: 1,
        sessionEntry: {
          participants: ["existing", "new"].map((id) => ({ identity: { type: "agent", id } })),
          participantCount: 2,
        },
      });
      expect(participantReads()).toBe(1);
      const rows = database.db
        .prepare(
          "SELECT event_json FROM transcript_events WHERE session_id = ? AND json_extract(event_json, '$.type') = 'message' ORDER BY seq",
        )
        .all(scope.sessionId);
      expect(rows).toHaveLength(101);
      for (const [index, row] of rows.entries()) {
        expect(JSON.parse(String(row.event_json))).toMatchObject({
          id: `message-${index}`,
          message: { role: "assistant", content: `Message ${index}` },
        });
      }
    } finally {
      reads.restore();
    }
  });
});
