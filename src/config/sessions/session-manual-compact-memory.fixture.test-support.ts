import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { readTranscriptEventRows } from "./session-accessor.sqlite-read.js";
import { trimSessionTranscriptForManualCompact } from "./session-accessor.transcript.js";
import { createSessionCompoundWorkerFixture } from "./session-compound-worker.test-support.js";
import { createTranscriptEventInserter } from "./transcript-payload.js";

const seeded = process.argv[2];
assert(seeded, "expected a fixture-ready marker path");

// The accessor uses the real broker and its production 512 MiB worker cap.
// Compressible rows keep disk use tiny while decoding to 256 MiB of user data.
await withOpenClawTestState({ scenario: "minimal" }, async () => {
  const f = createSessionCompoundWorkerFixture();
  const payload = "x".repeat(512 * 1024);
  const count = 512;
  runOpenClawAgentWriteTransaction(
    (database) => {
      const insert = createTranscriptEventInserter(database.db, f.scope.sessionId);
      insert({
        seq: 1,
        createdAt: 1,
        eventJson: JSON.stringify({ type: "session", version: 3, id: f.scope.sessionId }),
      });
      for (let index = 0; index < count; index++) {
        insert({
          seq: index + 2,
          createdAt: index + 2,
          eventJson: JSON.stringify({
            type: "message",
            id: `message-${index}`,
            parentId: index ? `message-${index - 1}` : null,
            message: { role: "user", content: payload, timestamp: index },
          }),
        });
      }
    },
    { agentId: f.scope.agentId, path: f.database.path },
  );
  writeFileSync(seeded, "seeded");
  const result = await trimSessionTranscriptForManualCompact(f.scope, { maxLines: 3, nowMs: 500 });
  assert.equal(result.compacted, true);
  const rows = readTranscriptEventRows(f.database, f.scope.sessionId);
  assert.equal(rows.length, 3);
  const [headerRow, olderRow, latestRow] = rows;
  assert(headerRow && olderRow && latestRow);
  const header = JSON.parse(headerRow.eventJson);
  const older = JSON.parse(olderRow.eventJson);
  const latest = JSON.parse(latestRow.eventJson);
  assert.equal(header.type, "session");
  assert.equal(header.id, f.scope.sessionId);
  assert.equal(older.id, "message-510");
  assert.equal(older.parentId, null);
  assert.equal(older.message.content, payload);
  assert.equal(latest.id, "message-511");
  assert.equal(latest.parentId, "message-510");
  assert.equal(latest.message.content, payload);
  assert.equal(f.read()?.sessionId, f.scope.sessionId);
  assert.equal(f.read()?.label, "initial");
  process.stdout.write("manual compact bounded-memory regression passed\n");
});
