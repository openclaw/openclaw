// Agent scoping for the cron busy gate: a bystander agent must keep its scheduled
// heartbeat while another agent's cron work occupies the Cron lane, and same-agent
// suppression must survive unchanged.
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { markCronJobActive, resetCronActiveJobs } from "../cron/active-jobs.js";
import { CommandLane } from "../process/lanes.js";
import { getLastHeartbeatEvent, resetHeartbeatEventsForTest } from "./heartbeat-events.js";
import { resolveHeartbeatWakeStage } from "./heartbeat-runner-execution.js";
import { seedSessionStore, withTempHeartbeatSandbox } from "./heartbeat-runner.test-utils.js";
import { HEARTBEAT_SKIP_CRON_IN_PROGRESS } from "./heartbeat-wake.js";

const sessionKey = "agent:main:main";

/**
 * Runs one wake for agent `main` on a gateway whose Cron lane already holds a single
 * task. Lane depth stays process-wide on purpose: the agent scoping lives in the busy
 * gate, not in the queue counter.
 */
async function wakeAgentMainWithCronLaneOccupant() {
  return withTempHeartbeatSandbox(async ({ tmpDir, storePath }) => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          workspace: tmpDir,
          heartbeat: { every: "30m", target: "none" },
        },
      },
      session: { store: storePath },
    };
    await seedSessionStore(storePath, sessionKey, {
      sessionId: "heartbeat-conversation",
      updatedAt: 1_700_000_000_000,
    });
    return resolveHeartbeatWakeStage({
      cfg,
      agentId: "main",
      sessionKey,
      source: "cron",
      intent: "immediate",
      deps: { getQueueSize: (lane?: string) => (lane === CommandLane.Cron ? 1 : 0) },
    });
  });
}

describe("heartbeat cron busy gate is agent-scoped", () => {
  afterEach(() => {
    resetCronActiveJobs();
    resetHeartbeatEventsForTest();
  });

  it("does not skip a bystander agent's tick for another agent's cron run", async () => {
    // Agent B's cron run holds the lane and carries its own marker.
    markCronJobActive("agent-b-cron", { agentId: "agent-b" });

    const wake = await wakeAgentMainWithCronLaneOccupant();

    expect(wake.kind).toBe("ready");
    expect(getLastHeartbeatEvent()).not.toMatchObject({
      reason: HEARTBEAT_SKIP_CRON_IN_PROGRESS,
    });
  });

  it("still skips the same agent's tick while its own cron run is active", async () => {
    markCronJobActive("agent-a-cron", { agentId: "main" });

    const wake = await wakeAgentMainWithCronLaneOccupant();

    expect(wake).toEqual({ kind: "skipped", reason: HEARTBEAT_SKIP_CRON_IN_PROGRESS });
    expect(getLastHeartbeatEvent()).toMatchObject({
      status: "skipped",
      reason: HEARTBEAT_SKIP_CRON_IN_PROGRESS,
    });
  });

  it("keeps unattributed cron work suppressing every agent", async () => {
    // No agent recorded: the documented safe default keeps counting it for everyone.
    markCronJobActive("ownerless-cron");

    const wake = await wakeAgentMainWithCronLaneOccupant();

    expect(wake).toEqual({ kind: "skipped", reason: HEARTBEAT_SKIP_CRON_IN_PROGRESS });
  });

  it("admits the wake when no cron work holds the lane", async () => {
    const wake = await withTempHeartbeatSandbox(async ({ tmpDir, storePath }) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: { every: "30m", target: "none" },
          },
        },
        session: { store: storePath },
      };
      await seedSessionStore(storePath, sessionKey, {
        sessionId: "heartbeat-conversation",
        updatedAt: 1_700_000_000_000,
      });
      return resolveHeartbeatWakeStage({
        cfg,
        agentId: "main",
        sessionKey,
        source: "cron",
        intent: "immediate",
        deps: { getQueueSize: () => 0 },
      });
    });

    expect(wake.kind).toBe("ready");
  });
});
