import { expect, it } from "vitest";
import { BACKGROUND_RESULT_PLACEMENT_CUSTOM_TYPE } from "../../../packages/agent-core/src/harness/session/background-result-placement.js";
import { readSessionActorBoundedHistory } from "./session-actor-bounded-history.js";
import type { SessionActorHotState } from "./session-actor-state.types.js";
import { timedMessageEvent } from "./transcript-message.test-support.js";

const timestamp = "2026-10-12T00:00:00.000Z";
const message = (id: string, parentId: string | null, content = id) =>
  timedMessageEvent(id, parentId, timestamp, { role: "user", content });

function hotState(lastSeq: number): SessionActorHotState {
  return {
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
}

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
    const hot = hotState(lastSeq);
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

it.each([false, true])(
  "reserves background payload bytes before the ordinary suffix (placed=%s)",
  (placed) => {
    const header = { type: "session", id: "session", version: 3 };
    const pending = {
      type: "message",
      id: "pending",
      parentId: null,
      timestamp,
      message: {
        role: "assistant",
        provider: "openclaw",
        model: "automation-result",
        content: [{ type: "text", text: "Background accepted" }],
        excludeFromContext: true,
        openclawModelPlacement: "pending",
      },
    };
    const older = message("older", "pending", "old".repeat(400));
    const middle = message("middle", "older", "middle".repeat(200));
    const newest = message("newest", "middle", "newest".repeat(200));
    const placement = {
      type: "custom",
      id: "placement",
      parentId: "newest",
      timestamp,
      customType: BACKGROUND_RESULT_PLACEMENT_CUSTOM_TYPE,
      data: { afterEntryId: "newest", resultEntryIds: ["pending"] },
    };
    const events = [header, pending, older, middle, newest, ...(placed ? [placement] : [])];
    const bytes = (event: unknown) => Buffer.byteLength(JSON.stringify(event)) + 1;
    const maxBytes =
      bytes(header) + bytes(middle) + bytes(newest) + (placed ? bytes(placement) : 0);
    const { snapshot } = readSessionActorBoundedHistory(
      {
        hot: hotState(events.length - 1),
        events: events.map((event, rawSeq) => ({ event, rawSeq, serializedBytes: bytes(event) })),
      },
      { maxEvents: 10, maxBytes },
    );
    expect(snapshot.events).toEqual([header, pending, newest, ...(placed ? [placement] : [])]);
    expect(snapshot.serializedBytes).toBeLessThanOrEqual(maxBytes);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.activeLeafEntryId).toBe(placed ? "placement" : "newest");
  },
);
