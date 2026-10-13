import { describe, expect, it } from "vitest";
import {
  parseWorkerProcessMessage,
  parseWorkerProcessRequest,
  parseWorkerRuntimeResult,
} from "./worker-process-protocol.js";

function inheritedRecord(
  prototype: Record<string, unknown>,
  ownFields: Record<string, unknown>,
): Record<string, unknown> {
  return Object.assign(Object.create(prototype) as Record<string, unknown>, ownFields);
}

describe("worker process protocol", () => {
  it.each([
    { status: "completed", transcriptLeafId: null, transcriptNextSeq: 1 },
    { status: "failed", reason: "turn-failed", transcriptLeafId: "leaf", transcriptNextSeq: 2 },
    { status: "fenced", reason: "credential-replaced" },
    { status: "not-started", reason: "admission-deadline", errorText: "admission timed out" },
  ])("only retains workers after started $status results", (result) => {
    expect(parseWorkerRuntimeResult(result)).toStrictEqual(result);
    const frame = { type: "result", turnId: "turn-1", result, retainWorker: false };
    expect(parseWorkerProcessMessage(frame)).toStrictEqual(frame);
    const retained = { ...frame, retainWorker: true };
    expect(parseWorkerProcessMessage(retained)).toStrictEqual(
      result.status === "completed" || result.status === "failed" ? retained : null,
    );
    for (const retention of ["background", "idle"]) {
      const negotiated = { ...retained, retention };
      expect(parseWorkerProcessMessage(negotiated)).toStrictEqual(
        result.status === "completed" || result.status === "failed" ? negotiated : null,
      );
      expect(parseWorkerProcessMessage({ ...frame, retention })).toBeNull();
    }
  });

  it("accepts only exact idle readiness for a bounded turn identity", () => {
    const ready = { type: "idle-ready", turnId: "turn-1" };
    expect(parseWorkerProcessMessage(ready)).toEqual(ready);
    expect(parseWorkerProcessMessage({ ...ready, retainWorker: true })).toBeNull();
    expect(parseWorkerProcessMessage({ ...ready, turnId: "" })).toBeNull();
    expect(
      parseWorkerProcessMessage(inheritedRecord({ type: "idle-ready" }, { turnId: "turn-1" })),
    ).toBeNull();
  });

  it("rejects request discriminators inherited alongside the wrong own keys", () => {
    const request = inheritedRecord({ type: "cancel" }, { turnId: "turn-1", unexpected: true });

    expect(() => parseWorkerProcessRequest(request)).toThrow("invalid managed worker request");
  });

  it.each([
    {
      name: "fenced result",
      value: inheritedRecord(
        { status: "fenced" },
        { reason: "credential-replaced", unexpected: true },
      ),
    },
  ])("rejects an inherited discriminator for a $name", ({ value }) => {
    expect(parseWorkerRuntimeResult(value)).toBeNull();
  });
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
  expect(() => parseWorkerProcessRequest({ ...request, turnId: "another-turn" })).toThrow();
  expect(() =>
    parseWorkerProcessRequest({ ...request, operation: { action: "stop", processId: "build" } }),
  ).toThrow();
  expect(() =>
    parseWorkerProcessRequest(
      inheritedRecord(
        { environmentId: request.environmentId },
        { ...request, environmentId: undefined },
      ),
    ),
  ).toThrow();
  const response = {
    type: "process-result",
    requestId: "read-1",
    result: { sessionId: "session-1", processes: [], truncated: false },
  };
  expect(parseWorkerProcessMessage(response)).toEqual(response);
  expect(parseWorkerProcessMessage({ ...response, error: "mixed result" })).toBeNull();
  expect(
    parseWorkerProcessMessage({
      type: "process-result",
      requestId: "read-1",
      error: "x".repeat(513),
    }),
  ).toBeNull();
});
