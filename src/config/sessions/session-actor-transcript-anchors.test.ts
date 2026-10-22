import { expect, it } from "vitest";
import { createMemoryTestState } from "./session-actor-memory-publication.test-support.js";
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
  const { hot } = createMemoryTestState(sessionKey, {
    sessionId: scope.sessionId,
    updatedAt: 1,
    lifecycleRevision: "lifecycle",
    activeWriterRunId: "run",
  });
  hot.transcript = {
    ...hot.transcript,
    watermark: { generation: "generation", maxSeq: 4 },
    version: { generation: "generation", rawSeq: 4, updatedAt: 1 },
    anchors: [user, reply],
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
  const read = (
    selection: Parameters<typeof readSessionActorTranscriptAnchors>[2],
    state = hot,
    suffix: Parameters<typeof readSessionActorTranscriptAnchors>[3] | null = tail,
  ) => readSessionActorTranscriptAnchors(state, scope, selection, suffix ?? undefined);
  return { hot, user, reply, tail, message, read };
}

it("returns the committed reply and user anchors from a complete suffix", () => {
  const { user, reply, message, read } = fixture();
  expect(
    read({
      entryIds: ["user"],
      afterSeq: 2,
      includeMessagesForRunId: "run",
      includeMessagePresence: true,
      includeWatermark: true,
    }),
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
  const { hot, user, read } = fixture();
  expect(
    read({
      entryIds: ["user", "reply"],
      includeMessagePresence: true,
      contextValidation: { version: hot.transcript.version },
      replayValidation: {
        allowInitial: false,
        expectedLifecycleRevision: "lifecycle",
        expectedWriterRunId: "run",
        admission: { ...user, logicalTurnId: "turn", role: "user" },
      },
    }),
  ).toEqual({
    anchors: [],
    contextValidated: true,
    replayValidated: "current",
    messagePresence: true,
  });
});

it("refuses replay when the writer or selected session has changed", () => {
  const { hot, read } = fixture();
  for (const current of [
    { ...hot.entry!, activeWriterRunId: "replacement-run" },
    { ...hot.entry!, sessionId: "replacement-session" },
  ]) {
    expect(() =>
      read(
        {
          entryIds: [],
          replayValidation: { allowInitial: false, expectedWriterRunId: "run" },
        },
        { ...hot, entry: current },
        null,
      ),
    ).toThrow(SessionTranscriptWriterClaimReboundError);
  }
});

it("rejects a rewritten completed-turn anchor and changed exact replay context", () => {
  const { hot, user, read } = fixture();
  for (const selection of [
    { contextValidation: { through: { ...user, generation: "old-generation" } } },
    {
      replayValidation: { allowInitial: false },
      contextValidation: { version: { generation: "generation", rawSeq: 3, updatedAt: 1 } },
    },
  ]) {
    expect(() => read({ entryIds: [], ...selection }, hot, null)).toThrow(
      SessionTranscriptReadFenceError,
    );
  }
});

it("leaves incomplete suffixes, reset visibility, and invalidated anchors to the reader", () => {
  const { hot, tail, read } = fixture();
  const selection = { entryIds: [], afterSeq: 2, includeMessagesForRunId: "run" };
  expect(read(selection, hot, { ...tail, coveredAfterSeq: 3 })).toBeUndefined();
  expect(
    read(
      selection,
      {
        ...hot,
        transcript: {
          ...hot.transcript,
          watermark: { generation: "generation", maxSeq: 5 },
          version: { generation: "generation", rawSeq: 5, updatedAt: 2 },
        },
      },
      {
        ...tail,
        events: [...tail.events, { rawSeq: 5, event: { type: "reset" } }],
      },
    ),
  ).toBeUndefined();
  expect(
    read(selection, { ...hot, transcript: { ...hot.transcript, anchorsState: "unavailable" } }),
  ).toBeUndefined();
});
