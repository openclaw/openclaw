import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildSelfImprovementProposalsFromGroups,
  listSelfImprovementProposals,
  resolveSelfImprovementProposalStorePath,
  updateSelfImprovementCuratorStatus,
  updateSelfImprovementProposalStatus,
  upsertSelfImprovementProposals,
} from "./proposals.js";
import type { SelfImprovementRecommendationGroup } from "./types.js";

const now = Date.parse("2026-05-07T12:00:00.000Z");
let tmpDir: string;

function group(
  overrides: Partial<SelfImprovementRecommendationGroup> = {},
): SelfImprovementRecommendationGroup {
  return {
    id: "sig_test",
    groupKey: "smoke_failure:task_group:dashboard-smoke",
    title: "Dashboard smoke failures",
    category: "smoke_failure",
    severity: "high",
    criticality: "high",
    priority: "high",
    status: "open",
    route: {
      role: "qa",
      targetAgentId: "qa-test-agent",
      targetAgentLabel: "QA Test Agent",
      reason: "Verification gap.",
    },
    count: 2,
    open: 1,
    acknowledged: 0,
    assigned: 0,
    inProgress: 0,
    reopened: 0,
    quarantined: 0,
    resolved: 0,
    dismissed: 0,
    requiresTests: true,
    requiresApproval: true,
    firstSeenAt: now,
    lastSeenAt: now,
    lastUpdatedAt: now,
    recommendationIds: ["sir_test"],
    topEvidence: ["Task task-1 status: failed"],
    recommendedAction: "Rerun the dashboard smoke.",
    analysis: {
      mode: "deterministic",
      summary: "One recommendation is ready for routed review.",
      generatedAt: now,
      confidence: 0.9,
      promptVersion: "self-improvement-deterministic-v1",
      evidenceCount: 1,
      safetyNotes: ["Recommendation-only."],
    },
    ...overrides,
  };
}

