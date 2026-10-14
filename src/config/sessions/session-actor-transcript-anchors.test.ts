import { describe, expect, it } from "vitest";
import type { SessionActorHotState } from "./session-actor-state.types.js";
import { readSessionActorTranscriptAnchors } from "./session-actor-transcript-anchors.js";
import { SessionTranscriptReadFenceError } from "./session-transcript-read-fence-error.js";
import { SessionTranscriptWriterClaimReboundError } from "./session-transcript-writer-claim-error.js";
import type { TranscriptEntryAnchor } from "./transcript-entry-anchor.js";

const scope = { agentId: "main", path: "/test/agent.db", sessionId: "session" };
const sessionKey = "agent:main:test";

function fixture() {
  const user: TranscriptEntryAnchor = {
    agentId: scope.agentId,
    sessionId: scope.sessionId,
    storePath: scope.path,
    sessionKey,
    generation: "generation",
    entryId: "user",
    rawSeq: 3,
    effectiveParentId: null,
    activeMessagePosition: 0,
  };
  const reply: TranscriptEntryAnchor = {
    ...user,
    entryId: "reply",
    rawSeq: 4,
    effectiveParentId: "user",
    activeMessagePosition: 1,
  };
  const hot: SessionActorHotState = {
    target: { database: { kind: "memory", handle: "test", incarnation: "test" }, sessionKey },
    version: { epoch: "epoch", sequence: 1 },
    writeToken: "committed",
    dependencySessionIds: [scope.sessionId],
    entry: {
      sessionId: scope.sessionId,
      updatedAt: 1,
      lifecycleRevision: "lifecycle",
      activeWriterRunId: "run",
    },
    hasBoard: false,
    participants: [],
    members: [],
    pendingInputs: [],
    completionKeys: [],
    transcript: {
      watermark: { generation: "generation", maxSeq: 4 },
      version: { generation: "generation", rawSeq: 4, updatedAt: 1 },
      anchorsState: "resident",
      anchors: [user, reply],
      idempotency: [],
      modelContext: {
        kind: "resident",
        entries: [
          { rawSeq: 3, eventId: "user" },
          { rawSeq: 4, eventId: "reply" },
        ],
      },
    },
  };
  const message = {
    role: "assistant",
    content: [{ type: "text", text: "The answer" }],
    __openclaw: { runId: "run" },
  };
  const tail = {
    coveredAfterSeq: 2,
    events: [
      { rawSeq: 3, event: { type: "message", id: "user", message: { role: "user" } } },
      { rawSeq: 4, event: { type: "message", id: "reply", message } },
    ],
  };
  return { hot, user, reply, tail, message };
}

describe("actor transcript anchor projection", () => {
  it("returns the committed reply and user anchors from a complete suffix", () => {
    const { hot, user, reply, tail, message } = fixture();
    expect(
      readSessionActorTranscriptAnchors(
        hot,
        scope,
        {
          entryIds: ["user"],
          afterSeq: 2,
          includeMessagesForRunId: "run",
          includeMessagePresence: true,
          includeWatermark: true,
        },
        tail,
      ),
    ).toEqual({
      anchors: [user, reply],
      messagePresence: true,
      watermark: { generation: "generation", maxSeq: 4 },
      tail: {
        lastSeq: 4,
        entries: [
          { entryId: "user", role: "user", anchor: user },
          { entryId: "reply", role: "assistant", runId: "run", anchor: reply, message },
        ],
      },
    });
  });

  it("uses admitted user bounds while validating the current writer and context", () => {
    const { hot, user, tail } = fixture();
    expect(
      readSessionActorTranscriptAnchors(
        hot,
        scope,
        {
          entryIds: ["user", "reply"],
          includeMessagePresence: true,
          contextValidation: { version: hot.transcript.version },
          replayValidation: {
            allowInitial: false,
            expectedLifecycleRevision: "lifecycle",
            expectedWriterRunId: "run",
            admission: { ...user, logicalTurnId: "turn", role: "user" },
          },
        },
        tail,
      ),
    ).toEqual({
      anchors: [],
      contextValidated: true,
      replayValidated: "current",
      messagePresence: true,
    });
  });

  it("refuses replay when the writer or selected session has changed", () => {
    const { hot } = fixture();
    for (const current of [
      { ...hot.entry!, activeWriterRunId: "replacement-run" },
      { ...hot.entry!, sessionId: "replacement-session" },
    ]) {
      expect(() =>
        readSessionActorTranscriptAnchors({ ...hot, entry: current }, scope, {
          entryIds: [],
          replayValidation: { allowInitial: false, expectedWriterRunId: "run" },
        }),
      ).toThrow(SessionTranscriptWriterClaimReboundError);
    }
  });

  it("rejects a rewritten completed-turn anchor and changed exact replay context", () => {
    const { hot, user } = fixture();
    expect(() =>
      readSessionActorTranscriptAnchors(hot, scope, {
        entryIds: [],
        contextValidation: { through: { ...user, generation: "old-generation" } },
      }),
    ).toThrow(SessionTranscriptReadFenceError);
    expect(() =>
      readSessionActorTranscriptAnchors(hot, scope, {
        entryIds: [],
        replayValidation: { allowInitial: false },
        contextValidation: { version: { generation: "generation", rawSeq: 3, updatedAt: 1 } },
      }),
    ).toThrow(SessionTranscriptReadFenceError);
  });

  it("leaves incomplete suffixes, reset visibility, and invalidated anchors to the reader", () => {
    const { hot, tail } = fixture();
    const selection = { entryIds: [], afterSeq: 2, includeMessagesForRunId: "run" };
    expect(
      readSessionActorTranscriptAnchors(hot, scope, selection, { ...tail, coveredAfterSeq: 3 }),
    ).toBeUndefined();
    expect(
      readSessionActorTranscriptAnchors(
        {
          ...hot,
          transcript: {
            ...hot.transcript,
            watermark: { generation: "generation", maxSeq: 5 },
            version: { generation: "generation", rawSeq: 5, updatedAt: 2 },
          },
        },
        scope,
        selection,
        {
          ...tail,
          events: [...tail.events, { rawSeq: 5, event: { type: "reset" } }],
        },
      ),
    ).toBeUndefined();
    expect(
      readSessionActorTranscriptAnchors(
        { ...hot, transcript: { ...hot.transcript, anchorsState: "unavailable" } },
        scope,
        selection,
        tail,
      ),
    ).toBeUndefined();
  });
});
