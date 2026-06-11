import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendSelfImprovementAuditEvent, listSelfImprovementAuditEvents } from "./audit-events.js";
import {
  buildSelfImprovementOperationalHealth,
  listSelfImprovementOperationalHealthSnapshots,
  resolveSelfImprovementOperationalHealthStorePath,
  writeSelfImprovementOperationalHealthSnapshot,
} from "./operational-health.js";
import { upsertSelfImprovementRecommendations } from "./store.js";
import { summarizeSelfImprovementRecommendations } from "./summary.js";
import type {
  SelfImprovementAuditEvent,
  SelfImprovementProposal,
  SelfImprovementRecommendation,
} from "./types.js";

const now = Date.parse("2026-05-07T12:00:00.000Z");

let tmpDir: string;

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
    title: "Recommendation",
    summary: "Summary",
    category: "efficiency_opportunity",
    severity: "medium",
    criticality: "medium",
    priority: "medium",
    impact: "medium",
    effort: "medium",
    confidence: 0.8,
    groupKey: "efficiency_opportunity:workflow:recommendation",
    groupTitle: "Recommendation",
    recurrenceCount: 1,
    source: { kind: "workflow", label: "Workflow" },
    route: {
      role: "builder",
      targetAgentId: "builder-agent",
      targetAgentLabel: "Builder Agent",
      reason: "Implementation proposal.",
    },
    recommendedAction: "Inspect and propose.",
    requiredEvidence: ["Attach proof."],
    safety: {
      mode: "recommendation_only",
      mutationAllowed: false,
      requiresApproval: false,
      requiresTests: false,
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
    evidence: ["Evidence."],
    ...overrides,
  };
}

function proposal(overrides: Partial<SelfImprovementProposal> = {}): SelfImprovementProposal {
  return {
    id: "sip_test",
    createdAt: now - 60_000,
    updatedAt: now - 60_000,
    status: "pending",
    kind: "implementation",
    groupId: "sig_test",
    groupKey: "efficiency_opportunity:workflow:recommendation",
    title: "Implementation proposal",
    summary: "Proposal summary",
    route: {
      role: "builder",
      targetAgentId: "builder-agent",
      targetAgentLabel: "Builder Agent",
      reason: "Implementation proposal.",
    },
    sourceRecommendationIds: ["sir_test"],
    recommendedAction: "Inspect and propose.",
    requiredEvidence: ["Attach proof."],
    safetyNotes: ["Recommendation-only."],
    approvalRequired: false,
    testsRequired: false,
    analysisMode: "deterministic",
    ...overrides,
  };
}

function event(overrides: Partial<SelfImprovementAuditEvent>): SelfImprovementAuditEvent {
  return {
    id: overrides.id ?? `sie_${String(overrides.kind ?? "event")}`,
    createdAt: overrides.createdAt ?? now,
    kind: overrides.kind ?? "background_cycle",
    actor: overrides.actor ?? "governor",
    targetId: overrides.targetId ?? "self-improvement",
    summary: overrides.summary ?? "event",
    ...(overrides.metadata ? { metadata: overrides.metadata } : {}),
  };
}

function healthFor(params: {
  recommendations?: SelfImprovementRecommendation[];
  proposals?: SelfImprovementProposal[];
  auditEvents?: SelfImprovementAuditEvent[];
}) {
  const recommendations = params.recommendations ?? [recommendation()];
  const scorecard = summarizeSelfImprovementRecommendations({ recommendations, now }).scorecard;
  return buildSelfImprovementOperationalHealth({
    recommendations,
    scorecard,
    proposals: params.proposals ?? [],
    auditEvents: params.auditEvents ?? [
      event({
        kind: "background_cycle",
        metadata: { success: true },
      }),
    ],
    now,
    env: { OPENCLAW_SELF_IMPROVEMENT_INTERVAL_MS: String(6 * 60 * 60_000) },
  }).current;
}

