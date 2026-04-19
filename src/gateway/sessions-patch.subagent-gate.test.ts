/**
 * Live-test iteration 1 Bug 3: approval-side subagent gate.
 *
 * The tool-side gate at `src/agents/tools/exit-plan-mode-tool.ts:230`
 * blocks the plan submission when subagents are open at submission
 * time. But that check fires ONCE — if a NEW subagent is spawned
 * during the user's approval window (between the approval card showing
 * and the user clicking Approve), the original gate is irrelevant and
 * the approval would proceed against in-flight subagents.
 *
 * This suite validates the second-line defense: `sessions.patch
 * { planApproval: { action: "approve" | "edit" } }` rejects when the
 * parent run's `openSubagentRunIds` is non-empty, with the error code
 * `PLAN_APPROVAL_BLOCKED_BY_SUBAGENTS` so the UI can route the error
 * to a bottom-of-chat fallback toast (see `chat.ts` toast region).
 *
 * `reject` is intentionally NOT gated — the user can always reject a
 * plan regardless of subagent state.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import { clearAgentRunContext, registerAgentRunContext } from "../infra/agent-events.js";
import { ErrorCodes } from "./protocol/index.js";
import { applySessionsPatchToStore } from "./sessions-patch.js";

const PLAN_MODE_CFG = {
  agents: { defaults: { planMode: { enabled: true } } },
} as unknown as OpenClawConfig;
const SESSION_KEY = "agent:main:main";
const APPROVAL_RUN_ID = "test-run-approval-gate";

function makePendingPlanModeStore(overrides?: Partial<SessionEntry>): Record<string, SessionEntry> {
  return {
    [SESSION_KEY]: {
      sessionId: "session-1",
      updatedAt: 1_000,
      ...overrides,
      planMode: {
        mode: "plan",
        approval: "pending",
        rejectionCount: 0,
        approvalId: "plan-approval-1",
        approvalRunId: APPROVAL_RUN_ID,
        title: "Test plan",
        ...overrides?.planMode,
      },
    },
  };
}

describe("sessions.patch planApproval — subagent gate (Bug 3)", () => {
  beforeEach(() => {
    clearAgentRunContext(APPROVAL_RUN_ID);
  });
  afterEach(() => {
    clearAgentRunContext(APPROVAL_RUN_ID);
  });

  it("approve with no open subagents → succeeds", async () => {
    registerAgentRunContext(APPROVAL_RUN_ID, { openSubagentRunIds: new Set() });
    const result = await applySessionsPatchToStore({
      cfg: PLAN_MODE_CFG,
      store: makePendingPlanModeStore(),
      storeKey: SESSION_KEY,
      patch: {
        key: SESSION_KEY,
        planApproval: { action: "approve", approvalId: "plan-approval-1" },
      },
    });
    expect(result.ok).toBe(true);
  });

  it("approve with 1+ open subagents → throws PLAN_APPROVAL_BLOCKED_BY_SUBAGENTS", async () => {
    registerAgentRunContext(APPROVAL_RUN_ID, {
      openSubagentRunIds: new Set(["child-run-abc"]),
    });
    const result = await applySessionsPatchToStore({
      cfg: PLAN_MODE_CFG,
      store: makePendingPlanModeStore(),
      storeKey: SESSION_KEY,
      patch: {
        key: SESSION_KEY,
        planApproval: { action: "approve", approvalId: "plan-approval-1" },
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected failure");
    }
    expect(result.error.code).toBe(ErrorCodes.PLAN_APPROVAL_BLOCKED_BY_SUBAGENTS);
    expect(result.error.message).toContain("child-run-abc");
    expect((result.error.details as { openSubagentRunIds?: string[] }).openSubagentRunIds).toEqual([
      "child-run-abc",
    ]);
  });

  it("edit action with open subagents → also throws (same gate as approve)", async () => {
    registerAgentRunContext(APPROVAL_RUN_ID, {
      openSubagentRunIds: new Set(["child-run-1", "child-run-2"]),
    });
    const result = await applySessionsPatchToStore({
      cfg: PLAN_MODE_CFG,
      store: makePendingPlanModeStore(),
      storeKey: SESSION_KEY,
      patch: {
        key: SESSION_KEY,
        planApproval: { action: "edit", approvalId: "plan-approval-1" },
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected failure");
    }
    expect(result.error.code).toBe(ErrorCodes.PLAN_APPROVAL_BLOCKED_BY_SUBAGENTS);
  });

  it("reject action with open subagents → DOES NOT throw (user can always reject)", async () => {
    registerAgentRunContext(APPROVAL_RUN_ID, {
      openSubagentRunIds: new Set(["child-run-stuck"]),
    });
    const result = await applySessionsPatchToStore({
      cfg: PLAN_MODE_CFG,
      store: makePendingPlanModeStore(),
      storeKey: SESSION_KEY,
      patch: {
        key: SESSION_KEY,
        planApproval: {
          action: "reject",
          approvalId: "plan-approval-1",
          feedback: "not what I wanted",
        },
      },
    });
    expect(result.ok).toBe(true);
  });

  it("approval gate falls through when approvalRunId is not stored (legacy path)", async () => {
    // No approvalRunId on planMode → gate can't look up subagents → falls
    // through. Prevents legacy plans (created before Bug 3 wiring landed)
    // from being permanently un-approvable.
    const store = makePendingPlanModeStore();
    delete (store[SESSION_KEY].planMode as { approvalRunId?: string }).approvalRunId;
    const result = await applySessionsPatchToStore({
      cfg: PLAN_MODE_CFG,
      store,
      storeKey: SESSION_KEY,
      patch: {
        key: SESSION_KEY,
        planApproval: { action: "approve", approvalId: "plan-approval-1" },
      },
    });
    expect(result.ok).toBe(true);
  });

  it("approval gate falls through when ctx is not registered (run already ended)", async () => {
    // approvalRunId points to a run whose context was cleaned up — gate
    // falls through (no ctx → no openSubagentRunIds → can't gate).
    const result = await applySessionsPatchToStore({
      cfg: PLAN_MODE_CFG,
      store: makePendingPlanModeStore(),
      storeKey: SESSION_KEY,
      patch: {
        key: SESSION_KEY,
        planApproval: { action: "approve", approvalId: "plan-approval-1" },
      },
    });
    expect(result.ok).toBe(true);
  });

  it("error message lists up to 5 subagents + 'and N more' suffix", async () => {
    registerAgentRunContext(APPROVAL_RUN_ID, {
      openSubagentRunIds: new Set(["r1", "r2", "r3", "r4", "r5", "r6", "r7"]),
    });
    const result = await applySessionsPatchToStore({
      cfg: PLAN_MODE_CFG,
      store: makePendingPlanModeStore(),
      storeKey: SESSION_KEY,
      patch: {
        key: SESSION_KEY,
        planApproval: { action: "approve", approvalId: "plan-approval-1" },
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected failure");
    }
    expect(result.error.message).toMatch(/r1.*r2.*r3.*r4.*r5/);
    expect(result.error.message).toContain("and 2 more");
  });
});
