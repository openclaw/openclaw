import { describe, expect, it } from "vitest";
import { auditSelfImprovementOpportunities } from "./auditor.js";
import type { SkillWorkshopProposalSnapshot } from "./skill-workshop.js";
import type { SelfImprovementAuditEvent, SelfImprovementRecommendation } from "./types.js";

const now = Date.parse("2026-05-07T12:00:00.000Z");

function categories(recommendations: SelfImprovementRecommendation[]) {
  return recommendations.map((entry) => entry.category);
}

describe("auditSelfImprovementOpportunities", () => {
  it("turns failed dashboard smokes and stale runs into routed recommendations", async () => {
    const result = await auditSelfImprovementOpportunities({
      cfg: {
        agents: { list: [{ id: "telemetry-evaluation-analyst" }, { id: "program-manager" }] },
      },
      stateDir: "/tmp/openclaw-test",
      now,
      tasks: [
        {
          taskId: "task-smoke",
          runtime: "cli",
          requesterSessionKey: "main",
          ownerKey: "main",
          scopeKind: "system",
          task: "dashboard smoke",
          status: "failed",
          deliveryStatus: "not_applicable",
          notifyPolicy: "silent",
          createdAt: now - 10_000,
          error: "Control UI dashboard smoke failed",
        },
        {
          taskId: "task-stale",
          runtime: "subagent",
          requesterSessionKey: "main",
          ownerKey: "main",
          scopeKind: "system",
          task: "Long running implementation",
          status: "running",
          deliveryStatus: "not_applicable",
          notifyPolicy: "silent",
          createdAt: now - 2 * 60 * 60_000,
          lastEventAt: now - 90 * 60_000,
        },
      ],
      skillWorkshopProposals: [],
    });

    expect(categories(result.recommendations)).toEqual(
      expect.arrayContaining(["smoke_failure", "stale_work"]),
    );
    expect(
      result.recommendations.find((entry) => entry.category === "smoke_failure")?.route.role,
    ).toBe("qa");
    expect(
      result.recommendations.find((entry) => entry.category === "stale_work")?.route.role,
    ).toBe("program_manager");
  });

  it("routes Skill Workshop pending and quarantined proposals to memory curation", async () => {
    const proposals: SkillWorkshopProposalSnapshot[] = [
      {
        id: "proposal-pending",
        status: "pending",
        title: "Remember dashboard smoke recovery",
        createdAt: now - 2 * 24 * 60 * 60_000,
        updatedAt: now - 2 * 24 * 60 * 60_000,
        filePath: "/tmp/proposals.json",
      },
      {
        id: "proposal-quarantined",
        status: "quarantined",
        title: "Unsafe write",
        quarantineReason: "direct write requested",
        filePath: "/tmp/proposals.json",
      },
    ];

    const result = await auditSelfImprovementOpportunities({
      cfg: { agents: { list: [{ id: "memory-knowledge-curator" }] } },
      stateDir: "/tmp/openclaw-test",
      now,
      tasks: [],
      skillWorkshopProposals: proposals,
    });

    expect(result.inspected.skillWorkshopProposals).toBe(2);
    expect(result.recommendations).toHaveLength(2);
    expect(result.recommendations.map((entry) => entry.route.role)).toEqual([
      "memory_curator",
      "memory_curator",
    ]);
    expect(result.recommendations.every((entry) => entry.safety.mutationAllowed === false)).toBe(
      true,
    );
  });

  it("detects broader continuous-improvement themes without direct mutation", async () => {
    const result = await auditSelfImprovementOpportunities({
      cfg: {
        agents: {
          list: [
            { id: "program-manager" },
            { id: "memory-knowledge-curator" },
            { id: "qa-test-agent" },
            { id: "codex" },
          ],
        },
      },
      stateDir: "/tmp/openclaw-test",
      now,
      tasks: [
        {
          taskId: "task-instruction",
          runtime: "cli",
          requesterSessionKey: "main",
          ownerKey: "main",
          scopeKind: "system",
          task: "Fix missed AGENTS.md repo rule and Completion Grade output",
          status: "succeeded",
          deliveryStatus: "not_applicable",
          notifyPolicy: "silent",
          createdAt: now - 10_000,
        },
        {
          taskId: "task-agentless",
          runtime: "cli",
          requesterSessionKey: "main",
          ownerKey: "main",
          scopeKind: "system",
          task: "Find agentless path without creating agents",
          status: "succeeded",
          deliveryStatus: "not_applicable",
          notifyPolicy: "silent",
          createdAt: now - 9_000,
        },
        {
          taskId: "task-risk",
          runtime: "cli",
          requesterSessionKey: "main",
          ownerKey: "main",
          scopeKind: "system",
          task: "Missing test and approval guardrail for risky config",
          status: "succeeded",
          deliveryStatus: "not_applicable",
          notifyPolicy: "silent",
          createdAt: now - 8_000,
        },
        {
          taskId: "task-metric",
          runtime: "cli",
          requesterSessionKey: "main",
          ownerKey: "main",
          scopeKind: "system",
          task: "Add scorecard baseline to measure daily improvement",
          status: "succeeded",
          deliveryStatus: "not_applicable",
          notifyPolicy: "silent",
          createdAt: now - 7_000,
        },
      ],
      skillWorkshopProposals: [],
    });

    expect(categories(result.recommendations)).toEqual(
      expect.arrayContaining([
        "instruction_adherence",
        "agent_minimization",
        "risk_prevention",
        "outcome_measurement",
      ]),
    );
    expect(
      result.recommendations.find((entry) => entry.category === "risk_prevention")?.route.role,
    ).toBe("qa");
    expect(
      result.recommendations.find((entry) => entry.category === "agent_minimization")?.route.role,
    ).toBe("program_manager");
    expect(
      result.recommendations.every(
        (entry) =>
          entry.safety.mutationAllowed === false && entry.analysis.mode === "deterministic",
      ),
    ).toBe(true);
  });

  it("turns repeated slow verification workflows into efficiency and simplification opportunities", async () => {
    const baseTask = {
      runtime: "cli" as const,
      requesterSessionKey: "main",
      ownerKey: "main",
      scopeKind: "system" as const,
      task: "Run pnpm test src/self-improvement/auditor.test.ts and pnpm ui:build verification",
      deliveryStatus: "not_applicable" as const,
      notifyPolicy: "silent" as const,
      createdAt: now - 2 * 60 * 60_000,
      startedAt: now - 2 * 60 * 60_000,
      endedAt: now - 80 * 60_000,
    };
    const result = await auditSelfImprovementOpportunities({
      cfg: {
        agents: {
          list: [{ id: "program-manager" }, { id: "builder-agent" }],
        },
      },
      stateDir: "/tmp/openclaw-test",
      now,
      tasks: [
        {
          ...baseTask,
          taskId: "task-workflow-1",
          status: "timed_out",
          error: "verification timed out",
        },
        {
          ...baseTask,
          taskId: "task-workflow-2",
          status: "failed",
          error: "verification failed",
        },
      ],
      skillWorkshopProposals: [],
    });

    expect(categories(result.recommendations)).toEqual(
      expect.arrayContaining(["efficiency_opportunity", "workflow_simplification"]),
    );
    expect(
      result.recommendations.find((entry) => entry.category === "efficiency_opportunity")?.route
        .role,
    ).toBe("builder");
    expect(
      result.recommendations.find((entry) => entry.category === "workflow_simplification")?.route
        .role,
    ).toBe("program_manager");
    expect(result.recommendations.every((entry) => entry.safety.mutationAllowed === false)).toBe(
      true,
    );
  });

  it("uses sanitized audit ledger signals for continuous-improvement recommendations", async () => {
    const auditEvents: SelfImprovementAuditEvent[] = [
      {
        id: "sie_instruction",
        createdAt: now,
        actor: "governor",
        kind: "analysis_run",
        targetId: "self-improvement",
        summary: "Operator noted ignored instruction and missing Completion Grade.",
        metadata: {
          route: "memory_curator",
          diagnostics: ["ignored instruction", "Completion Grade missing"],
        },
      },
    ];

    const result = await auditSelfImprovementOpportunities({
      cfg: { agents: { list: [{ id: "memory-knowledge-curator" }] } },
      stateDir: "/tmp/openclaw-test",
      now,
      tasks: [],
      auditEvents,
      skillWorkshopProposals: [],
    });

    const recommendation = result.recommendations.find(
      (entry) => entry.category === "instruction_adherence",
    );
    expect(recommendation).toMatchObject({
      route: { role: "memory_curator" },
      safety: { mutationAllowed: false },
      analysis: { mode: "deterministic" },
    });
    expect(recommendation?.evidence.join(" ")).toContain("Operator noted ignored instruction");
  });

  it("turns model-review fallback audit events into model-routing recommendations", async () => {
    const auditEvents: SelfImprovementAuditEvent[] = [
      {
        id: "sie_review_fallback",
        createdAt: now,
        actor: "governor",
        kind: "analysis_run",
        targetId: "self-improvement",
        summary: "Ran deterministic self-improvement analysis after model review fallback.",
        metadata: {
          mode: "fallback",
          reviewPolicy: "local_first",
          schemaValidated: false,
          modelTier: "crossCheck",
          modelId: "ollama/qwen3.6:27b-q8_0",
          invalidJsonAttempts: 1,
          invalidJsonDiagnostics: ["missing_group_id"],
          failedAttempts: 0,
          attemptStatuses: ["primaryReview:invalid_json:passed", "crossCheck:invalid_json:passed"],
          attemptBlockers: [
            "primaryReview:invalid_json:passed: Reviewer returned invalid JSON. Reason: review groups omitted groupId values in an ambiguous payload.",
            "crossCheck:invalid_json:passed: Reviewer returned invalid JSON. Reason: review groups omitted groupId values in an ambiguous payload.",
          ],
          blockedRemediationHints: [
            "primaryReview: Keep deterministic fallback unless the reviewer can return schema-valid JSON; use the Qwen cross-check path for schema repair.",
            "crossCheck: Keep deterministic fallback unless the reviewer can return schema-valid JSON; use the Qwen cross-check path for schema repair.",
          ],
          fallbackReason:
            "LLM review returned invalid JSON after retry; deterministic analysis was retained.",
        },
      },
    ];

    const result = await auditSelfImprovementOpportunities({
      cfg: { agents: { list: [{ id: "codex" }] } },
      stateDir: "/tmp/openclaw-test",
      now,
      tasks: [],
      auditEvents,
      skillWorkshopProposals: [],
    });

    expect(result.inspected.auditEvents).toBe(1);
    expect(result.recommendations).toHaveLength(1);
    expect(result.recommendations[0]).toMatchObject({
      category: "model_routing",
      severity: "high",
      route: { role: "builder" },
      safety: { mutationAllowed: false, requiresApproval: true, requiresTests: true },
    });
    expect(result.recommendations[0]?.evidence.join(" ")).toContain("invalid JSON");
    expect(result.recommendations[0]?.evidence.join(" ")).toContain(
      "Invalid JSON diagnostic: missing_group_id",
    );
    expect(result.recommendations[0]?.evidence.join(" ")).toContain(
      "primaryReview:invalid_json:passed",
    );
    expect(result.recommendations[0]?.evidence.join(" ")).toContain(
      "use the Qwen cross-check path for schema repair",
    );
  });

  it("does not refresh fallback recommendations after a newer schema-valid local review", async () => {
    const auditEvents: SelfImprovementAuditEvent[] = [
      {
        id: "sie_review_fallback",
        createdAt: now - 1_000,
        actor: "governor",
        kind: "analysis_run",
        targetId: "self-improvement",
        summary: "Ran deterministic self-improvement analysis after model review fallback.",
        metadata: {
          mode: "fallback",
          reviewPolicy: "local_first",
          schemaValidated: false,
          modelTier: "crossCheck",
          modelId: "ollama/qwen3.6:27b-q8_0",
          invalidJsonAttempts: 1,
          invalidJsonDiagnostics: ["no_balanced_json"],
          fallbackReason:
            "LLM review returned invalid JSON after retry; deterministic analysis was retained.",
        },
      },
      {
        id: "sie_review_recovered",
        createdAt: now,
        actor: "governor",
        kind: "analysis_run",
        targetId: "self-improvement",
        summary: "Ran model-reviewed self-improvement analysis.",
        metadata: {
          mode: "local_retry",
          reviewPolicy: "local_first",
          schemaValidated: true,
          modelReady: true,
          modelReadiness: "degraded",
          readyTier: "crossCheck",
          readyModelId: "ollama/openclaw-control-qwen3-30b-q6-chatfix:latest",
          modelTier: "crossCheck",
          modelId: "ollama/openclaw-control-qwen3-30b-q6-chatfix:latest",
        },
      },
    ];

    const result = await auditSelfImprovementOpportunities({
      cfg: { agents: { list: [{ id: "codex" }] } },
      stateDir: "/tmp/openclaw-test",
      now,
      tasks: [],
      auditEvents,
      skillWorkshopProposals: [],
    });

    expect(result.inspected.auditEvents).toBe(2);
    expect(result.recommendations).toHaveLength(0);
  });

  it("turns degraded local model preflight audit events into model-routing recommendations", async () => {
    const auditEvents: SelfImprovementAuditEvent[] = [
      {
        id: "sie_model_preflight",
        createdAt: now,
        actor: "gateway",
        kind: "model_preflight",
        targetId: "self-improvement-models",
        summary: "Checked Self-Improvement model readiness: degraded.",
        metadata: {
          reviewPolicy: "local_first",
          readiness: "degraded",
          ready: true,
          readyTier: "crossCheck",
          readyModelId: "ollama/openclaw-control-qwen3-30b-q6-chatfix:latest",
          reviewModelId: "ollama/qwen3.6:27b-q8_0",
          fallbackModelId: "ollama/openclaw-control-qwen3-30b-q6-chatfix:latest",
          preflightStatus: "missing_config",
          blockedPrimaryReason: "Local model preflight could not find qwen3.6:27b-q8_0.",
          primaryRemediationHint:
            "Verify Ollama is running and the selected local model appears in the local /api/tags catalog, then rerun openclaw self-improvement preflight.",
          blockedRemediationHints: [
            "primaryReview: Verify Ollama is running and the selected local model appears in the local /api/tags catalog, then rerun openclaw self-improvement preflight.",
          ],
          attemptStatuses: ["primaryReview:blocked:missing_config", "crossCheck:success:passed"],
        },
      },
    ];

    const result = await auditSelfImprovementOpportunities({
      cfg: { agents: { list: [{ id: "codex" }] } },
      stateDir: "/tmp/openclaw-test",
      now,
      tasks: [],
      auditEvents,
      skillWorkshopProposals: [],
    });

    expect(result.inspected.auditEvents).toBe(1);
    expect(result.recommendations).toHaveLength(1);
    expect(result.recommendations[0]).toMatchObject({
      category: "model_routing",
      severity: "medium",
      route: { role: "builder" },
      safety: { mutationAllowed: false, requiresApproval: true, requiresTests: true },
    });
    expect(result.recommendations[0]?.recommendedAction).toContain("preferred local model ready");
    expect(result.recommendations[0]?.evidence.join(" ")).toContain("qwen3.6:27b-q8_0");
    expect(result.recommendations[0]?.evidence.join(" ")).toContain("Verify Ollama is running");
    expect(result.recommendations[0]?.requiredEvidence).toEqual(
      expect.arrayContaining([
        "Run `openclaw self-improvement analyze --local-first --limit 1 --json` and attach schema status.",
      ]),
    );
  });
});
