import { expect, it } from "vitest";
import { readSessionActorBoundedHistory } from "./session-actor-bounded-history.js";
import type { SessionActorHotState } from "./session-actor-state.types.js";

const timestamp = "2026-10-12T00:00:00.000Z";
const message = (id: string, parentId: string | null, content = id) => ({
  type: "message",
  id,
  parentId,
  timestamp,
  message: { role: "user", content },
});

it.each(["compaction", "reset"] as const)(
  "hydrates the complete current window after %s without copying obsolete history",
  (type) => {
    const summary = "Previous work. ".repeat(100_000);
    const archived = Array.from({ length: 32 }, (_, index) =>
      message(`old-${index}`, index === 0 ? null : `old-${index - 1}`, "obsolete ".repeat(1000)),
    );
    const header = { type: "session", id: "session", version: 3 };
    const retained = message("retained", "old-31");
    const note = {
      type: "custom_message",
      id: "retained-note",
      parentId: "retained",
      customType: "note",
      content: "Keep this earlier note when updating the summary.",
      display: true,
      timestamp,
    };
    const branch = {
      type: "branch_summary",
      id: "retained-branch",
      parentId: "retained-note",
      fromId: "old-0",
      summary: "Earlier branch work.",
      timestamp,
    };
    const boundary = {
      type,
      id: "boundary",
      parentId: "retained-branch",
      firstKeptEntryId: "retained",
      timestamp,
      ...(type === "compaction" ? { summary, tokensBefore: 100_000 } : { reason: "reset" }),
    };
    const current = message("current", "boundary");
    const events = [header, ...archived, retained, note, branch, boundary, current];
    const lastSeq = events.length - 1;
    const hot: SessionActorHotState = {
      target: {
        database: { kind: "memory", handle: "test", incarnation: "test" },
        sessionKey: "k",
      },
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
        watermark: { generation: "generation", maxSeq: lastSeq },
        version: { generation: "generation", rawSeq: lastSeq, updatedAt: 1 },
        anchorsState: "resident",
        anchors: [],
        idempotency: [],
        modelContext: { kind: "unavailable", reason: "projection", generation: "generation" },
      },
    };
    const { snapshot } = readSessionActorBoundedHistory(
      {
        hot,
        events: events.map((event, rawSeq) => ({
          rawSeq,
          event,
          serializedBytes: Buffer.byteLength(JSON.stringify(event)) + 1,
        })),
      },
      { compaction: true },
    );

    expect(snapshot.events).toEqual([
      header,
      retained,
      ...(type === "compaction" ? [note, branch] : []),
      boundary,
      current,
    ]);
    expect(snapshot.truncated).toBe(false);
    expect(snapshot.activeLeafEntryId).toBe("current");
    expect(snapshot.firstKeptRanges.get("boundary")).toEqual({
      startIndex: 1,
      endIndex: type === "compaction" ? 4 : 2,
    });
    if (type === "reset") {
      expect(snapshot.opaqueParents.get("retained-branch")).toBe("retained");
    }
  },
);
