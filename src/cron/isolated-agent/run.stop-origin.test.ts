import { describe, expect, it } from "vitest";
import { getCurrentSessionControllerOwner } from "../../sessions/session-controller.lifecycle.js";
import { resolveTransientCronRetryDecision } from "../service/timer-trigger.js";
import { makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import * as harness from "./run.test-harness.js";

const runCron = await harness.loadRunCronIsolatedAgentTurn();

describe("cron Stop origin", () => {
  setupRunCronIsolatedAgentTurnSuite();

  it.each(["user", "caller", "watchdog"] as const)(
    "preserves %s terminal intent through the isolated adapter",
    async (origin) => {
      harness.runWithModelFallbackMock.mockImplementationOnce(async () => {
        const owner = getCurrentSessionControllerOwner()!;
        if (origin === "user") {
          owner.abortByUser();
        } else if (origin === "watchdog") {
          owner.abortForStall();
        } else {
          owner.abort(new DOMException("caller interrupted", "AbortError"));
        }
        return {
          result: { result: { payloads: [], meta: { aborted: true, stopReason: "aborted" } } },
          provider: "openai",
          model: "test-model",
          attempts: [],
        };
      });
      const result = await runCron(makeIsolatedAgentParamsFixture());
      expect(result).toMatchObject({
        status: "error",
        errorClassification:
          origin === "user" ? { kind: "aborted" } : { kind: "reason", reason: "timeout" },
      });
      expect(
        resolveTransientCronRetryDecision({
          ...result,
          error: result.error,
          consecutiveErrors: 1,
        }).retryable,
      ).toBe(origin !== "user");
    },
  );
});
