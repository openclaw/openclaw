import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it } from "vitest";
import type { UserTurnTranscriptAdmissionReceipt } from "../../sessions/user-turn-transcript.types.js";
import type { SessionActorTranscriptRow } from "./session-actor-bounded-history.js";
import { createSessionActorCommittedOutcome } from "./session-actor-receipt.js";
import type { SessionActorHotState } from "./session-actor-state.types.js";
import {
  advanceSessionActorTranscriptReplica,
  readSessionActorTranscriptContext,
  rewriteSessionActorTranscriptReplica,
  seedSessionActorTranscriptContext,
} from "./session-actor-transcript-replica.js";
import type { PreparedSessionTranscriptHydration } from "./session-history-read.types.js";

type Bounded = Extract<PreparedSessionTranscriptHydration, { kind: "bounded" }>;
const limits = { maxBytes: 4096, maxEvents: 8 };
const sessionKey = "agent:main:test";
const message = (id: string, parentId: string | null, role: string) => ({
  type: "message",
  id,
  parentId,
  timestamp: "2026-10-12T00:00:00.000Z",
  message: { role, content: [{ type: "text", text: id }] },
});

function fixture() {
  const rows: SessionActorTranscriptRow[] = [
    { rawSeq: 0, event: { type: "session", id: "session", version: 3 }, serializedBytes: 100 },
    { rawSeq: 1, event: message("user", null, "user"), serializedBytes: 200 },
    { rawSeq: 2, event: message("reply", "user", "assistant"), serializedBytes: 300 },
  ];
  const hot: SessionActorHotState = {
    target: { database: { kind: "memory", handle: "test", incarnation: "test" }, sessionKey },
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
      watermark: { generation: "generation", maxSeq: 2 },
      version: { generation: "generation", rawSeq: 2, updatedAt: 1 },
      anchorsState: "resident",
      anchors: [],
      idempotency: [],
      modelContext: {
        kind: "resident",
        entries: [
          { rawSeq: 1, eventId: "user" },
          { rawSeq: 2, eventId: "reply" },
        ],
      },
    },
  };
  const prepared: Bounded = {
    kind: "bounded",
    residentRows: rows.map(({ rawSeq, serializedBytes }) => ({ rawSeq, serializedBytes })),
    snapshot: {
      version: { ...hot.transcript.version },
      activeLeafEntryId: "reply",
      opaqueParents: new Map(),
      parents: new Map([
        ["user", null],
        ["reply", "user"],
      ]),
      firstKeptRanges: new Map(),
      persistedSuffixStartSeq: 1,
      boundaryCount: 0,
      events: rows.map((row) => structuredClone(row.event)),
      cacheTtlProjectionPrefixes: [],
      serializedBytes: 600,
      totalEvents: 2,
      transcriptMutationAt: 1,
      truncated: false,
      completeActivePath: true,
    },
  };
  return { hot, rows, prepared };
}

function append(hot: SessionActorHotState, row: SessionActorTranscriptRow, payload = true) {
  const after = structuredClone(hot);
  after.version = { ...after.version, sequence: after.version.sequence + 1 };
  after.transcript.version.rawSeq = row.rawSeq;
  after.transcript.version.updatedAt = 2;
  after.transcript.watermark.maxSeq = row.rawSeq;
  if (after.transcript.modelContext.kind === "resident") {
    after.transcript.modelContext.entries.push({
      rawSeq: row.rawSeq,
      eventId: isRecord(row.event) && typeof row.event.id === "string" ? row.event.id : null,
    });
  }
  return createSessionActorCommittedOutcome({
    phase: "appendTranscriptEvent",
    command: { commandId: "append", phaseId: "append" },
    before: hot,
    after,
    payloads: payload ? new Map([[row.rawSeq, row]]) : undefined,
    applied: { value: {}, reducers: [] },
  });
}

