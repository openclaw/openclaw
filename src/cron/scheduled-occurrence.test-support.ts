import { unadmittedScheduledOccurrence } from "./scheduled-occurrence.js";

/** An occurrence for tests that exercise executors below the cron service's admission. */
export const TEST_SCHEDULED_OCCURRENCE = unadmittedScheduledOccurrence(
  "test runs are not admitted through the cron service",
);

/** A run context for tests that call `prepareCronRunAdmission` directly. */
export const TEST_SCHEDULED_EXECUTION = TEST_SCHEDULED_OCCURRENCE.mint({
  cfg: {},
  agentId: "main",
  runId: "test-run",
  runSessionKey: "agent:main:cron:test",
});

/** Scheduled session-turn fields for tests that start the turn below the cron service. */
export const TEST_SCHEDULED_TURN = {
  occurrence: TEST_SCHEDULED_OCCURRENCE,
  admissionSource: "operator-schedule",
  assertCurrent() {},
} as const;
