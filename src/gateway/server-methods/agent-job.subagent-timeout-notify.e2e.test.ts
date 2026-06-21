// End-to-end coverage for the parent-notification contract behind #89095: when a
// subagent run aborts in a hard timeout phase and the parent's agent.wait outer
// fallback timer fires before the pending-timeout grace publishes, the parent
// must still observe the precise terminal timeout snapshot (phase + timestamps)
// instead of a null result that collapses to a generic gateway/queue timeout.
//
// This drives the real in-process agent event bus and the real waitForAgentJob
// (the function agent.wait races for the parent) rather than mocking either.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emitAgentEvent } from "../../infra/agent-events.js";
import { waitForAgentJob } from "./agent-job.js";

const HARD_TIMEOUT_PHASES = ["preflight", "provider", "post_turn"] as const;

function uniqueRunId(label: string): string {
  return `run-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

describe("subagent hard-timeout parent notification (#89095)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  for (const phase of HARD_TIMEOUT_PHASES) {
    it(`forwards the ${phase} hard-timeout snapshot to the waiting parent`, async () => {
      const runId = uniqueRunId(phase);
      const waitPromise = waitForAgentJob({ runId, timeoutMs: 5_000 });

      emitAgentEvent({
        runId,
        stream: "lifecycle",
        data: { phase: "start", startedAt: 1_000 },
      });
      emitAgentEvent({
        runId,
        stream: "lifecycle",
        data: {
          phase: "end",
          startedAt: 1_000,
          endedAt: 1_100,
          aborted: true,
          timeoutPhase: phase,
        },
      });

      // Outer fallback timer fires before the pending-timeout grace window
      // publishes the snapshot to the cache.
      await vi.advanceTimersByTimeAsync(6_000);

      const result = await waitPromise;
      // Before the fix the parent saw null here and agent.wait downgraded the
      // outcome to a generic gateway_draining/queue timeout, losing the phase.
      expect(result).not.toBeNull();
      expect(result?.status).toBe("timeout");
      expect(result?.timeoutPhase).toBe(phase);
      expect(result?.startedAt).toBe(1_000);
      expect(result?.endedAt).toBe(1_100);
    });
  }
});
