import { assert, expect, it } from "vitest";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  assertSqliteTranscriptDigestUnchanged,
  readTranscriptEventRows,
  readTranscriptEventRowsDigest,
} from "./session-accessor.sqlite-read.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import { replaceTranscriptEventsSync } from "./session-accessor.sqlite-transcript-write.test-support.js";
import { createSessionCompoundWorkerFixture } from "./session-compound-worker.test-support.js";
import { SqliteTranscriptMutationConflictError } from "./session-mutation-conflict-error.js";
import { createManualCompactRecords } from "./transcript-message.test-support.js";

it("rejects a same-sequence byte rewrite after streaming snapshot preparation", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = createSessionCompoundWorkerFixture();
    replaceTranscriptEventsSync(f.scope, createManualCompactRecords(f.scope.sessionId));
    const snapshot = readTranscriptEventRowsDigest(f.database, f.scope.sessionId);
    const [header] = readTranscriptEventRows(f.database, f.scope.sessionId);
    assert(header);
    runOpenClawAgentWriteTransaction(
      (database) =>
        executeSqliteQuerySync(
          database.db,
          getSessionKysely(database.db)
            .updateTable("transcript_events")
            .set({ event_json: header.eventJson + " ", event_zstd: null, event_utf8_bytes: null })
            .where("session_id", "=", f.scope.sessionId)
            .where("seq", "=", header.seq),
        ),
      { agentId: f.scope.agentId, path: f.database.path },
    );
    expect(readTranscriptEventRowsDigest(f.database, f.scope.sessionId).count).toBe(snapshot.count);
    expect(() =>
      assertSqliteTranscriptDigestUnchanged(f.database, f.scope.sessionId, snapshot),
    ).toThrow(SqliteTranscriptMutationConflictError);
  }));
