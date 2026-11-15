import assert from "node:assert/strict";
import { collectForRetentionCheck } from "../../test-utils/retention.js";
import type { TranscriptContextSnapshot } from "./session-accessor.sqlite-model-context.js";
import { createSessionCompactionEntrySource } from "./session-compaction-entry-source.js";

const entries: TranscriptContextSnapshot["entries"] = Array.from({ length: 32 }, (_, index) => ({
  type: "message",
  id: String(index),
  parentId: index ? String(index - 1) : null,
  timestamp: "2026-01-01T00:00:00.000Z",
  seq: index + 1,
  message: {
    role: "toolResult",
    toolCallId: String(index),
    toolName: "read",
    content: [],
    isError: true,
    timestamp: index,
  },
}));
const snapshot: TranscriptContextSnapshot = {
  header: {
    type: "session",
    version: 3,
    id: "retention",
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd: "/synthetic",
  },
  entries,
  version: { generation: "retention", rawSeq: 32, updatedAt: 1 },
  readEntry(entry) {
    // Fresh, flat strings model individually decoded SQLite payload rows.
    const payload = Buffer.alloc(1024 * 1024, "x");
    payload.write("failure-" + entry.id);
    const text = payload.toString();
    return {
      ...entry,
      message: {
        role: "toolResult",
        toolCallId: entry.id,
        toolName: "read",
        content: [{ type: "text", text }],
        isError: true,
        timestamp: entry.seq,
      },
    };
  },
  readModelEntrySizes: () => new Map(),
  readModelEntries: () => new Map(),
};
await collectForRetentionCheck("compaction-facts-baseline");
const baseline = process.memoryUsage().heapUsed;
const prepared = createSessionCompactionEntrySource(snapshot);
for (const entry of entries) {
  assert.equal(prepared.getFacts(entry.id)?.safeguard.failure?.summary.length, 240);
}
await collectForRetentionCheck("compaction-facts-cached");
const retained = process.memoryUsage().heapUsed - baseline;
assert.ok(
  retained < 8 * 1024 * 1024,
  "Cached bounded facts retained " + retained + " bytes of full tool payloads",
);
assert.equal(prepared.getFacts("0")?.safeguard.failure?.summary.length, 240);
process.stdout.write(JSON.stringify({ retained, facts: entries.length }));
