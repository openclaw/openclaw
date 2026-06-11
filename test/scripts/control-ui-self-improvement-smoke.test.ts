import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSeedAuditEvent,
  buildSeedCuratorProposal,
  buildSeedIntelligenceRecommendation,
  buildSeedOperationalHealthSnapshot,
  buildSeedRecommendation,
  buildSelfImprovementSmokeConfig,
  seedSelfImprovementSmokeState,
} from "../../scripts/dev/control-ui-self-improvement-smoke.ts";

const tempDirs: string[] = [];

describe("control-ui-self-improvement-smoke", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
  });

  it("builds an isolated token-auth Gateway config", () => {
    expect(buildSelfImprovementSmokeConfig({ port: 19281, token: "smoke-token" })).toEqual({
      gateway: {
        port: 19281,
        bind: "loopback",
        auth: { mode: "token", token: "smoke-token" },
        controlUi: { enabled: true },
      },
      hooks: { enabled: false },
    });
  });

  it("creates a recommendation-only seeded fixture for dashboard cards", () => {
    const recommendation = buildSeedRecommendation(1_780_000_000_000);

    expect(recommendation).toMatchObject({
      id: "sir_self_improvement_dashboard_smoke",
      category: "verification_gap",
      status: "open",
      route: {
        role: "qa",
        targetAgentId: "qa-test-agent",
      },
      safety: {
        mode: "recommendation_only",
        mutationAllowed: false,
        requiresApproval: true,
        requiresTests: true,
      },
      analysis: {
        mode: "deterministic",
      },
    });
    expect(recommendation.safety.blockedActions).toContain("no uncontrolled skill writes");
    expect(recommendation.requiredEvidence).toContain(
      "Last analysis metadata rendered after a deterministic analysis run.",
    );
  });

  it("creates a recommendation-only seeded fixture for improvement intelligence cards", () => {
    const recommendation = buildSeedIntelligenceRecommendation(1_780_000_000_000);

    expect(recommendation).toMatchObject({
      id: "sir_self_improvement_intelligence_smoke",
      category: "workflow_simplification",
      status: "open",
      route: {
        role: "program_manager",
        targetAgentId: "program-manager",
      },
      safety: {
        mode: "recommendation_only",
        mutationAllowed: false,
        requiresApproval: true,
      },
      analysis: {
        mode: "deterministic",
      },
    });
    expect(recommendation.requiredEvidence).toContain("Improvement Intelligence heading rendered.");
  });

  it("creates a sanitized audit-event fixture for the dashboard ledger", () => {
    const auditEvent = buildSeedAuditEvent(1_780_000_000_000);

    expect(auditEvent).toMatchObject({
      id: "sie_self_improvement_dashboard_smoke",
      kind: "model_preflight",
      actor: "gateway",
      targetId: "self-improvement-models",
      summary: "Checked Self-Improvement model readiness: degraded.",
      metadata: {
        readiness: "degraded",
        readyTier: "crossCheck",
        preflightStatus: "missing_config",
      },
    });
    expect(JSON.stringify(auditEvent)).not.toContain("/Users/");
    expect(JSON.stringify(auditEvent)).not.toContain("token=");
  });

  it("creates an operational health fixture for dashboard observability", () => {
    const snapshot = buildSeedOperationalHealthSnapshot(1_780_000_000_000);

    expect(snapshot).toMatchObject({
      id: "sih_self_improvement_smoke",
      health: {
        status: "degraded",
        score: 78,
        dimensions: [
          {
            id: "models",
            status: "degraded",
          },
          {
            id: "background",
            status: "ready",
          },
          {
            id: "intelligence",
            status: "degraded",
          },
        ],
      },
    });
  });

  it("creates a pending-mode memory/skill curator proposal fixture", () => {
    const proposal = buildSeedCuratorProposal(1_780_000_000_000);

    expect(proposal).toMatchObject({
      id: "sip_self_improvement_memory_skill_smoke",
      kind: "memory_skill",
      curatorStatus: "accepted_for_workshop",
      route: {
        role: "memory_curator",
        targetAgentId: "memory-knowledge-curator",
      },
    });
    expect(proposal.safetyNotes).toContain("No uncontrolled memory or skill writes.");
  });

  it("writes the seeded recommendation and audit-event stores under isolated state", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "openclaw-self-improvement-smoke-"));
    tempDirs.push(stateDir);

    await seedSelfImprovementSmokeState({ now: 1_780_000_000_000, stateDir });

    const raw = await readFile(join(stateDir, "self-improvement", "recommendations.json"), "utf8");
    const parsed = JSON.parse(raw) as {
      recommendations?: Array<{ id?: string; safety?: { mutationAllowed?: boolean } }>;
      version?: number;
    };
    expect(parsed.version).toBe(2);
    expect(parsed.recommendations).toHaveLength(2);
    expect(parsed.recommendations?.[0]).toMatchObject({
      id: "sir_self_improvement_dashboard_smoke",
      safety: { mutationAllowed: false },
    });
    expect(parsed.recommendations?.[1]).toMatchObject({
      id: "sir_self_improvement_intelligence_smoke",
      safety: { mutationAllowed: false },
    });

    const rawAuditEvents = await readFile(
      join(stateDir, "self-improvement", "audit-events.json"),
      "utf8",
    );
    const parsedAuditEvents = JSON.parse(rawAuditEvents) as {
      events?: Array<{ id?: string; kind?: string; metadata?: Record<string, unknown> }>;
      version?: number;
    };
    expect(parsedAuditEvents.version).toBe(1);
    expect(parsedAuditEvents.events).toHaveLength(4);
    expect(parsedAuditEvents.events?.[0]).toMatchObject({
      id: "sie_self_improvement_dashboard_smoke",
      kind: "model_preflight",
      metadata: { readiness: "degraded" },
    });
    expect(parsedAuditEvents.events?.[1]).toMatchObject({
      id: "sie_self_improvement_reviewer_eval_smoke",
      kind: "reviewer_eval_run",
      metadata: { readiness: "ready", passRate: 1 },
    });
    expect(parsedAuditEvents.events?.[2]).toMatchObject({
      id: "sie_self_improvement_background_cycle_smoke",
      kind: "background_cycle",
      metadata: { success: true },
    });
    expect(parsedAuditEvents.events?.[3]).toMatchObject({
      id: "sie_self_improvement_health_smoke",
      kind: "operational_health_snapshot",
      metadata: { status: "degraded", score: 78 },
    });

    const rawProposals = await readFile(
      join(stateDir, "self-improvement", "proposals.json"),
      "utf8",
    );
    const parsedProposals = JSON.parse(rawProposals) as {
      proposals?: Array<{ id?: string; kind?: string; curatorStatus?: string }>;
      version?: number;
    };
    expect(parsedProposals.version).toBe(1);
    expect(parsedProposals.proposals).toHaveLength(1);
    expect(parsedProposals.proposals?.[0]).toMatchObject({
      id: "sip_self_improvement_memory_skill_smoke",
      kind: "memory_skill",
      curatorStatus: "accepted_for_workshop",
    });

    const rawHealthSnapshots = await readFile(
      join(stateDir, "self-improvement", "health-snapshots.json"),
      "utf8",
    );
    const parsedHealthSnapshots = JSON.parse(rawHealthSnapshots) as {
      snapshots?: Array<{ id?: string; health?: { status?: string } }>;
      version?: number;
    };
    expect(parsedHealthSnapshots.version).toBe(1);
    expect(parsedHealthSnapshots.snapshots).toHaveLength(1);
    expect(parsedHealthSnapshots.snapshots?.[0]).toMatchObject({
      id: "sih_self_improvement_smoke",
      health: { status: "degraded" },
    });
  });
});
