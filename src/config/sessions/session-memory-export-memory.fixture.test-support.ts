import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { buildSessionEntry } from "../../../packages/memory-host-sdk/src/host/session-files.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createSessionCompoundWorkerFixture } from "./session-compound-worker.test-support.js";
import { createTranscriptEventInserter } from "./transcript-payload.js";
await withOpenClawTestState({ scenario: "minimal" }, async () => {
  const f = createSessionCompoundWorkerFixture();
  const count = 12460;
  const payload = "bounded export ".repeat(1024);
  runOpenClawAgentWriteTransaction(
    (database) => {
      const insert = createTranscriptEventInserter(database.db, f.scope.sessionId);
      insert({
        seq: 1,
        createdAt: 1,
        eventJson: JSON.stringify({ type: "session", version: 3, id: f.scope.sessionId }),
      });
      for (let i = 0; i < count; i++) {
        insert({
          seq: i + 2,
          createdAt: i + 2,
          eventJson: JSON.stringify({
            type: "message",
            id: "m-" + i,
            parentId: i ? "m-" + (i - 1) : null,
            message: { role: "user", content: payload, timestamp: i },
          }),
        });
      }
    },
    { agentId: f.scope.agentId, path: f.database.path },
  );
  assert(process.argv[2]);
  writeFileSync(process.argv[2], "seeded");
  let first: string | undefined;
  for (let i = 0; i < 2; i++) {
    const entry = await buildSessionEntry("synthetic.jsonl", f.scope);
    assert(entry);
    assert(entry.lineMap.length > count);
    const digest = createHash("sha256").update(entry.content).digest("hex");
    if (first) {
      assert.equal(digest, first);
    }
    first = digest;
    console.log(
      JSON.stringify({ run: i, chars: entry.content.length, lines: entry.lineMap.length, digest }),
    );
  }
});

process.stdout.write("memory export bounded-memory regression passed\n");
