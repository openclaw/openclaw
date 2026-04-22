/**
 * PR-9 Wave A1: heartbeat plan-continuation nudge.
 *
 * Tests cover the prompt-prefix builder. When `SessionEntry.planMode`
 * has `mode: "plan"` and at least one non-terminal step, the heartbeat
 * runner prepends a structured "Your plan is active. Step N of M is
 * <state>: ..." string onto the heartbeat base prompt. This keeps task
 * state in runtime structured form (`SessionEntry.planMode.lastPlanSteps`)
 * and out of HEARTBEAT.md per the user's explicit requirement.
 */
import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../config/sessions/types.js";
import { buildActivePlanNudge } from "./heartbeat-runner.js";

type PlanMode = NonNullable<SessionEntry["planMode"]>;

function makePlanMode(overrides: Partial<PlanMode> = {}): PlanMode {
  return {
    mode: "plan",
    approval: "approved",
    rejectionCount: 0,
    ...overrides,
  } as PlanMode;
}

describe("buildActivePlanNudge (Wave A1)", () => {
  it("returns null when planMode is undefined", () => {
    expect(buildActivePlanNudge(undefined)).toBeNull();
  });

  it("returns null when planMode.mode is normal", () => {
    expect(
      buildActivePlanNudge(
        makePlanMode({
          mode: "normal",
          lastPlanSteps: [{ step: "x", status: "in_progress" }],
        }),
      ),
    ).toBeNull();
  });

  it("returns null when lastPlanSteps is missing", () => {
    expect(buildActivePlanNudge(makePlanMode())).toBeNull();
  });

  it("returns null when lastPlanSteps is empty", () => {
    expect(buildActivePlanNudge(makePlanMode({ lastPlanSteps: [] }))).toBeNull();
  });

  it("returns null when all steps are terminal (completed/cancelled)", () => {
    expect(
      buildActivePlanNudge(
        makePlanMode({
          lastPlanSteps: [
            { step: "A", status: "completed" },
            { step: "B", status: "cancelled" },
          ],
        }),
      ),
    ).toBeNull();
  });

  it("prefers in_progress over pending when both exist", () => {
    const out = buildActivePlanNudge(
      makePlanMode({
        lastPlanSteps: [
          { step: "A", status: "completed" },
          { step: "B", status: "pending" },
          { step: "C", status: "in_progress", activeForm: "Provisioning C" },
          { step: "D", status: "pending" },
        ],
      }),
    );
    expect(out).toContain("Step 3 of 4 is in_progress");
    expect(out).toContain('"Provisioning C"');
  });

  it("falls back to first pending when no in_progress", () => {
    const out = buildActivePlanNudge(
      makePlanMode({
        lastPlanSteps: [
          { step: "A", status: "completed" },
          { step: "B", status: "pending" },
          { step: "C", status: "pending" },
        ],
      }),
    );
    expect(out).toContain("Step 2 of 3 is pending");
    expect(out).toContain('"B"');
  });

  it("uses step text (not activeForm) when status is pending", () => {
    const out = buildActivePlanNudge(
      makePlanMode({
        lastPlanSteps: [{ step: "Run tests", status: "pending", activeForm: "Running tests" }],
      }),
    );
    expect(out).toContain('"Run tests"');
    expect(out).not.toContain("Running tests");
  });

  it("uses step text when in_progress has no activeForm", () => {
    const out = buildActivePlanNudge(
      makePlanMode({
        lastPlanSteps: [{ step: "Bare step", status: "in_progress" }],
      }),
    );
    expect(out).toContain('"Bare step"');
  });

  it("includes 'Continue from where you left off' guidance text", () => {
    const out = buildActivePlanNudge(
      makePlanMode({
        lastPlanSteps: [{ step: "X", status: "in_progress" }],
      }),
    );
    expect(out).toContain("Continue from where you left off");
    expect(out).toContain("update_plan");
  });
});

describe("buildActivePlanNudge — PR-12 cron-suppression guards", () => {
  it("PR-12 Bug A2: returns null when planMode.approval === 'pending'", () => {
    // Pending approval card is on screen — firing a nudge here would
    // interrupt the user's resolve-the-card flow. Suppressed.
    const out = buildActivePlanNudge(
      makePlanMode({
        approval: "pending",
        approvalId: "abc",
        updatedAt: 0, // ancient — would otherwise pass the idle guard
        lastPlanSteps: [{ step: "X", status: "in_progress" }],
      }),
    );
    expect(out).toBeNull();
  });

  it("PR-12 Bug A3: returns null when agent was active in the idle window (default 5 min)", () => {
    // updatedAt < 5 minutes ago → suppress.
    const now = 1_000_000;
    const out = buildActivePlanNudge(
      makePlanMode({
        approval: "approved",
        updatedAt: now - 60_000, // 1 minute ago
        lastPlanSteps: [{ step: "X", status: "in_progress" }],
      }),
      { nowMs: now },
    );
    expect(out).toBeNull();
  });

  it("PR-12 Bug A3: fires when idle window is exceeded", () => {
    const now = 1_000_000;
    const out = buildActivePlanNudge(
      makePlanMode({
        approval: "approved",
        updatedAt: now - 10 * 60_000, // 10 minutes ago
        lastPlanSteps: [{ step: "X", status: "in_progress" }],
      }),
      { nowMs: now },
    );
    expect(out).not.toBeNull();
  });

  it("PR-12 Bug A3: idleThresholdMs=0 disables the idle guard", () => {
    const now = 1_000_000;
    const out = buildActivePlanNudge(
      makePlanMode({
        approval: "approved",
        updatedAt: now - 1, // basically just-now
        lastPlanSteps: [{ step: "X", status: "in_progress" }],
      }),
      { nowMs: now, idleThresholdMs: 0 },
    );
    expect(out).not.toBeNull();
  });

  it("PR-12 Bug A3: missing updatedAt does NOT count as 'recently active' (degrades to allowed)", () => {
    // If updatedAt is unset (legacy entry, never advanced), don't
    // suppress — otherwise legacy plans would never get nudges.
    const now = 1_000_000;
    const out = buildActivePlanNudge(
      makePlanMode({
        approval: "approved",
        updatedAt: undefined,
        lastPlanSteps: [{ step: "X", status: "in_progress" }],
      }),
      { nowMs: now },
    );
    expect(out).not.toBeNull();
  });
});
