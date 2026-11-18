import { expect, it } from "vitest";
import {
  parseWorkerProcessMessage,
  parseWorkerProcessRequest,
  parseWorkerRuntimeResult,
} from "./worker-process-protocol.js";

type Fields = Record<string, unknown>;
function inheritedRecord(prototype: Fields, ownFields: Fields): Fields {
  return Object.assign(Object.create(prototype) as Fields, ownFields);
}

function expectRejectedMessages(...frames: unknown[]) {
  for (const frame of frames) {
    expect(parseWorkerProcessMessage(frame)).toBeNull();
  }
}

it.each([
  { status: "completed", transcriptLeafId: null, transcriptNextSeq: 1 },
  { status: "failed", reason: "turn-failed", transcriptLeafId: "leaf", transcriptNextSeq: 2 },
  { status: "failed", reason: "node-lost", transcriptLeafId: "leaf", transcriptNextSeq: 2 },
  { status: "fenced", reason: "credential-replaced" },
  { status: "not-started", reason: "admission-deadline", errorText: "admission timed out" },
])("only retains workers after started $status results", (result) => {
  expect(parseWorkerRuntimeResult(result)).toStrictEqual(result);
  const canRetain = result.status === "completed" || result.reason === "turn-failed";
  for (const options of [{}, { retention: "background" }, { retention: "idle" }]) {
    for (const retainWorker of [false, true]) {
      const frame = { type: "result", turnId: "turn-1", result, retainWorker, ...options };
      const valid = retainWorker ? canRetain : !("retention" in options);
      expect(parseWorkerProcessMessage(frame)).toStrictEqual(valid ? frame : null);
    }
  }
});

it("accepts only exact idle readiness for a bounded turn identity", () => {
  const ready = { type: "idle-ready", turnId: "turn-1" };
  expect(parseWorkerProcessMessage(ready)).toEqual(ready);
  expectRejectedMessages(
    { ...ready, retainWorker: true },
    { ...ready, turnId: "" },
    inheritedRecord({ type: "idle-ready" }, { turnId: "turn-1" }),
  );
});

it("rejects request discriminators inherited alongside the wrong own keys", () => {
  const request = inheritedRecord({ type: "cancel" }, { turnId: "turn-1", unexpected: true });

  expect(() => parseWorkerProcessRequest(request)).toThrow("invalid managed worker request");
});

it("rejects an inherited discriminator for a fenced result", () => {
  const result = inheritedRecord(
    { status: "fenced" },
    { reason: "credential-replaced", unexpected: true },
  );
  expect(parseWorkerRuntimeResult(result)).toBeNull();
});

it("accepts bounded process observation frames and rejects mixed owner operations", () => {
  const request = {
    type: "process",
    requestId: "read-1",
    environmentId: "environment-1",
    sessionId: "session-1",
    ownerEpoch: 1,
    operation: { action: "list" },
  };
  expect(parseWorkerProcessRequest(request)).toEqual(request);
  for (const invalid of [
    { ...request, turnId: "another-turn" },
    { ...request, operation: { action: "stop", processId: "build" } },
    inheritedRecord(
      { environmentId: request.environmentId },
      { ...request, environmentId: undefined },
    ),
  ]) {
    expect(() => parseWorkerProcessRequest(invalid)).toThrow();
  }
  const response = {
    type: "process-result",
    requestId: "read-1",
    result: { sessionId: "session-1", processes: [], truncated: false },
  };
  expect(parseWorkerProcessMessage(response)).toEqual(response);
  expectRejectedMessages(
    { ...response, error: "mixed result" },
    { type: "process-result", requestId: "read-1", error: "x".repeat(513) },
  );
});
