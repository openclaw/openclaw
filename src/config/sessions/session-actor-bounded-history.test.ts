import { expect, it } from "vitest";
import {
  readSessionActorBoundedHistory,
  type SessionActorTranscriptRow,
} from "./session-actor-bounded-history.js";
import type { SessionActorHotState } from "./session-actor-state.types.js";

const timestamp = "2026-10-12T00:00:00.000Z";

function message(id: string, parentId: string | null, role: "user" | "assistant") {
  return { type: "message", id, parentId, timestamp, message: { role, content: id } };
}

function row(rawSeq: number, event: unknown, serializedBytes: number): SessionActorTranscriptRow {
  return { rawSeq, event, serializedBytes };
}

const rows = [
  row(0, { type: "session", id: "session", version: 3 }, 100),
  row(1, message("old", null, "user"), 200),
  row(
    2,
    {
      type: "compaction",
      id: "summary",
      parentId: "old",
      firstKeptEntryId: "old",
      summary: "earlier work",
      timestamp,
      tokensBefore: 100,
    },
    150,
  ),
  row(3, message("middle", "summary", "user"), 200),
  row(4, message("new", "middle", "assistant"), 300),
];

const hot: SessionActorHotState = {
  target: { database: { kind: "memory", handle: "test", incarnation: "test" }, sessionKey: "k" },
  version: { epoch: "epoch", sequence: 1 },
  writeToken: "committed",
  dependencySessionIds: ["session"],
  entry: { sessionId: "session", updatedAt: 1 },
  hasBoard: false,
  participants: [],
  members: [],
  pendingInputs: [],
  completionKeys: [],
  transcript: {
    watermark: { generation: "generation", maxSeq: 4 },
    version: { generation: "generation", rawSeq: 4, updatedAt: 1 },
    anchorsState: "resident",
    anchors: [],
    idempotency: [],
    modelContext: { kind: "resident", entries: [] },
  },
};

it("gives the latest boundary the tail's oldest bytes when the tail alone fills the cap", () => {
  // Header, "middle" and "new" fill the cap exactly; the summary only fits once "middle" goes.
  const { snapshot } = readSessionActorBoundedHistory(
    { hot, events: rows },
    {
      maxBytes: 600,
      maxEvents: 10,
    },
  );

  expect(snapshot.events.map((event) => (event as { id: string }).id)).toEqual([
    "session",
    "summary",
    "new",
  ]);
  expect(snapshot.truncated).toBe(true);
  expect(snapshot.serializedBytes).toBe(550);
  expect(snapshot.opaqueParents.get("middle")).toBe("summary");
});