describe("self-improvement operational health", () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-self-improvement-health-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("reports ready health when core operational signals are fresh", () => {
    const health = healthFor({});

    expect(health).toMatchObject({
      status: "ready",
      trend: "unknown",
    });
    expect(health.score).toBeGreaterThanOrEqual(90);
    expect(health.dimensions.map((dimension) => dimension.id)).toEqual([
      "recommendations",
      "reviewer",
      "models",
      "background",
      "proposals",
      "verification",
      "intelligence",
    ]);
  });

  it("degrades or blocks on high-risk improvement intelligence pressure", () => {
    const health = healthFor({
      recommendations: [
        recommendation({
          id: "sir_major_change",
          fingerprint: "fingerprint-major-change",
          title: "Major agentless runtime change needs option framing",
          groupTitle: "Major agentless runtime change needs option framing",
          groupKey: "major_change:workflow:agentless-runtime",
          category: "major_change",
          priority: "critical",
          severity: "critical",
          criticality: "critical",
          source: { kind: "workflow", label: "Agentless runtime option" },
          route: {
            role: "program_manager",
            targetAgentId: "program-manager",
            targetAgentLabel: "Program Manager",
            reason: "Sequencing and prioritization.",
          },
          safety: {
            mode: "recommendation_only",
            mutationAllowed: false,
            requiresApproval: true,
            requiresTests: true,
            blockedActions: ["no direct merge, push, or release"],
          },
        }),
      ],
    });
    const intelligence = health.dimensions.find((dimension) => dimension.id === "intelligence");

    expect(health.status).toBe("blocked");
    expect(intelligence).toMatchObject({
      status: "blocked",
      metrics: expect.arrayContaining([
        { key: "majorChangeCandidates", label: "Major changes", value: 1 },
      ]),
    });
    expect(intelligence?.blockers.join(" ")).toContain("critical major-change");
  });

  it("treats assigned intelligence and outcome opportunities as controlled", () => {
    const health = healthFor({
      recommendations: [
        recommendation({
          id: "sir_instruction",
          fingerprint: "fingerprint-instruction",
          status: "assigned",
          assignedTargetAgentId: "memory-knowledge-curator",
          title: "Repeated instruction-adherence misses need procedural memory",
          groupTitle: "Repeated instruction-adherence misses need procedural memory",
          groupKey: "instruction_adherence:instruction:procedural-memory",
          category: "instruction_adherence",
          priority: "high",
          severity: "high",
          criticality: "high",
          route: {
            role: "memory_curator",
            targetAgentId: "memory-knowledge-curator",
            targetAgentLabel: "Memory/Knowledge Curator",
            reason: "Memory and skill curation.",
          },
          safety: {
            mode: "recommendation_only",
            mutationAllowed: false,
            requiresApproval: true,
            requiresTests: false,
            blockedActions: ["no direct merge, push, or release"],
          },
        }),
        recommendation({
          id: "sir_outcome",
          fingerprint: "fingerprint-outcome",
          status: "assigned",
          assignedTargetAgentId: "main",
          title: "Outcome measurement gap needs a daily improvement metric",
          groupTitle: "Outcome measurement gap needs a daily improvement metric",
          groupKey: "outcome_measurement:outcome:daily-metric",
          category: "outcome_measurement",
          priority: "medium",
          severity: "medium",
          criticality: "medium",
          route: {
            role: "todd",
            targetAgentId: "main",
            targetAgentLabel: "Todd Stanski",
            reason: "User-facing synthesis and prioritization.",
          },
        }),
      ],
    });
    const intelligence = health.dimensions.find((dimension) => dimension.id === "intelligence");

    expect(health.status).toBe("ready");
    expect(intelligence).toMatchObject({
      status: "ready",
      metrics: expect.arrayContaining([
        { key: "intelligenceHighCritical", label: "High/critical", value: 1 },
        { key: "outcomeMetricGaps", label: "Metric gaps", value: 1 },
      ]),
    });
  });

  it("degrades for stale reviewer evals and stale pending proposals", () => {
    const health = healthFor({
      proposals: [proposal({ updatedAt: now - 8 * 24 * 60 * 60_000 })],
      auditEvents: [
        event({
          kind: "background_cycle",
          metadata: { success: true },
        }),
        event({
          kind: "reviewer_eval_run",
          createdAt: now - 25 * 60 * 60_000,
          metadata: { readiness: "ready", ready: true },
        }),
      ],
    });

    expect(health.status).toBe("degraded");
    expect(health.dimensions.find((dimension) => dimension.id === "reviewer")?.status).toBe(
      "degraded",
    );
    expect(health.dimensions.find((dimension) => dimension.id === "proposals")?.status).toBe(
      "degraded",
    );
  });

  it("degrades and blocks for memory/skill curator workflow gaps", () => {
    const degraded = healthFor({
      proposals: [
        proposal({
          id: "sip_memory_pending",
          kind: "memory_skill",
          route: {
            role: "memory_curator",
            targetAgentId: "memory-knowledge-curator",
            targetAgentLabel: "Memory/Knowledge Curator",
            reason: "Memory and skill curation.",
          },
          curatorStatus: "accepted_for_workshop",
          curatorProof: "Reviewed for pending workshop mode.",
        }),
      ],
    });
    const degradedProposals = degraded.dimensions.find((dimension) => dimension.id === "proposals");

    expect(degradedProposals?.status).toBe("degraded");
    expect(degradedProposals?.metrics).toEqual(
      expect.arrayContaining([
        { key: "curatorAcceptedUnlinked", label: "Accepted unlinked", value: 1 },
      ]),
    );

    const blocked = healthFor({
      proposals: [
        proposal({
          id: "sip_memory_quarantined",
          kind: "memory_skill",
          route: {
            role: "memory_curator",
            targetAgentId: "memory-knowledge-curator",
            targetAgentLabel: "Memory/Knowledge Curator",
            reason: "Memory and skill curation.",
          },
          curatorStatus: "accepted_for_workshop",
          workshopProposalId: "swp_memory_1",
          workshopProposalStatus: "quarantined",
        }),
      ],
    });
    const blockedProposals = blocked.dimensions.find((dimension) => dimension.id === "proposals");

    expect(blocked.status).toBe("blocked");
    expect(blockedProposals?.status).toBe("blocked");
    expect(blockedProposals?.metrics).toEqual(
      expect.arrayContaining([{ key: "curatorQuarantined", label: "Quarantined", value: 1 }]),
    );
  });

  it("blocks for stale background cycles and unrouted critical recommendations", () => {
    const health = healthFor({
      recommendations: [
        recommendation({
          priority: "critical",
          severity: "critical",
          criticality: "critical",
          route: {
            role: "builder",
            targetAgentId: "",
            targetAgentLabel: "Builder Agent",
            reason: "Implementation proposal.",
          },
          requiredEvidence: [],
        }),
      ],
      auditEvents: [
        event({
          kind: "background_cycle",
          createdAt: now - 13 * 60 * 60_000,
          metadata: { success: true },
        }),
      ],
    });

    expect(health.status).toBe("blocked");
    expect(health.dimensions.find((dimension) => dimension.id === "background")?.status).toBe(
      "blocked",
    );
    expect(health.dimensions.find((dimension) => dimension.id === "recommendations")?.status).toBe(
      "blocked",
    );
  });

  it("keeps fresh assigned proof-missing recommendations healthy and degrades stale verification", () => {
    const proofMissingHealth = healthFor({
      recommendations: [
        recommendation({
          status: "assigned",
          assignedTargetAgentId: "qa-test-agent",
          priority: "high",
          severity: "high",
          criticality: "high",
          safety: {
            mode: "recommendation_only",
            mutationAllowed: false,
            requiresApproval: true,
            requiresTests: true,
            blockedActions: ["no direct merge, push, or release"],
          },
        }),
      ],
    });
    const proofMissingVerification = proofMissingHealth.dimensions.find(
      (dimension) => dimension.id === "verification",
    );

    expect(proofMissingHealth.status).toBe("ready");
    expect(proofMissingVerification?.status).toBe("ready");
    expect(proofMissingVerification?.metrics).toEqual(
      expect.arrayContaining([{ key: "proofMissing", label: "Proof missing", value: 1 }]),
    );

    const staleHealth = healthFor({
      recommendations: [
        recommendation({
          status: "assigned",
          assignedTargetAgentId: "qa-test-agent",
          updatedAt: now - 4 * 24 * 60 * 60_000,
          lastSeenAt: now - 4 * 24 * 60 * 60_000,
          priority: "medium",
          severity: "medium",
          criticality: "medium",
          safety: {
            mode: "recommendation_only",
            mutationAllowed: false,
            requiresApproval: true,
            requiresTests: true,
            blockedActions: ["no direct merge, push, or release"],
          },
        }),
      ],
    });
    const staleVerification = staleHealth.dimensions.find(
      (dimension) => dimension.id === "verification",
    );

    expect(staleHealth.status).toBe("degraded");
    expect(staleVerification?.status).toBe("degraded");
    expect(staleVerification?.blockers.join(" ")).toContain("test-required");

    const readyHealth = healthFor({
      recommendations: [
        recommendation({
          status: "assigned",
          priority: "high",
          severity: "high",
          criticality: "high",
          assignedTargetAgentId: "qa-test-agent",
          resolutionProof: "pnpm test src/self-improvement/actionability.test.ts passed",
          safety: {
            mode: "recommendation_only",
            mutationAllowed: false,
            requiresApproval: true,
            requiresTests: true,
            blockedActions: ["no direct merge, push, or release"],
          },
        }),
      ],
    });
    const readyVerification = readyHealth.dimensions.find(
      (dimension) => dimension.id === "verification",
    );

    expect(readyVerification?.status).toBe("ready");
    expect(readyVerification?.metrics).toEqual(
      expect.arrayContaining([{ key: "readyToResolve", label: "Ready to resolve", value: 1 }]),
    );
  });

  it("writes bounded health snapshots and sanitized audit events", async () => {
    await upsertSelfImprovementRecommendations({
      stateDir: tmpDir,
      recommendations: [recommendation()],
    });
    await appendSelfImprovementAuditEvent({
      stateDir: tmpDir,
      event: {
        createdAt: now,
        actor: "governor",
        kind: "background_cycle",
        targetId: "self-improvement-background",
        summary: "Completed /Users/openclaw/openclaw background cycle.",
        metadata: { success: true },
      },
    });

    const snapshot = await writeSelfImprovementOperationalHealthSnapshot({
      stateDir: tmpDir,
      now,
      env: { OPENCLAW_SELF_IMPROVEMENT_INTERVAL_MS: String(6 * 60 * 60_000) },
    });

    expect(snapshot.health.status).toBe("ready");
    const snapshots = await listSelfImprovementOperationalHealthSnapshots({
      stateDir: tmpDir,
      limit: 5,
    });
    expect(snapshots).toHaveLength(1);
    const [audit] = await listSelfImprovementAuditEvents({
      stateDir: tmpDir,
      kind: "operational_health_snapshot",
    });
    expect(audit).toMatchObject({
      kind: "operational_health_snapshot",
      targetId: "self-improvement-health",
      metadata: { status: "ready", score: snapshot.health.score },
    });

    const raw = await fs.readFile(resolveSelfImprovementOperationalHealthStorePath(tmpDir), "utf8");
    expect(raw).not.toContain("/Users/openclaw");
  });
});
