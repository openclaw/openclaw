import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendSelfImprovementAuditEvent,
  listSelfImprovementAuditEvents,
} from "../../self-improvement/audit-events.js";
import { upsertSelfImprovementProposals } from "../../self-improvement/proposals.js";
import { upsertSelfImprovementRecommendations } from "../../self-improvement/store.js";
import type {
  SelfImprovementProposal,
  SelfImprovementRecommendation,
} from "../../self-improvement/types.js";
import { selfImprovementHandlers } from "./self-improvement.js";
import type { GatewayRequestHandler } from "./types.js";

const now = Date.parse("2026-06-06T12:00:00.000Z");
const originalStateDir = process.env.OPENCLAW_STATE_DIR;
let tmpDir: string;

function recommendation(
  overrides: Partial<SelfImprovementRecommendation> = {},
): SelfImprovementRecommendation {
  return {
    id: overrides.id ?? "sir_gateway",
    fingerprint: overrides.fingerprint ?? "fingerprint",
    createdAt: now - 60_000,
    updatedAt: now - 30_000,
    lastSeenAt: now,
    status: "open",
    title: "Dashboard smoke needs proof",
    summary: "The dashboard smoke failed.",
    category: "smoke_failure",
    severity: "high",
    criticality: "high",
    priority: "high",
    impact: "high",
    effort: "medium",
    confidence: 0.8,
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
    recommendedAction: "Rerun the dashboard smoke.",
    requiredEvidence: ["Rerun the dashboard smoke."],
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

function proposal(overrides: Partial<SelfImprovementProposal> = {}): SelfImprovementProposal {
  return {
    id: "sip_memory",
    createdAt: now - 60_000,
    updatedAt: now - 60_000,
    status: "pending",
    kind: "memory_skill",
    groupId: "sig_memory",
    groupKey: "knowledge_hygiene:knowledge:memory",
    title: "Pending memory/skill proposal",
    summary: "Capture a repeated correction as a pending skill proposal.",
    route: {
      role: "memory_curator",
      targetAgentId: "memory-knowledge-curator",
      targetAgentLabel: "Memory/Knowledge Curator",
      reason: "Memory and skill curation.",
    },
    sourceRecommendationIds: ["sir_gateway"],
    recommendedAction: "Draft a pending Skill Workshop proposal.",
    requiredEvidence: ["Show the repeated correction source and workshop pending record."],
    safetyNotes: ["No uncontrolled memory or skill writes."],
    approvalRequired: true,
    testsRequired: false,
    analysisMode: "deterministic",
    ...overrides,
  };
}

async function callSelfImprovementHandler(method: string, params: Record<string, unknown>) {
  const handler = selfImprovementHandlers[method] as GatewayRequestHandler | undefined;
  if (!handler) {
    throw new Error(`missing handler ${method}`);
  }
  let response:
    | {
        ok: boolean;
        payload?: unknown;
        error?: { message?: string };
      }
    | undefined;
  await handler({
    req: { type: "req", id: "test", method, params },
    params,
    client: null,
    isWebchatConnect: () => false,
    respond: (ok, payload, error) => {
      response = { ok, payload, error };
    },
    context: {} as never,
  });
  if (!response) {
    throw new Error(`handler ${method} did not respond`);
  }
  return response;
}

describe("selfImprovement server methods", () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-self-improvement-gateway-"));
    process.env.OPENCLAW_STATE_DIR = tmpDir;
  });

  afterEach(async () => {
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("blocks proof-required recommendation resolution without proof", async () => {
    await upsertSelfImprovementRecommendations({
      stateDir: tmpDir,
      recommendations: [recommendation()],
    });

    const response = await callSelfImprovementHandler("selfImprovement.recommendations.update", {
      id: "sir_gateway",
      status: "resolved",
    });

    expect(response.ok).toBe(false);
    expect(response.error?.message).toContain("resolution proof is required");
  });

  it("requires dismissal reasons for recommendation closure", async () => {
    await upsertSelfImprovementRecommendations({
      stateDir: tmpDir,
      recommendations: [recommendation()],
    });

    const response = await callSelfImprovementHandler("selfImprovement.recommendations.update", {
      id: "sir_gateway",
      status: "dismissed",
    });

    expect(response.ok).toBe(false);
    expect(response.error?.message).toContain("dismissal reason is required");
  });

  it("returns actionability and sanitized audit metadata after proof updates", async () => {
    const proof = "pnpm test src/self-improvement/actionability.test.ts passed";
    await upsertSelfImprovementRecommendations({
      stateDir: tmpDir,
      recommendations: [recommendation()],
    });

    const response = await callSelfImprovementHandler("selfImprovement.recommendations.update", {
      id: "sir_gateway",
      status: "resolved",
      assignedTargetAgentId: "qa-test-agent",
      resolutionProof: proof,
    });

    expect(response.ok).toBe(true);
    expect(response.payload).toMatchObject({
      recommendation: {
        id: "sir_gateway",
        status: "resolved",
        actionability: {
          proofState: "attached",
          closureState: "closed",
        },
      },
    });
    const [audit] = await listSelfImprovementAuditEvents({
      stateDir: tmpDir,
      kind: "recommendation_status_updated",
    });
    expect(audit?.metadata).toMatchObject({
      status: "resolved",
      route: "qa",
      assignedTargetAgentId: "qa-test-agent",
      proofPresent: true,
    });
    expect(JSON.stringify(audit)).not.toContain(proof);
  });

  it("allows group resolution when existing proof is already attached", async () => {
    await upsertSelfImprovementRecommendations({
      stateDir: tmpDir,
      recommendations: [
        recommendation({
          status: "assigned",
          assignedTargetAgentId: "qa-test-agent",
          resolutionProof: "pnpm test src/self-improvement/summary.test.ts passed",
        }),
      ],
    });

    const response = await callSelfImprovementHandler("selfImprovement.groups.update", {
      id: "smoke_failure:task_group:dashboard",
      status: "resolved",
    });

    expect(response.ok).toBe(true);
    expect(response.payload).toMatchObject({
      group: {
        status: "resolved",
        actionability: {
          closureState: "closed",
        },
      },
    });
  });

  it("lists memory/skill curator proposals by curator status", async () => {
    await upsertSelfImprovementProposals({
      stateDir: tmpDir,
      proposals: [
        proposal(),
        proposal({
          id: "sip_builder",
          kind: "implementation",
          route: {
            role: "builder",
            targetAgentId: "builder-agent",
            targetAgentLabel: "Builder Agent",
            reason: "Implementation proposal.",
          },
        }),
      ],
    });

    const response = await callSelfImprovementHandler("selfImprovement.curator.list", {
      status: "pending_review",
    });

    expect(response.ok).toBe(true);
    expect(response.payload).toMatchObject({
      proposals: [{ id: "sip_memory", curatorStatus: "pending_review", kind: "memory_skill" }],
      total: 1,
    });
  });

  it("requires proof before accepting memory/skill curator proposals", async () => {
    await upsertSelfImprovementProposals({
      stateDir: tmpDir,
      proposals: [proposal()],
    });

    const response = await callSelfImprovementHandler("selfImprovement.curator.update", {
      id: "sip_memory",
      curatorStatus: "accepted_for_workshop",
    });

    expect(response.ok).toBe(false);
    expect(response.error?.message).toContain("curator proof is required");
  });

  it("updates curator status with workshop linkage and sanitized audit metadata", async () => {
    const proof = "Reviewed against Skill Workshop pending-mode rules.";
    await upsertSelfImprovementProposals({
      stateDir: tmpDir,
      proposals: [proposal()],
    });

    const response = await callSelfImprovementHandler("selfImprovement.curator.update", {
      id: "sip_memory",
      curatorStatus: "accepted_for_workshop",
      proof,
      workshopProposalId: "swp_memory_1",
      workshopProposalStatus: "pending",
    });

    expect(response.ok).toBe(true);
    expect(response.payload).toMatchObject({
      proposal: {
        id: "sip_memory",
        curatorStatus: "accepted_for_workshop",
        curatorProof: proof,
        workshopProposalId: "swp_memory_1",
      },
    });
    const [audit] = await listSelfImprovementAuditEvents({
      stateDir: tmpDir,
      kind: "curator_status_updated",
    });
    expect(audit?.metadata).toMatchObject({
      curatorStatus: "accepted_for_workshop",
      proposalKind: "memory_skill",
      route: "memory_curator",
      proofPresent: true,
      workshopProposalId: "swp_memory_1",
      workshopProposalStatus: "pending",
    });
    expect(JSON.stringify(audit)).not.toContain(proof);
  });

  it("blocks promotion through quarantined workshop proposals", async () => {
    await upsertSelfImprovementProposals({
      stateDir: tmpDir,
      proposals: [
        proposal({
          curatorStatus: "accepted_for_workshop",
          curatorProof: "Accepted after review.",
          workshopProposalId: "swp_memory_1",
          workshopProposalStatus: "quarantined",
        }),
      ],
    });

    const response = await callSelfImprovementHandler("selfImprovement.curator.update", {
      id: "sip_memory",
      curatorStatus: "promoted",
      proof: "Promotion evidence.",
    });

    expect(response.ok).toBe(false);
    expect(response.error?.message).toContain("non-quarantined Skill Workshop proposal link");
  });

  it("returns production-check readiness without mutating recommendations", async () => {
    await appendSelfImprovementAuditEvent({
      stateDir: tmpDir,
      event: {
        createdAt: now,
        actor: "governor",
        kind: "background_cycle",
        targetId: "self-improvement-background",
        summary: "Completed Self-Improvement background cycle.",
        metadata: { success: true },
      },
    });

    const response = await callSelfImprovementHandler("selfImprovement.productionCheck", {
      requireModelReady: true,
    });

    expect(response.ok).toBe(true);
    expect(response.payload).toMatchObject({
      status: "blocked",
      ready: false,
      requireModelReady: true,
      blockers: expect.arrayContaining([
        "Model readiness proof is required, but no model preflight event exists.",
      ]),
    });
  });

  it("runs retention maintenance apply through sanitized Gateway metadata", async () => {
    await upsertSelfImprovementRecommendations({
      stateDir: tmpDir,
      recommendations: [
        recommendation({
          id: "sir_old_closed",
          fingerprint: "old-closed",
          status: "resolved",
          updatedAt: now - 120 * 24 * 60 * 60_000,
          lastSeenAt: now - 120 * 24 * 60 * 60_000,
          resolutionProof: "token=secret-value",
        }),
      ],
    });

    const response = await callSelfImprovementHandler("selfImprovement.maintenance.run", {
      apply: true,
    });

    expect(response.ok).toBe(true);
    expect(response.payload).toMatchObject({
      applied: true,
      dryRun: false,
      stores: expect.arrayContaining([
        expect.objectContaining({
          store: "recommendations",
          pruned: 1,
        }),
      ]),
    });
    const [audit] = await listSelfImprovementAuditEvents({
      stateDir: tmpDir,
      kind: "retention_maintenance",
    });
    expect(audit?.metadata).toMatchObject({
      totalPruned: expect.any(Number),
    });
    expect(JSON.stringify(audit)).not.toContain("secret-value");
    expect(JSON.stringify(audit)).not.toContain("token=");
  });
});
