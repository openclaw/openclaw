/** Controller-to-cron regression: watchdog stop facts reach persisted run history. */
import { describe, expect, it, vi } from "vitest";
import { getCurrentSessionControllerOwner } from "../../sessions/session-controller.context.js";
import type { ReplyOperation } from "../../sessions/session-controller.contracts.js";
import { CronSessionLifecycleClaimError } from "../run-authority.js";
import { resolveTransientCronRetryDecision } from "../service/timer-trigger.js";
import { makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import * as sessionState from "./run-session-state.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import * as harness from "./run.test-harness.js";

const runCron = await harness.loadRunCronIsolatedAgentTurn();

/** Fail the mocked model call after recording facts on the live controller operation. */
function stopOwnOperation(
  record: (operation: ReplyOperation) => void,
  error: Error = new Error("Reply operation stalled"),
): void {
  harness.runWithModelFallbackMock.mockImplementationOnce(async () => {
    const operation = getCurrentSessionControllerOwner();
    expect(operation).toBeDefined();
    record(operation!);
    throw error;
  });
}

describe("runCronIsolatedAgentTurn watchdog cause", () => {
  setupRunCronIsolatedAgentTurnSuite();

  it.each(["initialize", "recordScheduledMemoryParent"] as const)(
    "retries a continuation claim conflict during %s before model execution",
    async (phase) => {
      const create = sessionState.createCronRunContinuationSession;
      const claim = vi
        .spyOn(sessionState, "createCronRunContinuationSession")
        .mockImplementation((params) => ({
          ...create(params),
          [phase]: async () => {
            throw new CronSessionLifecycleClaimError(
              params.runSessionKey,
              "Synthetic admission conflict",
            );
          },
        }));
      try {
        const result = await runCron(makeIsolatedAgentParamsFixture());
        expect(result).toMatchObject({
          status: "error",
          executionStarted: false,
          errorClassification: { kind: "session-conflict" },
          admissionDisposition: "session-conflict",
        });
        expect(
          resolveTransientCronRetryDecision({
            ...result,
            error: result.error,
            consecutiveErrors: 1,
          }),
        ).toMatchObject({
          retryable: true,
          backoffMs: 30_000,
        });
        expect(harness.runEmbeddedAgentMock).not.toHaveBeenCalled();
      } finally {
        claim.mockRestore();
      }
    },
  );

  it.each(["user", "watchdog"] as const)(
    "classifies returned aborted metadata after %s",
    async (stop) => {
      harness.runWithModelFallbackMock.mockImplementationOnce(async () => {
        const operation = getCurrentSessionControllerOwner();
        expect(operation).toBeDefined();
        if (stop === "user") {
          operation!.abortByUser();
        } else {
          operation!.abortForStall();
        }
        return {
          result: {
            result: {
              payloads: [],
              meta: {
                aborted: true,
                stopReason: "aborted",
                ...(stop === "watchdog" ? { livenessState: "blocked" } : {}),
              },
            },
          },
          provider: "openai",
          model: "test-model",
          attempts: [],
        };
      });
      const result = await runCron(makeIsolatedAgentParamsFixture());
      expect(result).toMatchObject({
        status: "error",
        errorClassification:
          stop === "user" ? { kind: "aborted" } : { kind: "reason", reason: "timeout" },
      });
    },
  );

  it("persists the controller's recovery classification instead of the generic stall text", async () => {
    stopOwnOperation((operation) => {
      operation.recoveryClassification = "blocked_tool_call";
      operation.abortForStall();
    });

    const result = await runCron(makeIsolatedAgentParamsFixture());

    expect(result).toMatchObject({
      status: "error",
      error: "blocked_tool_call",
      errorClassification: { kind: "reason", reason: "timeout" },
      failureNotificationDetail: { kind: "agent-stall", classification: "blocked_tool_call" },
    });
  });

  it("ignores the classification when the operation recorded a rate-limited stop", async () => {
    stopOwnOperation((operation) => {
      operation.recoveryClassification = "semantic_stall";
      // abortForStall records the stop fact; mirror it on the live operation.
      Object.defineProperty(operation, "staleExpiryReason", { value: "rate_limited" });
    }, new Error("Rate limited by anthropic; retrying in 30s."));

    const result = await runCron(makeIsolatedAgentParamsFixture());

    expect(result).toMatchObject({
      status: "error",
      error: "Rate limited by anthropic; retrying in 30s.",
    });
    expect(result.failureNotificationDetail).toBeUndefined();
  });
});
