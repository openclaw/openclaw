/** Controller-to-cron regression: watchdog stop facts reach persisted run history. */
import { describe, expect, it } from "vitest";
import { getCurrentSessionControllerOwner } from "../../sessions/session-controller.context.js";
import type { ReplyOperation } from "../../sessions/session-controller.contracts.js";
import { makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
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

  it("keeps explicit Stop permanent when the harness returns generic aborted metadata", async () => {
    harness.runWithModelFallbackMock.mockImplementationOnce(async () => {
      const operation = getCurrentSessionControllerOwner();
      expect(operation).toBeDefined();
      operation!.abortByUser();
      return {
        result: { result: { payloads: [], meta: { aborted: true, stopReason: "aborted" } } },
        provider: "openai",
        model: "test-model",
        attempts: [],
      };
    });
    const result = await runCron(makeIsolatedAgentParamsFixture());
    expect(result).toMatchObject({ status: "error", errorClassification: { kind: "aborted" } });
  });

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
