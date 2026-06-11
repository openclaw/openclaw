import { describe, expect, it } from "vitest";
import { summarizeSelfImprovementRecommendations } from "./summary.js";
import type { SelfImprovementRecommendation } from "./types.js";

const now = Date.parse("2026-05-07T12:00:00.000Z");

function recommendation(
  overrides: Partial<SelfImprovementRecommendation> = {},
): SelfImprovementRecommendation {
  return {
    id: overrides.id ?? "sir_test",
    fingerprint: overrides.fingerprint ?? "fingerprint",
    createdAt: now - 60_000,
    updatedAt: now - 30_000,
    lastSeenAt: now,
    status: "open",
    title: "Failed dashboard smoke needs QA review",
    summary: "The dashboard smoke failed.",
    category: "smoke_failure",
    severity: "high",
    criticality: "high",
    priority: "high",
    impact: "high",
    effort: "medium",
    confidence: 0.8,
    groupKey: "smoke_failure:task_group:dashboard-smoke",
    groupTitle: "Dashboard smoke failures",
    recurrenceCount: 1,
    source: { kind: "task", label: "dashboard smoke", taskId: "task-1" },
    route: {
      role: "qa",
      targetAgentId: "qa-test-agent",
      targetAgentLabel: "QA Test Agent",
      reason: "Verification gap, smoke failure, or test-proof follow-up.",
    },
    recommendedAction: "Rerun the smoke.",
    requiredEvidence: ["Rerun the smoke."],
    safety: {
      mode: "recommendation_only",
      mutationAllowed: false,
      requiresApproval: true,
      requiresTests: true,
      blockedActions: ["no direct merge, push, or release"],
    },
    analysis: {
      mode: "deterministic",
      summary: "Evidence-bound recommendation analysis.",
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

describe("summarizeSelfImprovementRecommendations", () => {
  it("groups related recommendations and builds the scorecard", () => {
    const result = summarizeSelfImprovementRecommendations({
      now,
      recommendations: [
        recommendation(),
        recommendation({
          id: "sir_second",
          fingerprint: "fingerprint-2",
          source: { kind: "task", label: "dashboard smoke", taskId: "task-2" },
          recurrenceCount: 2,
          evidence: ["Task task-2 status: failed"],
        }),
        recommendation({
          id: "sir_resolved",
          fingerprint: "fingerprint-3",
          groupKey: "task_reliability:task:old",
          groupTitle: "Old issue",
          title: "Old issue",
          status: "resolved",
          updatedAt: now - 1_000,
          safety: {
            mode: "recommendation_only",
            mutationAllowed: false,
            requiresApproval: false,
            requiresTests: false,
            blockedActions: [],
          },
        }),
      ],
    });

    expect(result.totalGroups).toBe(1);
    expect(result.groups[0]).toMatchObject({
      title: "Dashboard smoke failures",
      count: 3,
      requiresTests: true,
      requiresApproval: true,
      route: { role: "qa" },
    });
    expect(result.scorecard).toMatchObject({
      totalRecommendations: 3,
      activeRecommendations: 2,
      groupedRecommendations: 1,
      highOpen: 2,
      testRequired: 2,
      approvalRequired: 2,
      resolvedLast24h: 1,
    });
    expect(result.scorecard.needsApproval[0]?.title).toBe("Dashboard smoke failures");
    expect(result.actionQueue).toMatchObject({
      total: 1,
      unassigned: 1,
      proofMissing: 1,
      readyToResolve: 0,
    });
    expect(result.groups[0]?.actionability).toMatchObject({
      ownerState: "unassigned",
      proofState: "missing",
      closureState: "blocked",
    });
  });

  it("builds an improvement-intelligence summary from active opportunity groups", () => {
    const result = summarizeSelfImprovementRecommendations({
      now,
      recommendations: [
        recommendation({
          id: "sir_efficiency",
          fingerprint: "fingerprint-efficiency",
          title: "Repeated verification workflow can be simplified",
          groupTitle: "Repeated verification workflow can be simplified",
          groupKey: "workflow_simplification:workflow:verification",
          category: "workflow_simplification",
          priority: "high",
          severity: "high",
          criticality: "high",
          source: { kind: "workflow", label: "Verification workflow" },
          route: {
            role: "program_manager",
            targetAgentId: "program-manager",
            targetAgentLabel: "Program Manager",
            reason: "Sequencing and prioritization.",
          },
          recommendedAction: "Sequence a simplification proposal with parity proof.",
        }),
        recommendation({
          id: "sir_instruction",
          fingerprint: "fingerprint-instruction",
          title: "Repeated instruction-adherence misses need procedural memory",
          groupTitle: "Repeated instruction-adherence misses need procedural memory",
          groupKey: "instruction_adherence:instruction:repo-rules",
          category: "instruction_adherence",
          priority: "medium",
          severity: "medium",
          criticality: "medium",
          source: { kind: "instruction", label: "Repo rules" },
          route: {
            role: "memory_curator",
            targetAgentId: "memory-knowledge-curator",
            targetAgentLabel: "Memory/Knowledge Curator",
            reason: "Procedural memory review.",
          },
        }),
      ],
    });

    expect(result.scorecard.intelligence).toEqual(
      expect.objectContaining({
        total: 2,
        highCritical: 1,
        requiresApproval: 2,
      }),
    );
    expect(result.scorecard.intelligence?.topOpportunities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "workflow_simplification",
          route: expect.objectContaining({ role: "program_manager" }),
        }),
      ]),
    );
    expect(result.scorecard.intelligence?.instructionThemes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: "instruction_adherence",
          route: expect.objectContaining({ role: "memory_curator" }),
        }),
      ]),
    );
    expect(result.scorecard.intelligence?.simplificationCandidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "Repeated verification workflow can be simplified",
        }),
      ]),
    );
  });
});