describe("self-improvement proposals", () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-self-improvement-proposals-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("builds routed pending proposals from grouped recommendations", () => {
    const proposals = buildSelfImprovementProposalsFromGroups({ groups: [group()], now });

    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      status: "pending",
      kind: "verification",
      route: { role: "qa" },
      approvalRequired: true,
      testsRequired: true,
    });
  });

  it("preserves operator status while refreshing proposal content", async () => {
    const [proposal] = buildSelfImprovementProposalsFromGroups({ groups: [group()], now });
    expect(proposal).toBeDefined();
    if (!proposal) {
      return;
    }
    await upsertSelfImprovementProposals({ stateDir: tmpDir, proposals: [proposal] });
    await updateSelfImprovementProposalStatus({
      stateDir: tmpDir,
      id: proposal.id,
      status: "acknowledged",
      note: "Queued for QA.",
      now: now + 1_000,
    });

    const [refreshed] = buildSelfImprovementProposalsFromGroups({
      groups: [group({ title: "Dashboard smoke failures updated" })],
      now: now + 2_000,
    });
    await upsertSelfImprovementProposals({ stateDir: tmpDir, proposals: [refreshed] });

    const proposals = await listSelfImprovementProposals({ stateDir: tmpDir });
    expect(proposals[0]).toMatchObject({
      status: "acknowledged",
      title: "Verification proposal: Dashboard smoke failures updated",
    });
    expect(proposals[0]?.safetyNotes).toContain("Queued for QA.");
  });

  it("defaults memory/skill proposals to pending curator review", async () => {
    const [proposal] = buildSelfImprovementProposalsFromGroups({
      groups: [
        group({
          category: "knowledge_hygiene",
          route: {
            role: "memory_curator",
            targetAgentId: "memory-knowledge-curator",
            targetAgentLabel: "Memory/Knowledge Curator",
            reason: "Memory and skill curation.",
          },
        }),
      ],
      now,
    });

    expect(proposal).toBeDefined();
    if (!proposal) {
      return;
    }
    expect(proposal.kind).toBe("memory_skill");
    expect(proposal.curatorStatus).toBeUndefined();
    await upsertSelfImprovementProposals({ stateDir: tmpDir, proposals: [proposal] });

    const proposals = await listSelfImprovementProposals({ stateDir: tmpDir });
    expect(proposals[0]).toMatchObject({
      kind: "memory_skill",
      curatorStatus: "pending_review",
    });
  });

  it("updates and preserves memory/skill curator status and workshop linkage", async () => {
    const [proposal] = buildSelfImprovementProposalsFromGroups({
      groups: [
        group({
          category: "knowledge_hygiene",
          route: {
            role: "memory_curator",
            targetAgentId: "memory-knowledge-curator",
            targetAgentLabel: "Memory/Knowledge Curator",
            reason: "Memory and skill curation.",
          },
        }),
      ],
      now,
    });
    expect(proposal).toBeDefined();
    if (!proposal) {
      return;
    }
    await upsertSelfImprovementProposals({ stateDir: tmpDir, proposals: [proposal] });
    await updateSelfImprovementCuratorStatus({
      stateDir: tmpDir,
      id: proposal.id,
      curatorStatus: "accepted_for_workshop",
      proof: "Reviewed against Skill Workshop pending-mode rules.",
      workshopProposalId: "swp_memory_1",
      workshopProposalStatus: "pending",
      now: now + 1_000,
    });

    const [refreshed] = buildSelfImprovementProposalsFromGroups({
      groups: [
        group({
          title: "Memory update proposal refreshed",
          category: "knowledge_hygiene",
          route: {
            role: "memory_curator",
            targetAgentId: "memory-knowledge-curator",
            targetAgentLabel: "Memory/Knowledge Curator",
            reason: "Memory and skill curation.",
          },
        }),
      ],
      now: now + 2_000,
    });
    await upsertSelfImprovementProposals({ stateDir: tmpDir, proposals: [refreshed] });

    const proposals = await listSelfImprovementProposals({ stateDir: tmpDir });
    expect(proposals[0]).toMatchObject({
      curatorStatus: "accepted_for_workshop",
      curatorProof: "Reviewed against Skill Workshop pending-mode rules.",
      workshopProposalId: "swp_memory_1",
      workshopProposalStatus: "pending",
      title: "Pending memory/skill proposal: Memory update proposal refreshed",
    });
  });

  it("redacts curator proof, promotion proof, and curator reasons", async () => {
    const [proposal] = buildSelfImprovementProposalsFromGroups({
      groups: [
        group({
          category: "knowledge_hygiene",
          route: {
            role: "memory_curator",
            targetAgentId: "memory-knowledge-curator",
            targetAgentLabel: "Memory/Knowledge Curator",
            reason: "Memory and skill curation.",
          },
        }),
      ],
      now,
    });
    expect(proposal).toBeDefined();
    if (!proposal) {
      return;
    }
    const unsafeToken = "abcdefghijklmnopqrstuvwxyz123456";
    await upsertSelfImprovementProposals({ stateDir: tmpDir, proposals: [proposal] });
    await updateSelfImprovementCuratorStatus({
      stateDir: tmpDir,
      id: proposal.id,
      curatorStatus: "needs_more_evidence",
      reason: `Needs review of /Users/openclaw/openclaw/notes.md token=${unsafeToken}`,
      proof: `Checked /private/tmp/proof.txt token=${unsafeToken}`,
      now: now + 1_000,
    });
    await updateSelfImprovementCuratorStatus({
      stateDir: tmpDir,
      id: proposal.id,
      curatorStatus: "promoted",
      proof: `Promoted via /Users/openclaw/openclaw/SKILL.md token=${unsafeToken}`,
      workshopProposalId: "swp_memory_1",
      workshopProposalStatus: "applied",
      now: now + 2_000,
    });

    const serialized = JSON.stringify(await listSelfImprovementProposals({ stateDir: tmpDir }));
    expect(serialized).toContain("[local-path]");
    expect(serialized).not.toContain("/Users/openclaw");
    expect(serialized).not.toContain("/private/tmp");
    expect(serialized).not.toContain(unsafeToken);
  });

  it("redacts sensitive incoming proposals before durable writes", async () => {
    const [proposal] = buildSelfImprovementProposalsFromGroups({ groups: [group()], now });
    expect(proposal).toBeDefined();
    if (!proposal) {
      return;
    }
    const unsafeToken = "abcdefghijklmnopqrstuvwxyz123456";
    await upsertSelfImprovementProposals({
      stateDir: tmpDir,
      proposals: [
        {
          ...proposal,
          title: "Review /Users/openclaw/openclaw/run.log",
          summary: `Proposal summary /Users/openclaw/openclaw/run.log token=${unsafeToken}`,
          recommendedAction: "Inspect ~/openclaw/secrets.txt before approval.",
          requiredEvidence: [`Proof at /private/tmp/openclaw-proof.json token=${unsafeToken}`],
          safetyNotes: [`Do not expose /Users/openclaw/openclaw/secrets.env token=${unsafeToken}`],
          approvalProof: `Approved with /private/tmp/approval.txt token=${unsafeToken}`,
          dismissalReason: "Duplicate of /Users/openclaw/openclaw/old-proposal.json",
        },
      ],
    });

    const raw = await fs.readFile(resolveSelfImprovementProposalStorePath(tmpDir), "utf8");
    expect(raw).toContain("[local-path]");
    expect(raw).not.toContain("/Users/openclaw");
    expect(raw).not.toContain("/private/tmp");
    expect(raw).not.toContain("~/openclaw");
    expect(raw).not.toContain(unsafeToken);
  });

  it("redacts proposal proof, notes, and existing evidence", async () => {
    const [proposal] = buildSelfImprovementProposalsFromGroups({
      groups: [
        group({
          topEvidence: [
            "Command /Users/openclaw/openclaw/scripts/run.sh failed with token=abcdefghijklmnopqrstuvwxyz123456",
          ],
          recommendedAction: "Inspect /private/tmp/openclaw-proof.json",
          analysis: {
            ...group().analysis,
            summary: "Review /Users/openclaw/openclaw/scripts/run.sh",
          },
        }),
      ],
      now,
    });
    expect(proposal).toBeDefined();
    if (!proposal) {
      return;
    }
    await upsertSelfImprovementProposals({ stateDir: tmpDir, proposals: [proposal] });
    await updateSelfImprovementProposalStatus({
      stateDir: tmpDir,
      id: proposal.id,
      status: "approved",
      approvalProof:
        "Approved with proof /Users/openclaw/openclaw/proof.txt token=abcdefghijklmnopqrstuvwxyz123456",
      note: "Reviewed ~/openclaw/secrets.txt",
      now: now + 1_000,
    });

    const proposals = await listSelfImprovementProposals({ stateDir: tmpDir });
    const serialized = JSON.stringify(proposals[0]);
    expect(proposals[0]?.status).toBe("approved");
    expect(proposals[0]?.approvalProof).toContain("[local-path]");
    expect(proposals[0]?.summary).toContain("[local-path]");
    expect(proposals[0]?.recommendedAction).toContain("[local-path]");
    expect(proposals[0]?.requiredEvidence[0]).toContain("[local-path]");
    expect(proposals[0]?.safetyNotes.at(-1)).toContain("[local-path]");
    expect(serialized).not.toContain("/Users/openclaw");
    expect(serialized).not.toContain("/private/tmp");
    expect(serialized).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
  });
});
