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
async function wakeAgentMainWithCronLaneOccupant(
  laneDepths: Readonly<Record<string, number>> = { [CommandLane.Cron]: 1 },
) {
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
      deps: { getQueueSize: (lane?: string) => laneDepths[lane ?? ""] ?? 0 },
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
    const wake = await wakeAgentMainWithCronLaneOccupant({});

    expect(wake.kind).toBe("ready");
  });

  // Residual pinned deliberately (R1). CronNested and HookDispatch carry no run
  // attribution and are entered by hook dispatch and the reply-runner fallback without
  // any cron marker, so they still suppress bystanders process-wide. When per-agent
  // attribution lands on CommandLaneTaskMarker these two cases become the regression
  // signal: they should flip to "ready" for a foreign agent's nested work.
  it.each([
    { lane: CommandLane.CronNested, label: "cron-nested" },
    { lane: CommandLane.HookDispatch, label: "hook-dispatch" },
  ])("pins the residual: $label work still suppresses a bystander agent", async ({ lane }) => {
    // Agent B's cron run spawned nested agent work into an unattributable lane.
    markCronJobActive("agent-b-cron", { agentId: "agent-b" });

    const wake = await wakeAgentMainWithCronLaneOccupant({ [lane]: 1 });

    expect(wake).toEqual({ kind: "skipped", reason: HEARTBEAT_SKIP_CRON_IN_PROGRESS });
  });

  // R3: the foreign-run discount must never clamp a busy lane open. Markers are created
  // at admission while a lane slot is held only while the task runs, so the foreign count
  // can exceed lane depth; that disagreement must fall back to global counting.
  it("fails closed when foreign runs outnumber observed Cron lane depth", async () => {
    markCronJobActive("agent-b-1", { agentId: "agent-b" });
    markCronJobActive("agent-b-2", { agentId: "agent-b" });
    markCronJobActive("agent-b-3", { agentId: "agent-b" });

    // Depth 1 vs three foreign markers: cannot prove the single slot is foreign.
    const wake = await wakeAgentMainWithCronLaneOccupant({ [CommandLane.Cron]: 1 });

    expect(wake).toEqual({ kind: "skipped", reason: HEARTBEAT_SKIP_CRON_IN_PROGRESS });
  });
});