describe("actor transcript context replica", () => {
  it("retains a cold bounded result only for its exact version and limits", () => {
    const { hot, prepared } = fixture();
    delete prepared.residentRows;
    prepared.snapshot.truncated = true;
    const retained = seedSessionActorTranscriptContext(undefined, hot, prepared, limits);
    const result = readSessionActorTranscriptContext(retained, hot, limits);
    expect(result).toEqual(prepared);
    result?.snapshot.events.splice(0);
    expect(readSessionActorTranscriptContext(retained, hot, limits)).toEqual(prepared);
    expect(
      readSessionActorTranscriptContext(retained, hot, { ...limits, maxEvents: 7 }),
    ).toBeUndefined();
    const changed = structuredClone(hot);
    changed.transcript.version.updatedAt = 99;
    expect(readSessionActorTranscriptContext(retained, changed, limits)).toBeUndefined();
  });

  it("retains only the bounded window when a worker read cannot seed a complete path", () => {
    const { hot, prepared } = fixture();
    prepared.snapshot.truncated = true;
    prepared.transcript = { anchors: [] };
    const expected = structuredClone(prepared.snapshot);
    const retained = seedSessionActorTranscriptContext(undefined, hot, prepared, limits);
    prepared.snapshot.events.length = 0;
    const read = readSessionActorTranscriptContext(retained, hot, limits);
    expect(read).toEqual({ kind: "bounded", snapshot: expected });
    read?.snapshot.events.splice(0);
    expect(readSessionActorTranscriptContext(retained, hot, limits)).toEqual({
      kind: "bounded",
      snapshot: expected,
    });
  });

  it("advances a complete linear path using the receipt's stored byte sizes", () => {
    const { hot, prepared } = fixture();
    const retained = seedSessionActorTranscriptContext(undefined, hot, prepared, limits);
    const outcome = append(hot, {
      rawSeq: 3,
      event: message("next-user", "reply", "user"),
      serializedBytes: 400,
    });
    const advanced = advanceSessionActorTranscriptReplica(retained, outcome);
    const result = readSessionActorTranscriptContext(advanced, outcome.receipt.postimage, limits);
    expect(result?.snapshot.events).toEqual([
      ...prepared.snapshot.events,
      message("next-user", "reply", "user"),
    ]);
    expect(result?.snapshot.serializedBytes).toBe(1000);
    expect(result?.snapshot.parents.get("next-user")).toBe("reply");
    expect(result?.snapshot.totalEvents).toBe(3);
    expect(result?.snapshot.activeLeafEntryId).toBe("next-user");
  });

  it("completes a fenced cold path from the receipt without replaying the current user", () => {
    const { hot, prepared } = fixture();
    const outcome = append(hot, {
      rawSeq: 3,
      event: message("next-user", "reply", "user"),
      serializedBytes: 400,
    });
    const current = outcome.receipt.postimage;
    const admission: UserTurnTranscriptAdmissionReceipt = {
      agentId: "main",
      sessionId: "session",
      sessionKey,
      storePath: "/test/agent.db",
      generation: "generation",
      entryId: "next-user",
      rawSeq: 3,
      effectiveParentId: "reply",
      activeMessagePosition: 2,
      logicalTurnId: "turn",
      role: "user",
    };
    prepared.snapshot.version = { ...current.transcript.version };
    prepared.snapshot.totalEvents = 3;
    prepared.snapshot.transcriptMutationAt = 2;
    delete prepared.snapshot.completeActivePath;
    const retained = seedSessionActorTranscriptContext(
      advanceSessionActorTranscriptReplica(undefined, outcome),
      current,
      prepared,
      limits,
      admission,
    );
    const fenced = readSessionActorTranscriptContext(retained, current, limits, admission);
    expect(fenced?.snapshot.events).toEqual(prepared.snapshot.events);
    expect(fenced?.snapshot.serializedBytes).toBe(600);
    expect(fenced?.snapshot.totalEvents).toBe(3);
    expect(fenced?.snapshot.activeLeafEntryId).toBe("reply");
    expect(fenced?.snapshot.completeActivePath).toBeUndefined();
    expect(
      readSessionActorTranscriptContext(retained, current, limits)?.snapshot.events,
    ).toHaveLength(4);
  });

  it("keeps rewritten metadata within the retained context and tail byte limits", () => {
    const { hot, prepared } = fixture();
    const event = message("next-user", "reply", "user");
    const appended = append(hot, { rawSeq: 3, event, serializedBytes: 400 });
    const retained = advanceSessionActorTranscriptReplica(
      seedSessionActorTranscriptContext(undefined, hot, prepared, limits),
      appended,
    );
    const rewritten = {
      ...event,
      message: { ...event.message, __openclaw: { steerTargetRunId: "x".repeat(512 * 1024) } },
    };
    const postimage = structuredClone(appended.receipt.postimage);
    postimage.transcript.version.updatedAt = 3;
    const next = rewriteSessionActorTranscriptReplica(retained, {
      before: appended.receipt.postimage.transcript.version,
      postimage,
      rows: [
        {
          rawSeq: 3,
          event: rewritten,
          serializedBytes: Buffer.byteLength(JSON.stringify(rewritten), "utf8") + 1,
        },
      ],
    });
    expect(readSessionActorTranscriptContext(next, postimage, limits)).toBeUndefined();
    expect(next?.tail).toEqual({ events: [], coveredAfterSeq: 3 });
  });

  it("detaches the retained path from seed input and returned payload mutations", () => {
    const { hot, prepared } = fixture();
    const retained = seedSessionActorTranscriptContext(undefined, hot, prepared, limits);
    const first = prepared.snapshot.events[1];
    if (!isRecord(first)) {
      throw new Error("Expected a message fixture");
    }
    first.id = "mutated-input";
    const read = readSessionActorTranscriptContext(retained, hot, limits);
    expect(read?.snapshot.events[1]).toEqual(message("user", null, "user"));
    const returned = read?.snapshot.events[1];
    if (!isRecord(returned)) {
      throw new Error("Expected a retained message");
    }
    returned.id = "mutated-output";
    expect(readSessionActorTranscriptContext(retained, hot, limits)?.snapshot.events[1]).toEqual(
      message("user", null, "user"),
    );
  });

  it.each([
    "missing receipt",
    "control",
    "compaction",
    "branch summary",
    "unsupported",
    "excluded",
    "side append",
    "bytes",
    "count",
    "headerless count",
  ] as const)("falls back to the history reader after %s invalidates a complete path", (reason) => {
    const { hot, prepared } = fixture();
    if (reason === "headerless count") {
      prepared.snapshot.events.shift();
      prepared.residentRows?.shift();
      prepared.snapshot.serializedBytes = 500;
    }
    const selectedLimits = {
      maxBytes: reason === "bytes" ? 650 : limits.maxBytes,
      maxEvents: reason === "count" || reason === "headerless count" ? 2 : limits.maxEvents,
    };
    const retained = seedSessionActorTranscriptContext(undefined, hot, prepared, selectedLimits);
    const outcome = append(
      hot,
      {
        rawSeq: 3,
        event:
          reason === "control"
            ? { type: "reset", id: "reset", parentId: "reply" }
            : {
                ...message("next-user", "reply", "user"),
                ...(reason === "compaction" ? { type: "compaction" } : {}),
                ...(reason === "branch summary" ? { type: "branch_summary" } : {}),
                ...(reason === "unsupported" ? { type: "plugin_control" } : {}),
                ...(reason === "side append" ? { appendMode: "side" } : {}),
                ...(reason === "excluded"
                  ? { message: { role: "user", content: "Hidden", excludeFromContext: true } }
                  : {}),
              },
        serializedBytes: 400,
      },
      reason !== "missing receipt",
    );
    const advanced = advanceSessionActorTranscriptReplica(retained, outcome);
    expect(
      readSessionActorTranscriptContext(advanced, outcome.receipt.postimage, selectedLimits),
    ).toBeUndefined();
  });
});
