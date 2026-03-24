import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { runHeartbeatOnce, setHeartbeatsEnabled } from "./heartbeat-runner.js";

/**
 * Verifies that event-driven heartbeat reasons (cron, exec-event, wake, hook)
 * bypass the heartbeat-interval-disabled guard so that cron-triggered runs
 * are not silently skipped when `heartbeat.every` is "0m".
 *
 * See: https://github.com/openclaw/openclaw/issues/46046
 */

const agentId = "test-agent";

function buildConfig(every: string): OpenClawConfig {
  return {
    agents: {
      defaultId: agentId,
      list: [{ id: agentId, heartbeat: { every } }],
    },
  } as OpenClawConfig;
}

describe("runHeartbeatOnce – cron bypass when interval disabled", () => {
  beforeEach(() => {
    setHeartbeatsEnabled(true);
  });

  afterEach(() => {
    setHeartbeatsEnabled(true);
  });

  it('returns skipped/disabled for interval reason when every="0m"', async () => {
    const result = await runHeartbeatOnce({
      cfg: buildConfig("0m"),
      agentId,
      reason: "interval",
      // Provide getQueueSize so we know we'd get a different skip if the guard were bypassed
      deps: { getQueueSize: () => 1 },
    });
    expect(result).toEqual({ status: "skipped", reason: "disabled" });
  });

  it('does NOT return skipped/disabled for cron reason when every="0m"', async () => {
    const result = await runHeartbeatOnce({
      cfg: buildConfig("0m"),
      agentId,
      reason: "cron:job-123",
      deps: { getQueueSize: () => 1 },
    });
    // Should have passed the interval guard and hit a later skip reason
    expect(result.status).toBe("skipped");
    expect((result as { reason: string }).reason).not.toBe("disabled");
  });

  it('does NOT return skipped/disabled for exec-event reason when every="0m"', async () => {
    const result = await runHeartbeatOnce({
      cfg: buildConfig("0m"),
      agentId,
      reason: "exec-event",
      deps: { getQueueSize: () => 1 },
    });
    expect(result.status).toBe("skipped");
    expect((result as { reason: string }).reason).not.toBe("disabled");
  });

  it('does NOT return skipped/disabled for wake reason when every="0m"', async () => {
    const result = await runHeartbeatOnce({
      cfg: buildConfig("0m"),
      agentId,
      reason: "wake",
      deps: { getQueueSize: () => 1 },
    });
    expect(result.status).toBe("skipped");
    expect((result as { reason: string }).reason).not.toBe("disabled");
  });

  it('does NOT return skipped/disabled for hook reason when every="0m"', async () => {
    const result = await runHeartbeatOnce({
      cfg: buildConfig("0m"),
      agentId,
      reason: "hook:my-hook",
      deps: { getQueueSize: () => 1 },
    });
    expect(result.status).toBe("skipped");
    expect((result as { reason: string }).reason).not.toBe("disabled");
  });

  it("still allows interval reason when every is set to a valid duration", async () => {
    const result = await runHeartbeatOnce({
      cfg: buildConfig("30m"),
      agentId,
      reason: "interval",
      deps: { getQueueSize: () => 1 },
    });
    // Should pass the interval guard and hit the queue-size skip
    expect(result.status).toBe("skipped");
    expect((result as { reason: string }).reason).not.toBe("disabled");
  });
});
