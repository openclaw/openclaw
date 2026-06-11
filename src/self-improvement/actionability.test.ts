import { describe, expect, it } from "vitest";
import {
  buildSelfImprovementActionQueue,
  deriveSelfImprovementGroupActionability,
  deriveSelfImprovementRecommendationActionability,
} from "./actionability.js";
import type { SelfImprovementRecommendation, SelfImprovementRecommendationGroup } from "./types.js";

const now = Date.parse("2026-06-06T12:00:00.000Z");
const day = 24 * 60 * 60_000;

function recommendation(
  overrides: Partial<SelfImprovementRecommendation> = {},
): SelfImprovementRecommendation {
  return {
    id: overrides.id ?? "sir_action",
    fingerprint: overrides.fingerprint ?? "fingerprint",
    createdAt: now - 4 * day,
    updatedAt: now - 4 * day,
    lastSeenAt: now - 4 * day,
    status: "open",
    title: "Verify repeated dashboard smoke failures",
    summary: "Dashboard smoke failed repeatedly.",
    category: "smoke_failure",
    severity: "high",
    criticality: "high",
    priority: "high",
    impact: "high",
    effort: "medium",
    confidence: 0.82,
    groupKey: "smoke_failure:task_group:dashboard",
    groupTitle: "Dashboard smoke failures",
    recurrenceCount: 1,
    source: { kind: "task", label: "dashboard smoke", taskId: "task-1" },
    route: {
      role: "qa",
      targetAgentId: "qa-test-agent",
      targetAgentLabel: "QA Test Agent",
      reason: "Verification gap.",
    },
    recommendedAction: "Rerun dashboard smoke.",
    requiredEvidence: ["Rerun dashboard smoke."],
    safety: {
      mode: "recommendation_only",
      mutationAllowed: false,
      requiresApproval: true,
      requiresTests: true,
      blockedActions: ["no direct merge, push, or release"],
    },
    analysis: {
      mode: "deterministic",
      summary: "Evidence-bound analysis.",
      generatedAt: now,
      confidence: 0.8,
      promptVersion: "self-improvement-deterministic-v1",
      evidenceCount: 1,
      safetyNotes: ["Recommendation-only."],
    },
    evidence: ["Task task-1 status: failed"],
    ...overrides,
  };
}

function group(
  overrides: Partial<SelfImprovementRecommendationGroup> = {},
): SelfImprovementRecommendationGroup {
  return {
    id: "sig_action",
    groupKey: "smoke_failure:task_group:dashboard",
    title: "Dashboard smoke failures",
    category: "smoke_failure",
    severity: "high",
    criticality: "high",
    priority: "high",
    status: "assigned",
    route: {
      role: "qa",
      targetAgentId: "qa-test-agent",
      targetAgentLabel: "QA Test Agent",
      reason: "Verification gap.",
    },
    count: 2,
    open: 0,
    acknowledged: 0,
    assigned: 2,
    inProgress: 0,
    reopened: 0,
    quarantined: 0,
    resolved: 0,
    dismissed: 0,
    requiresTests: true,
    requiresApproval: true,
    firstSeenAt: now - day,
    lastSeenAt: now,
    lastUpdatedAt: now - 2 * day,
    recommendationIds: ["sir_action"],
    topEvidence: ["Task task-1 status: failed"],
    recommendedAction: "Rerun dashboard smoke.",
    analysis: {
      mode: "deterministic",
      summary: "Evidence-bound analysis.",
      generatedAt: now,
      confidence: 0.8,
      promptVersion: "self-improvement-deterministic-v1",
      evidenceCount: 1,
      safetyNotes: ["Recommendation-only."],
    },
    ...overrides,
  };
}

describe("Self-Improvement actionability", () => {
  it("marks unassigned overdue proof-required recommendations as blocked", () => {
    const actionability = deriveSelfImprovementRecommendationActionability(recommendation(), now);

    expect(actionability).toMatchObject({
      ownerState: "unassigned",
      slaState: "overdue",
      proofState: "missing",
      closureState: "blocked",
    });
    expect(actionability.blockers).toContain("No owner assigned.");
    expect(actionability.blockers).toContain("SLA is overdue.");
    expect(actionability.blockers).toContain("Resolution proof is missing.");
    expect(actionability.nextAction).toContain("Assign");
  });

  it("marks claimed proof-attached recommendations ready to resolve", () => {
    const actionability = deriveSelfImprovementRecommendationActionability(
      recommendation({
        status: "in_progress",
        claimedBy: "QA Test Agent",
        resolutionProof: "pnpm test ui/src/ui/views/agents.test.ts passed",
        updatedAt: now - 60_000,
        lastSeenAt: now - 60_000,
      }),
      now,
    );

    expect(actionability).toMatchObject({
      ownerState: "claimed",
      slaState: "fresh",
      proofState: "attached",
      closureState: "ready_to_resolve",
    });
    expect(actionability.rank).toBeGreaterThan(0);
  });

  it("derives group actionability from existing recommendation ownership and proof", () => {
    const rec = recommendation({
      status: "assigned",
      assignedTargetAgentId: "qa-test-agent",
      resolutionProof: "pnpm test passed",
      updatedAt: now - day,
      lastSeenAt: now - day,
    });
    const actionability = deriveSelfImprovementGroupActionability(group(), [rec], now);

    expect(actionability.ownerState).toBe("assigned");
    expect(actionability.proofState).toBe("attached");
    expect(actionability.closureState).toBe("ready_to_resolve");
  });

  it("prioritizes overdue and proof-missing items in the action queue", () => {
    const queue = buildSelfImprovementActionQueue({
      now,
      recommendations: [
        recommendation({
          id: "sir_blocked",
          priority: "critical",
          severity: "critical",
          criticality: "critical",
        }),
        recommendation({
          id: "sir_ready",
          status: "assigned",
          assignedTargetAgentId: "builder-agent",
          resolutionProof: "pnpm test passed",
          updatedAt: now - 60_000,
          lastSeenAt: now - 60_000,
        }),
      ],
    });

    expect(queue.total).toBe(2);
    expect(queue.unassigned).toBe(1);
    expect(queue.proofMissing).toBe(1);
    expect(queue.readyToResolve).toBe(1);
    expect(queue.items[0]?.id).toBe("sir_blocked");
  });
});
