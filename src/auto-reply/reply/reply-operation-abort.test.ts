import { describe, expect, it } from "vitest";
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

describe("reply-operation-abort", () => {
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

  it("preserves owner-recorded supersession over a concurrent restart error", () => {
    const error = createAgentRunRestartAbortError();
    // SAFETY: These are the only operation fields read by the termination classifiers.
    const replyOp = {
      result: { kind: "aborted", code: "aborted_for_supersession" },
    } as unknown as ReplyOperation;
    expect(isReplyOperationSuperseded(replyOp)).toBe(true);
    expectTermination(error, undefined, "superseded", replyOp);
  });

  it("preserves owner-recorded restart over a concurrent superseded error", () => {
    const error = createAgentRunSupersededAbortError();
    // SAFETY: These are the only operation fields read by the termination classifiers.
    const replyOp = {
      result: { kind: "aborted", code: "aborted_for_restart" },
    } as unknown as ReplyOperation;
    expectTermination(error, undefined, "restart", replyOp);
  });

  it("preserves caller cancellation over an error-level restart without an operation", () => {
    const error = createAgentRunRestartAbortError();
    expectTermination(error, AbortSignal.abort(new Error("caller cancelled")), "user");
  });

  it("preserves typed caller supersession over a conflicting error marker without an operation", () => {
    expectTermination(
      createAgentRunRestartAbortError(),
      AbortSignal.abort(createAgentRunSupersededAbortError()),
      "superseded",
    );
  });

  it("resolves restart for restart abort error", () => {
    const error = createAgentRunRestartAbortError();
    expect(resolveReplyOperationAbortReason(undefined, error)).toBe("restart");
  });

  it("resolves user for direct agent abort error", () => {
    const error = createAgentRunDirectAbortError();
    expect(resolveReplyOperationAbortReason(undefined, error)).toBe("user");
  });
});

it("only suppresses a recorded supersession through error", () => {
  for (const superseded of [false, true]) {
    const reason = superseded
      ? createAgentRunSupersededAbortError()
      : createSessionPlacementSettlementClosedAbortError();
    expectTermination({ error: reason }, undefined, superseded ? "superseded" : undefined);
  }
});
