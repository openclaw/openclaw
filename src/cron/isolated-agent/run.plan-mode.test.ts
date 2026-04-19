import { describe, expect, it } from "vitest";
import {
  makeIsolatedAgentTurnJob,
  makeIsolatedAgentTurnParams,
  setupRunCronIsolatedAgentTurnSuite,
} from "./run.suite-helpers.js";
import {
  loadRunCronIsolatedAgentTurn,
  makeCronSession,
  resolveCronSessionMock,
  runEmbeddedPiAgentMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

describe("runCronIsolatedAgentTurn — plan-mode nudge guards", () => {
  setupRunCronIsolatedAgentTurnSuite();

  it("skips a plan-cycle-bound nudge when plan mode is no longer active", async () => {
    resolveCronSessionMock.mockReturnValue(
      makeCronSession({
        sessionEntry: {
          sessionId: "test-session-id",
          updatedAt: 0,
          systemSent: false,
          skillsSnapshot: undefined,
        },
      }),
    );

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentTurnParams({
        job: makeIsolatedAgentTurnJob({
          payload: {
            kind: "agentTurn",
            message: "[PLAN_NUDGE]: continue",
            planCycleId: "cycle-1",
          },
        }),
      }),
    );

    expect(result.status).toBe("skipped");
    expect(result.summary).toContain("plan mode is no longer active");
    expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
  });

  it("skips a plan-cycle-bound nudge when the cron belongs to an older cycle", async () => {
    resolveCronSessionMock.mockReturnValue(
      makeCronSession({
        sessionEntry: {
          sessionId: "test-session-id",
          updatedAt: 0,
          systemSent: false,
          skillsSnapshot: undefined,
          planMode: {
            mode: "plan",
            cycleId: "cycle-live",
            approval: "approved",
          },
        },
      }),
    );

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentTurnParams({
        job: makeIsolatedAgentTurnJob({
          payload: {
            kind: "agentTurn",
            message: "[PLAN_NUDGE]: continue",
            planCycleId: "cycle-old",
          },
        }),
      }),
    );

    expect(result.status).toBe("skipped");
    expect(result.summary).toContain("older plan cycle");
    expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
  });

  it("skips a plan-cycle-bound nudge while approval is still pending", async () => {
    resolveCronSessionMock.mockReturnValue(
      makeCronSession({
        sessionEntry: {
          sessionId: "test-session-id",
          updatedAt: 0,
          systemSent: false,
          skillsSnapshot: undefined,
          planMode: {
            mode: "plan",
            cycleId: "cycle-live",
            approval: "pending",
          },
        },
      }),
    );

    const result = await runCronIsolatedAgentTurn(
      makeIsolatedAgentTurnParams({
        job: makeIsolatedAgentTurnJob({
          payload: {
            kind: "agentTurn",
            message: "[PLAN_NUDGE]: continue",
            planCycleId: "cycle-live",
          },
        }),
      }),
    );

    expect(result.status).toBe("skipped");
    expect(result.summary).toContain("approval is still pending");
    expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
  });
});
