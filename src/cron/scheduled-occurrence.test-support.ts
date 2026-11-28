import { buildScheduledExecutionContext } from "./execution-context.js";
import type { MintedScheduledExecution, ScheduledOccurrence } from "./scheduled-occurrence.js";

/**
 * A ready run context for tests that call `prepareCronRunAdmission` directly. It binds
 * nothing, so the tools under test keep their own targets.
 */
export const TEST_SCHEDULED_EXECUTION: MintedScheduledExecution = {
  result: buildScheduledExecutionContext(
    { id: "test-job", sessionTarget: "isolated", payload: { kind: "agentTurn", message: "test" } },
    {
      trigger: "cron",
      occurrence: { runId: "test-run", executionRevision: "" },
      agentId: "main",
      runSessionKey: "agent:main:cron:test-job",
      agentMainSessionKey: "agent:main:main",
      agentSandboxMode: "off",
    },
  ),
  bind() {},
  current: () => undefined,
  release() {},
};

/** An occurrence for tests that exercise executors below the cron service's admission. */
export const TEST_SCHEDULED_OCCURRENCE: ScheduledOccurrence = {
  mint: async () => TEST_SCHEDULED_EXECUTION,
  release() {},
};

/** Scheduled session-turn fields for tests that start the turn below the cron service. */
export const TEST_SCHEDULED_TURN = {
  occurrence: TEST_SCHEDULED_OCCURRENCE,
  admissionSource: "operator-schedule",
  assertCurrent() {},
} as const;
