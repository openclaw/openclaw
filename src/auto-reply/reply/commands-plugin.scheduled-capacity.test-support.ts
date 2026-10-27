import { expectDefined } from "@openclaw/normalization-core";
import { expect } from "vitest";
import {
  enqueueSwarmRun,
  isSwarmRunActive,
  listSwarmRunReservationIds,
  releaseSwarmRun,
} from "../../agents/subagents/swarm/swarm-scheduler.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CronAgentExecutionStarted } from "../../cron/types.js";

/**
 * Occupies the scheduled occurrence's swarm lane so its native children stay queued.
 *
 * The lane limit comes from the configured swarm concurrency: every reservation re-applies
 * it, so a blocker alone cannot narrow the lane. Pinning the configured limit to one keeps
 * the hold deterministic instead of depending on module-load timing.
 */
export function holdScheduledChildCapacity(fixture: {
  cfg: OpenClawConfig;
  onExecutionStarted?: (info: CronAgentExecutionStarted) => void;
}) {
  fixture.cfg.tools = { ...fixture.cfg.tools, swarm: { maxConcurrent: 1 } };
  const blockers: string[] = [];
  let occurrenceRunId: string | undefined;
  fixture.onExecutionStarted = (info) => {
    const runId = expectDefined(info.runId, "scheduled occurrence run id");
    const sessionKey = expectDefined(info.sessionKey, "scheduled occurrence parent");
    occurrenceRunId = runId;
    const blocker = "capacity-" + runId;
    blockers.push(blocker);
    enqueueSwarmRun({
      groupId: JSON.stringify(["main", sessionKey, "swarm:" + sessionKey + ":" + runId]),
      runId: blocker,
      maxConcurrent: 1,
      activeRunIds: [],
      start: async () => {},
      onStartFailure: () => true,
    });
  };
  return {
    occurrenceRunId: () => occurrenceRunId,
    /** The child holds a reservation but has not launched, so no agent turn has started. */
    expectWaiting: (childRunId: string) => {
      expect(listSwarmRunReservationIds()).toContain(childRunId);
      expect(isSwarmRunActive(childRunId)).toBe(false);
    },
    release: () => {
      for (const blocker of blockers.splice(0)) {
        releaseSwarmRun(blocker);
      }
    },
  };
}
