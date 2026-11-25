import { expect, it } from "vitest";
import { FailoverError } from "../../agents/failover-error.js";
import {
  createSessionPlacementSettlementClosedAbortError,
  createAgentRunDirectAbortError,
  createAgentRunRestartAbortError,
  createAgentRunSupersededAbortError,
} from "../../agents/run-termination.js";
import type { ReplyOperation } from "../../sessions/session-controller.js";
import {
  isReplyOperationSuperseded,
  resolveReplyOperationAbortReason,
  resolveReplyOperationTerminationFields,
} from "./reply-operation-abort.js";

function expectTermination(
  error: unknown,
  signal: AbortSignal | undefined,
  reason: "user" | "restart" | "superseded" | undefined,
  operation?: ReplyOperation,
) {
  expect(resolveReplyOperationAbortReason(operation, error, signal)).toBe(reason);
  expect(resolveReplyOperationTerminationFields(error, signal, operation)).toEqual(
    reason ? { aborted: true, stopReason: reason === "user" ? "aborted" : reason } : {},
  );
}

it("preserves failure for session placement settlement closed in fallback summary error", () => {
  const closedError = createSessionPlacementSettlementClosedAbortError();
  const summaryError = new FailoverError("All models failed", {
    reason: "unknown",
    attempts: [
      {
        provider: "p1",
        model: "m1",
        reason: "unknown",
        error: closedError.message,
      },
    ],
    soonestCooldownExpiry: null,
    cause: closedError,
  });
  expectTermination(summaryError, undefined, undefined);
});

it("does not infer supersession from a closed settlement abort signal", () => {
  const replyOp = {
    abortSignal: AbortSignal.abort(createSessionPlacementSettlementClosedAbortError()),
  } as unknown as ReplyOperation;
  expect(isReplyOperationSuperseded(replyOp)).toBe(false);
  expect(resolveReplyOperationAbortReason(replyOp)).toBeUndefined();
});

it.each([
  ["superseded", "aborted_for_supersession", createAgentRunRestartAbortError],
  ["restart", "aborted_for_restart", createAgentRunSupersededAbortError],
] as const)("preserves owner-recorded %s over a conflicting error", (reason, code, error) => {
  // SAFETY: These are the only operation fields read by the termination classifiers.
  const replyOp = { result: { kind: "aborted", code } } as unknown as ReplyOperation;
  if (reason === "superseded") {
    expect(isReplyOperationSuperseded(replyOp)).toBe(true);
  }
  expectTermination(error(), undefined, reason, replyOp);
});

it.each([
  ["user", new Error("caller cancelled")],
  ["superseded", createAgentRunSupersededAbortError()],
] as const)("preserves caller %s over an error-level restart", (reason, signalReason) => {
  expectTermination(createAgentRunRestartAbortError(), AbortSignal.abort(signalReason), reason);
});

it.each([
  ["restart", createAgentRunRestartAbortError],
  ["user", createAgentRunDirectAbortError],
] as const)("resolves %s from an abort error", (reason, error) => {
  expect(resolveReplyOperationAbortReason(undefined, error())).toBe(reason);
});
it("only suppresses a recorded supersession through error", () => {
  for (const superseded of [false, true]) {
    const reason = superseded
      ? createAgentRunSupersededAbortError()
      : createSessionPlacementSettlementClosedAbortError();
    expectTermination({ error: reason }, undefined, superseded ? "superseded" : undefined);
  }
});
