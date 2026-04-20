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

describe("runCronIsolatedAgentTurn — autoEnableFor runtime (C3)", () => {
  setupRunCronIsolatedAgentTurnSuite();

  const autoEnableCfg = {
    agents: {
      defaults: {
        planMode: {
          enabled: true,
          autoEnableFor: ["^openai/gpt-5\\."],
        },
      },
    },
  };

  it("auto-enables plan mode when session.planMode is absent AND model matches a configured pattern", async () => {
    const session = makeCronSession({
      sessionEntry: {
        sessionId: "auto-enable-fresh",
        updatedAt: 0,
        systemSent: false,
        skillsSnapshot: undefined,
        planMode: undefined,
      },
    });
    resolveCronSessionMock.mockReturnValue(session);

    await runCronIsolatedAgentTurn(
      makeIsolatedAgentTurnParams({
        cfg: autoEnableCfg,
        job: makeIsolatedAgentTurnJob({
          payload: { kind: "agentTurn", message: "hello" },
        }),
      }),
    );

    // The cron runner should have flipped the session entry into
    // plan mode before dispatching the turn. The test harness's
    // default model selection resolves to openai/gpt-5.4 which
    // matches the configured pattern.
    const planMode = session.sessionEntry.planMode as
      | { mode?: string; approval?: string }
      | undefined;
    expect(planMode).toBeDefined();
    expect(planMode?.mode).toBe("plan");
    expect(planMode?.approval).toBe("none");
  });

  it("does NOT auto-enable when session already has planMode state (respects user-toggled /plan off)", async () => {
    const session = makeCronSession({
      sessionEntry: {
        sessionId: "auto-enable-user-off",
        updatedAt: 0,
        systemSent: false,
        skillsSnapshot: undefined,
        planMode: {
          mode: "normal",
          approval: "none",
        },
      },
    });
    resolveCronSessionMock.mockReturnValue(session);

    await runCronIsolatedAgentTurn(
      makeIsolatedAgentTurnParams({
        cfg: autoEnableCfg,
        job: makeIsolatedAgentTurnJob({
          payload: { kind: "agentTurn", message: "hello" },
        }),
      }),
    );

    // User previously toggled plan-mode OFF — don't re-enable.
    const planMode = session.sessionEntry.planMode as { mode?: string } | undefined;
    expect(planMode?.mode).toBe("normal");
  });

  it("does NOT auto-enable when planMode feature gate is off (agents.defaults.planMode.enabled != true)", async () => {
    const session = makeCronSession({
      sessionEntry: {
        sessionId: "auto-enable-gate-off",
        updatedAt: 0,
        systemSent: false,
        skillsSnapshot: undefined,
        planMode: undefined,
      },
    });
    resolveCronSessionMock.mockReturnValue(session);

    await runCronIsolatedAgentTurn(
      makeIsolatedAgentTurnParams({
        cfg: {
          agents: {
            defaults: {
              planMode: {
                // enabled omitted → feature gate off
                autoEnableFor: ["^openai/gpt-5\\."],
              },
            },
          },
        },
        job: makeIsolatedAgentTurnJob({
          payload: { kind: "agentTurn", message: "hello" },
        }),
      }),
    );

    // Feature gate OFF → no auto-enable even if patterns match.
    expect(session.sessionEntry.planMode).toBeUndefined();
  });

  it("does NOT auto-enable when autoEnableFor patterns don't match the resolved model", async () => {
    const session = makeCronSession({
      sessionEntry: {
        sessionId: "auto-enable-no-match",
        updatedAt: 0,
        systemSent: false,
        skillsSnapshot: undefined,
        planMode: undefined,
      },
    });
    resolveCronSessionMock.mockReturnValue(session);

    await runCronIsolatedAgentTurn(
      makeIsolatedAgentTurnParams({
        cfg: {
          agents: {
            defaults: {
              planMode: {
                enabled: true,
                // Pattern targets anthropic, not openai/gpt-5.4.
                autoEnableFor: ["^anthropic/claude-opus"],
              },
            },
          },
        },
        job: makeIsolatedAgentTurnJob({
          payload: { kind: "agentTurn", message: "hello" },
        }),
      }),
    );

    expect(session.sessionEntry.planMode).toBeUndefined();
  });
});
