import { describe, expect, it } from "vitest";
import { FailoverError } from "../../agents/failover-error.js";
import {
  createSessionPlacementSettlementClosedAbortError,
  createAgentRunDirectAbortError,
  createAgentRunRestartAbortError,
  createAgentRunSupersededAbortError,
} from "../../agents/run-termination.js";
import {
  isReplyOperationSuperseded,
  resolveReplyOperationAbortReason,
  resolveReplyOperationTerminationFields,
} from "./reply-operation-abort.js";
import type { ReplyOperation } from "./reply-run-registry.js";

describe("reply-operation-abort", () => {
  it("preserves failure for session placement settlement closed abort error", () => {
    const error = createSessionPlacementSettlementClosedAbortError();
    expect(resolveReplyOperationAbortReason(undefined, error)).toBeUndefined();
  });

  it("preserves failure for session placement settlement closed wrapped in cause", () => {
    const error = new Error("wrapper", {
      cause: createSessionPlacementSettlementClosedAbortError(),
    });
    expect(resolveReplyOperationAbortReason(undefined, error)).toBeUndefined();
  });

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
    expect(resolveReplyOperationAbortReason(undefined, summaryError)).toBeUndefined();
  });

  it("resolves superseded for agent run superseded abort error", () => {
    const error = createAgentRunSupersededAbortError();
    expect(resolveReplyOperationAbortReason(undefined, error)).toBe("superseded");
  });

  it("does not infer supersession from a closed settlement abort signal", () => {
    const controller = new AbortController();
    controller.abort(createSessionPlacementSettlementClosedAbortError());
    const replyOp = { abortSignal: controller.signal } as unknown as ReplyOperation;
    expect(isReplyOperationSuperseded(replyOp)).toBe(false);
    expect(resolveReplyOperationAbortReason(replyOp)).toBeUndefined();
  });

  it("resolves superseded when replyOperation is marked aborted_for_supersession", () => {
    const replyOp = {
      result: { kind: "aborted", code: "aborted_for_supersession" },
    } as unknown as ReplyOperation;
    expect(isReplyOperationSuperseded(replyOp)).toBe(true);
    expect(resolveReplyOperationAbortReason(replyOp)).toBe("superseded");
  });

  it("preserves owner-recorded supersession over a concurrent restart error", () => {
    const error = createAgentRunRestartAbortError();
    const controller = new AbortController();
    controller.abort(createAgentRunSupersededAbortError());
    // SAFETY: These are the only operation fields read by the termination classifiers.
    const replyOp = {
      result: { kind: "aborted", code: "aborted_for_supersession" },
      abortSignal: controller.signal,
    } as unknown as ReplyOperation;
    expect(resolveReplyOperationAbortReason(replyOp, error)).toBe("superseded");
    expect(resolveReplyOperationTerminationFields(error, controller.signal, replyOp)).toEqual({
      aborted: true,
      stopReason: "superseded",
    });
  });

  it("preserves owner-recorded restart over a concurrent superseded error", () => {
    const error = createAgentRunSupersededAbortError();
    const controller = new AbortController();
    controller.abort(createAgentRunRestartAbortError());
    // SAFETY: These are the only operation fields read by the termination classifiers.
    const replyOp = {
      result: { kind: "aborted", code: "aborted_for_restart" },
      abortSignal: controller.signal,
    } as unknown as ReplyOperation;
    expect(resolveReplyOperationAbortReason(replyOp, error)).toBe("restart");
    expect(resolveReplyOperationTerminationFields(error, controller.signal, replyOp)).toEqual({
      aborted: true,
      stopReason: "restart",
    });
  });

  it("preserves a caller timeout over an error-level supersession without an operation", () => {
    const controller = new AbortController();
    controller.abort(new DOMException("caller deadline", "TimeoutError"));
    const error = createAgentRunSupersededAbortError();
    expect(resolveReplyOperationAbortReason(undefined, error, controller.signal)).toBe("user");
    expect(resolveReplyOperationTerminationFields(error, controller.signal)).toEqual({
      aborted: true,
      stopReason: "timeout",
    });
  });

  it.each([
    ["restart", createAgentRunRestartAbortError()],
    ["supersession", createAgentRunSupersededAbortError()],
  ])(
    "preserves caller cancellation over an error-level %s without an operation",
    (_name, error) => {
      const controller = new AbortController();
      controller.abort(new Error("caller cancelled"));
      expect(resolveReplyOperationAbortReason(undefined, error, controller.signal)).toBe("user");
      expect(resolveReplyOperationTerminationFields(error, controller.signal)).toEqual({
        aborted: true,
        stopReason: "aborted",
      });
    },
  );

  it.each([
    ["restart", createAgentRunRestartAbortError(), createAgentRunSupersededAbortError()],
    ["superseded", createAgentRunSupersededAbortError(), createAgentRunRestartAbortError()],
  ])(
    "preserves a typed caller %s over a conflicting error marker without an operation",
    (expectedReason, signalReason, error) => {
      const controller = new AbortController();
      controller.abort(signalReason);
      expect(resolveReplyOperationAbortReason(undefined, error, controller.signal)).toBe(
        expectedReason,
      );
      expect(resolveReplyOperationTerminationFields(error, controller.signal)).toEqual({
        aborted: true,
        stopReason: expectedReason,
      });
    },
  );

  it("resolves restart for restart abort error", () => {
    const error = createAgentRunRestartAbortError();
    expect(resolveReplyOperationAbortReason(undefined, error)).toBe("restart");
  });

  it("resolves user for direct agent abort error", () => {
    const error = createAgentRunDirectAbortError();
    expect(resolveReplyOperationAbortReason(undefined, error)).toBe("user");
  });

  it("returns undefined for genuine provider errors", () => {
    const providerError = new FailoverError("Rate limit exceeded", {
      reason: "rate_limit",
      status: 429,
    });
    expect(resolveReplyOperationAbortReason(undefined, providerError)).toBeUndefined();
  });

  it("does not assign superseded lifecycle fields to a closed settlement without a successor", () => {
    const error = createSessionPlacementSettlementClosedAbortError();
    const fields = resolveReplyOperationTerminationFields(error, undefined, undefined);
    expect(fields).toEqual({});
  });
});

it.each(["cause", "error", "aggregate", "cyclic"])(
  "only suppresses a recorded supersession through %s",
  (kind) => {
    for (const superseded of [false, true]) {
      const reason = superseded
        ? createAgentRunSupersededAbortError()
        : createSessionPlacementSettlementClosedAbortError();
      const cycle = { cause: undefined as unknown, errors: [reason] };
      cycle.cause = cycle;
      const error =
        kind === "cause"
          ? new Error("wrapper", { cause: reason })
          : kind === "error"
            ? { error: reason }
            : kind === "aggregate"
              ? new AggregateError([reason], "wrapper")
              : cycle;
      expect(resolveReplyOperationAbortReason(undefined, error)).toBe(
        superseded ? "superseded" : undefined,
      );
      expect(resolveReplyOperationTerminationFields(error, undefined, undefined)).toEqual(
        superseded ? { aborted: true, stopReason: "superseded" } : {},
      );
    }
  },
);
