// Verifies recurring cron error backoff honors the configured retry.backoffMs
// floor instead of the hardcoded default schedule.
import { describe, expect, it, vi } from "vitest";
import {
  createDefaultIsolatedRunner,
  createIsolatedRegressionJob,
  noopLogger,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { createCronServiceState } from "./state.js";
import { applyJobResult } from "./timer.js";

describe("recurring error backoff floor", () => {
  it("honors configured cronConfig.retry.backoffMs instead of the hardcoded default", () => {
    const startedAt = Date.parse("2026-03-02T12:00:00.000Z");
    const endedAt = startedAt + 50;
    const state = createCronServiceState({
      cronEnabled: true,
      storePath: "/tmp/cron-backoff-config-proof.json",
      log: noopLogger,
      nowMs: () => endedAt,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: createDefaultIsolatedRunner(),
      cronConfig: { retry: { backoffMs: [300_000] } },
    });
    const job = createIsolatedRegressionJob({
      id: "recurring-backoff-config",
      name: "recurring-backoff-config",
      scheduledAt: startedAt,
      schedule: { kind: "every", everyMs: 1_000, anchorMs: startedAt },
      payload: { kind: "agentTurn", message: "ping" },
      state: { nextRunAtMs: startedAt },
    });

    // Non-retryable permanent error skips the retry-window branch and hits the
    // recurring safety-net backoff floor (the branch this PR fixes).
    applyJobResult(state, job, {
      status: "error",
      error: "permanent: bad request",
      startedAt,
      endedAt,
    });

    // Floor must use configured backoffMs[0]=300000; pre-fix used hardcoded 30000.
    expect(job.state.nextRunAtMs).toBe(endedAt + 300_000);
  });
});
