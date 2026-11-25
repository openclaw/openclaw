import { describe, expect, it } from "vitest";
import {
  snapshotTranscriptEntryAnchor,
  snapshotTranscriptTurnAdmission,
  type TranscriptTurnAdmission,
} from "./transcript-entry-anchor.js";

const admission = {
  agentId: "main",
  sessionId: "synthetic",
  sessionKey: "agent:main:synthetic",
  storePath: "/synthetic/store.sqlite",
  generation: "generation-1",
  entryId: "entry-1",
  rawSeq: 2,
  effectiveParentId: null,
  activeMessagePosition: 1,
  logicalTurnId: "turn-1",
  role: "user",
} satisfies TranscriptTurnAdmission;

describe("transcript identity snapshots", () => {
  it.each([
    { ...admission },
    { ...admission, idempotencyKey: undefined },
    { ...admission, idempotencyKey: "request-1" },
  ])("preserves scalar values and optional key presence", (input) => {
    const captured = snapshotTranscriptTurnAdmission(input);
    expect(captured).toStrictEqual(input);
    expect(captured).not.toBe(input);
    input.generation = "generation-2";
    input.rawSeq = 99;
    expect(captured.generation).toBe("generation-1");
    expect(captured.rawSeq).toBe(2);
  });

  it("projects an entry anchor independently of turn-only fields", () => {
    expect(snapshotTranscriptEntryAnchor(admission)).toStrictEqual({
      agentId: "main",
      sessionId: "synthetic",
      sessionKey: "agent:main:synthetic",
      storePath: "/synthetic/store.sqlite",
      generation: "generation-1",
      entryId: "entry-1",
      rawSeq: 2,
      effectiveParentId: null,
      activeMessagePosition: 1,
    });
  });
});
