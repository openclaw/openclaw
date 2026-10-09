// Agent scoping for the cron busy gate. The marker term is agent-scoped: another
// agent's cron run must not make this agent look busy. The lane term stays global,
// because a Cron lane entry carries no owner attribution, so these tests pin both the
// relief that scoping buys and the residual starvation it does not.
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  clearCronJobActive,
  markCronJobActive,
  markCronJobWaitingForHeartbeat,
  resetCronActiveJobs,
} from "../cron/active-jobs.js";
import { enqueueCommandInLane } from "../process/command-queue.js";
import { CommandLane } from "../process/lanes.js";
import { getLastHeartbeatEvent, resetHeartbeatEventsForTest } from "./heartbeat-events.js";
import { resolveHeartbeatWakeStage } from "./heartbeat-runner-execution.js";
import { seedSessionStore, withTempHeartbeatSandbox } from "./heartbeat-runner.test-utils.js";
import { HEARTBEAT_SKIP_CRON_IN_PROGRESS } from "./heartbeat-wake.js";

const sessionKey = "agent:main:main";

/**
 * Runs one wake for agent `main` against a gateway whose lanes hold exactly
 * `laneDepths`. Lane depth is process-wide by design: the agent scoping lives in the
 * marker term, not in the queue counter.
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
    // Agent B's run holds a marker but no Cron lane slot, so the marker term is the
    // only thing that could suppress agent A.
    const foreign = markCronJobActive("agent-b-cron", { agentId: "agent-b" });

    try {
      const wake = await wakeAgentMainWithCronLaneOccupant({});

      expect(wake.kind).toBe("ready");
      expect(getLastHeartbeatEvent()).not.toMatchObject({
        reason: HEARTBEAT_SKIP_CRON_IN_PROGRESS,
      });
    } finally {
      clearCronJobActive("agent-b-cron", foreign);
    }
  });

  it("still skips the same agent's tick while its own cron run is active", async () => {
    const own = markCronJobActive("agent-a-cron", { agentId: "main" });

    try {
      const wake = await wakeAgentMainWithCronLaneOccupant({});

      expect(wake).toEqual({ kind: "skipped", reason: HEARTBEAT_SKIP_CRON_IN_PROGRESS });
      expect(getLastHeartbeatEvent()).toMatchObject({
        status: "skipped",
        reason: HEARTBEAT_SKIP_CRON_IN_PROGRESS,
      });
    } finally {
      clearCronJobActive("agent-a-cron", own);
    }
  });

  it("keeps unattributed cron work suppressing every agent", async () => {
    // No agent recorded: the documented safe default keeps counting it for everyone.
    const ownerless = markCronJobActive("ownerless-cron");

    try {
      const wake = await wakeAgentMainWithCronLaneOccupant({});

      expect(wake).toEqual({ kind: "skipped", reason: HEARTBEAT_SKIP_CRON_IN_PROGRESS });
    } finally {
      clearCronJobActive("ownerless-cron", ownerless);
    }
  });

  it("exempts this agent's own coalesced wake from its own busy check", async () => {
    const own = markCronJobActive("agent-a-own-wake", { agentId: "main" });
    const release = own ? markCronJobWaitingForHeartbeat(own) : undefined;

    try {
      // This agent's run is idle awaiting this very heartbeat, so it is not competing.
      const wake = await wakeAgentMainWithCronLaneOccupant({});

      expect(wake.kind).toBe("ready");
    } finally {
      release?.();
      clearCronJobActive("agent-a-own-wake", own);
    }
  });

  it("does not let another agent's coalesced wake exempt this agent's own run", async () => {
    const foreign = markCronJobActive("agent-b-waiting", { agentId: "agent-b" });
    const foreignRelease = foreign ? markCronJobWaitingForHeartbeat(foreign) : undefined;
    const own = markCronJobActive("agent-a-competing", { agentId: "main" });

    try {
      // Agent B's wake is agent B's exemption; agent A's competing run still counts.
      const wake = await wakeAgentMainWithCronLaneOccupant({});

      expect(wake).toEqual({ kind: "skipped", reason: HEARTBEAT_SKIP_CRON_IN_PROGRESS });
    } finally {
      foreignRelease?.();
      clearCronJobActive("agent-a-competing", own);
      clearCronJobActive("agent-b-waiting", foreign);
    }
  });

  it("admits a bystander while another agent's idle cron run owns the only lane slot", async () => {
    // #134464 exemption, applied to a foreign owner: the exact current lane task that
    // owns the wake is not competing work, whoever started it.
    await enqueueCommandInLane(CommandLane.Cron, async (laneTask) => {
      const foreign = markCronJobActive("agent-b-idle-owner", { agentId: "agent-b" });
      const release = foreign ? markCronJobWaitingForHeartbeat(foreign, laneTask) : undefined;

      try {
        const wake = await wakeAgentMainWithCronLaneOccupant({ [CommandLane.Cron]: 1 });

        expect(wake.kind).toBe("ready");
      } finally {
        release?.();
        clearCronJobActive("agent-b-idle-owner", foreign);
      }
    });
  });

  it("still blocks this agent while its own cron work holds a Cron lane slot", async () => {
    const own = markCronJobActive("agent-a-queued", { agentId: "main" });

    try {
      const wake = await wakeAgentMainWithCronLaneOccupant({ [CommandLane.Cron]: 1 });

      expect(wake).toEqual({ kind: "skipped", reason: HEARTBEAT_SKIP_CRON_IN_PROGRESS });
    } finally {
      clearCronJobActive("agent-a-queued", own);
    }
  });

  it("admits the wake when no cron work holds the lane", async () => {
    const wake = await wakeAgentMainWithCronLaneOccupant({});

    expect(wake.kind).toBe("ready");
  });

  // Residuals pinned deliberately (R1/R2). A Cron lane entry, a CronNested entry and a
  // HookDispatch entry carry no run attribution, so the gate cannot tell whose work they
  // are and keeps counting them process-wide. A Cron marker and a Cron lane entry are also
  // different populations with different lifecycles, so no count-based lane discount is
  // sound here. These cases flip to "ready" only when agentId lands on
  // CommandLaneTaskMarker in src/process/command-queue.ts, which is out of scope.
  it("pins the residual: another agent's queued Cron lane entry still suppresses", async () => {
    const foreign = markCronJobActive("agent-b-queued", { agentId: "agent-b" });

    try {
      const wake = await wakeAgentMainWithCronLaneOccupant({ [CommandLane.Cron]: 1 });

      expect(wake).toEqual({ kind: "skipped", reason: HEARTBEAT_SKIP_CRON_IN_PROGRESS });
    } finally {
      clearCronJobActive("agent-b-queued", foreign);
    }
  });

  it.each([
    { lane: CommandLane.CronNested, label: "cron-nested" },
    { lane: CommandLane.HookDispatch, label: "hook-dispatch" },
  ])("pins the residual: $label work still suppresses a bystander agent", async ({ lane }) => {
    // Agent B's cron run spawned nested agent work into an unattributable lane.
    const foreign = markCronJobActive("agent-b-nested", { agentId: "agent-b" });

    try {
      const wake = await wakeAgentMainWithCronLaneOccupant({ [lane]: 1 });

      expect(wake).toEqual({ kind: "skipped", reason: HEARTBEAT_SKIP_CRON_IN_PROGRESS });
    } finally {
      clearCronJobActive("agent-b-nested", foreign);
    }
  });
});
