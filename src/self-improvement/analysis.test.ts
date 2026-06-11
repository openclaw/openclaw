import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runSelfImprovementAnalysis } from "./analysis.js";
import { listSelfImprovementAuditEvents } from "./audit-events.js";
import { listSelfImprovementProposals } from "./proposals.js";
import { listSelfImprovementDailyScorecards } from "./scorecard-store.js";
import { upsertSelfImprovementRecommendations } from "./store.js";
import type { SelfImprovementRecommendation } from "./types.js";

const now = Date.parse("2026-05-07T12:00:00.000Z");
let tmpDir: string;

function recommendation(): SelfImprovementRecommendation {
  return {
    id: "sir_test",
    fingerprint: "fingerprint",
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now,
    status: "open",
    title: "Failed dashboard smoke needs QA review",
    summary: "The dashboard smoke failed and needs targeted verification.",
    category: "smoke_failure",
    severity: "high",
    criticality: "high",
    priority: "high",
    impact: "high",
    effort: "medium",
    confidence: 0.9,
    groupKey: "smoke_failure:task_group:dashboard-smoke",
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
    requiredEvidence: ["Rerun the affected dashboard smoke."],
    safety: {
      mode: "recommendation_only",
      mutationAllowed: false,
      requiresApproval: true,
      requiresTests: true,
      blockedActions: ["no direct merge, push, or release"],
    },
    analysis: {
      mode: "deterministic",
      summary: "One evidence-backed recommendation is ready for routed review.",
      generatedAt: now,
      confidence: 0.9,
      promptVersion: "self-improvement-deterministic-v1",
      evidenceCount: 1,
      safetyNotes: ["Recommendation-only."],
    },
    evidence: ["Task task-1 status: failed"],
  };
}

describe("runSelfImprovementAnalysis", () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-self-improvement-analysis-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("falls back safely from requested but unapproved LLM analysis", async () => {
    await upsertSelfImprovementRecommendations({
      stateDir: tmpDir,
      recommendations: [recommendation()],
    });

    const result = await runSelfImprovementAnalysis({
      stateDir: tmpDir,
      now,
      writeHealthSnapshot: false,
      llm: true,
      allowHostedEscalation: true,
      modelId: "gpt-5.5",
    });

    expect(result).toMatchObject({
      mode: "fallback",
      modelId: "gpt-5.5",
      ready: false,
      readiness: "blocked",
      reviewPolicy: "hosted",
      confidence: 0.9,
      llmRequested: true,
      llmApproved: false,
      localFirst: false,
      groupsAnalyzed: 1,
      groupsReviewedByLlm: 0,
      groupsReviewedByLocalLlm: 0,
      proposalsCreated: 1,
      schemaValidated: false,
    });
    expect(result.fallbackReason).toContain("explicit per-run approval");
    await expect(listSelfImprovementProposals({ stateDir: tmpDir })).resolves.toHaveLength(1);
    await expect(listSelfImprovementDailyScorecards({ stateDir: tmpDir })).resolves.toHaveLength(1);
  });

  it("blocks approved hosted LLM analysis when hosted escalation is not explicitly allowed", async () => {
    await upsertSelfImprovementRecommendations({
      stateDir: tmpDir,
      recommendations: [recommendation()],
    });

    let completionCalls = 0;
    const result = await runSelfImprovementAnalysis({
      cfg: {} as OpenClawConfig,
      stateDir: tmpDir,
      now,
      writeHealthSnapshot: false,
      llm: true,
      llmApproval: true,
      modelId: "openai/gpt-5.5",
      env: { OPENCLAW_SELF_IMPROVEMENT_LLM: "1" },
      llmCompletion: async () => {
        completionCalls += 1;
        return { text: "{}" };
      },
    });

    expect(completionCalls).toBe(0);
    expect(result).toMatchObject({
      mode: "fallback",
      ready: false,
      readiness: "blocked",
      reviewPolicy: "hosted",
      hostedEscalationAllowed: false,
      llmRequested: true,
      llmApproved: true,
      groupsReviewedByLlm: 0,
      schemaValidated: false,
    });
    expect(result.fallbackReason).toContain("explicit hosted escalation allowance");
    expect(result.attempts[0]).toMatchObject({
      tier: "hostedEscalation",
      status: "blocked",
    });
  });

  it("uses approved LLM review output when the gate is enabled", async () => {
    await upsertSelfImprovementRecommendations({
      stateDir: tmpDir,
      recommendations: [recommendation()],
    });

    const result = await runSelfImprovementAnalysis({
      cfg: {} as OpenClawConfig,
      stateDir: tmpDir,
      now,
      writeHealthSnapshot: false,
      llm: true,
      llmApproval: true,
      allowHostedEscalation: true,
      modelId: "openai/gpt-5.5",
      env: { OPENCLAW_SELF_IMPROVEMENT_LLM: "1" },
      llmCompletion: async ({ userPrompt }) => {
        const groupId = userPrompt.match(/"id":"(sig_[^"]+)"/)?.[1] ?? "sig_missing";
        return {
          text: JSON.stringify({
            groups: [
              {
                groupId,
                summary: "LLM-reviewed smoke failures need one bounded QA rerun.",
                recommendedAction: "Ask QA to rerun the dashboard smoke and attach proof.",
                confidence: 0.88,
                safetyNotes: ["Keep this recommendation-only until proof is attached."],
              },
            ],
          }),
          modelId: "openai/gpt-5.5",
        };
      },
    });

    expect(result).toMatchObject({
      mode: "hosted_escalation",
      modelId: "openai/gpt-5.5",
      ready: true,
      readiness: "ready",
      readyTier: "hostedEscalation",
      readyModelId: "openai/gpt-5.5",
      reviewPolicy: "hosted",
      modelTier: "hostedEscalation",
      confidence: 0.88,
      llmRequested: true,
      llmApproved: true,
      groupsAnalyzed: 1,
      groupsReviewedByLlm: 1,
      schemaValidated: true,
    });
    expect(result.proposals[0]).toMatchObject({
      analysisMode: "hosted_escalation",
      summary: "LLM-reviewed smoke failures need one bounded QA rerun.",
    });
  });

  it("uses local-first Qwen review without hosted approval", async () => {
    await upsertSelfImprovementRecommendations({
      stateDir: tmpDir,
      recommendations: [recommendation()],
    });

    const result = await runSelfImprovementAnalysis({
      cfg: {} as OpenClawConfig,
      stateDir: tmpDir,
      now,
      writeHealthSnapshot: false,
      localFirst: true,
      llmPreflight: async (params) => ({
        ok: true,
        status: params.local ? "passed" : "not_required",
        elapsedMs: params.local ? 5 : 0,
      }),
      llmCompletion: async ({ modelId, userPrompt }) => {
        const groupId = userPrompt.match(/"id":"(sig_[^"]+)"/)?.[1] ?? "sig_missing";
        return {
          text: JSON.stringify({
            groups: [
              {
                groupId,
                summary: "Local Qwen review found a bounded QA improvement.",
                recommendedAction: "Ask QA to verify the smoke path and attach proof.",
                confidence: 0.84,
              },
            ],
          }),
          modelId,
        };
      },
    });

    expect(result).toMatchObject({
      mode: "local_llm",
      reviewPolicy: "local_first",
      modelId: "ollama/qwen3.6:27b-q8_0",
      ready: true,
      readiness: "ready",
      readyTier: "primaryReview",
      readyModelId: "ollama/qwen3.6:27b-q8_0",
      reviewModelId: "ollama/qwen3.6:27b-q8_0",
      fallbackModelId: "ollama/openclaw-control-qwen3-30b-q6-chatfix:latest",
      localFirst: true,
      confidence: 0.84,
      llmRequested: false,
      llmApproved: false,
      groupsReviewedByLlm: 1,
      groupsReviewedByLocalLlm: 1,
      schemaValidated: true,
      preflightStatus: "passed",
      preflightMs: 5,
    });
    expect(result.attempts[0]).toMatchObject({
      tier: "primaryReview",
      quantization: "Q8_0",
      parameters: "27B",
      preflightStatus: "passed",
    });
    expect(result.proposals[0]).toMatchObject({
      analysisMode: "local_llm",
      summary: "Local Qwen review found a bounded QA improvement.",
    });
  });

  it("keeps empty local-first analysis deterministic without model attempts", async () => {
    let preflightCalls = 0;
    let completionCalls = 0;
    const result = await runSelfImprovementAnalysis({
      cfg: {} as OpenClawConfig,
      stateDir: tmpDir,
      now,
      writeHealthSnapshot: false,
      localFirst: true,
      llmPreflight: async () => {
        preflightCalls += 1;
        return { ok: true, status: "passed", elapsedMs: 1 };
      },
      llmCompletion: async () => {
        completionCalls += 1;
        return { text: "{}" };
      },
    });

    expect(preflightCalls).toBe(0);
    expect(completionCalls).toBe(0);
    expect(result).toMatchObject({
      mode: "deterministic",
      reviewPolicy: "local_first",
      localFirst: true,
      groupsAnalyzed: 0,
      groupsReviewedByLlm: 0,
      groupsReviewedByLocalLlm: 0,
      proposalsCreated: 0,
      attempts: [],
      schemaValidated: false,
    });
    expect(result).not.toHaveProperty("confidence");
    await expect(listSelfImprovementProposals({ stateDir: tmpDir })).resolves.toHaveLength(0);
    await expect(listSelfImprovementDailyScorecards({ stateDir: tmpDir })).resolves.toHaveLength(1);
  });

  it("records deterministic fallback metadata when local model preflight is unavailable", async () => {
    await upsertSelfImprovementRecommendations({
      stateDir: tmpDir,
      recommendations: [recommendation()],
    });

    const result = await runSelfImprovementAnalysis({
      cfg: {} as OpenClawConfig,
      stateDir: tmpDir,
      now,
      writeHealthSnapshot: false,
      localFirst: true,
      llmPreflight: async (params) => ({
        ok: false,
        status: "unavailable",
        elapsedMs: 13,
        reason: `${params.modelId} endpoint is unavailable at /Users/openclaw/openclaw/model.log token=abcdefghijklmnopqrstuvwxyz123456`,
      }),
      llmCompletion: async () => {
        throw new Error("completion should not be called after failed preflight");
      },
    });

    expect(result).toMatchObject({
      mode: "fallback",
      reviewPolicy: "local_first",
      localFirst: true,
      groupsReviewedByLlm: 0,
      groupsReviewedByLocalLlm: 0,
      schemaValidated: false,
      preflightStatus: "unavailable",
      preflightMs: 26,
      confidence: 0.9,
      ready: false,
      readiness: "blocked",
      blockedPrimaryReason:
        "ollama/qwen3.6:27b-q8_0 endpoint is unavailable at [local-path] token=[redacted]",
    });
    expect(result.attempts).toMatchObject([
      { tier: "primaryReview", status: "blocked", preflightStatus: "unavailable" },
      { tier: "crossCheck", status: "blocked", preflightStatus: "unavailable" },
    ]);
    expect(result.fallbackReason).toContain("endpoint is unavailable");
    expect(JSON.stringify(result)).not.toContain("/Users/openclaw");
    expect(JSON.stringify(result)).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
    const auditEvents = await listSelfImprovementAuditEvents({ stateDir: tmpDir });
    expect(JSON.stringify(auditEvents)).not.toContain("/Users/openclaw");
    expect(JSON.stringify(auditEvents)).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
  });

  it("records degraded analysis readiness when chatfix fallback succeeds after missing Qwen primary", async () => {
    await upsertSelfImprovementRecommendations({
      stateDir: tmpDir,
      recommendations: [recommendation()],
    });

    const completionCalls: string[] = [];
    const result = await runSelfImprovementAnalysis({
      cfg: {} as OpenClawConfig,
      stateDir: tmpDir,
      now,
      writeHealthSnapshot: false,
      localFirst: true,
      llmPreflight: async (params) => {
        if (params.modelId === "ollama/qwen3.6:27b-q8_0") {
          return {
            ok: false,
            status: "missing_config",
            elapsedMs: 2,
            reason: "Local model preflight could not find qwen3.6:27b-q8_0.",
          };
        }
        return {
          ok: true,
          status: "passed",
          elapsedMs: 5,
        };
      },
      llmCompletion: async ({ modelId, userPrompt }) => {
        completionCalls.push(modelId ?? "");
        const groupId = userPrompt.match(/"id":"(sig_[^"]+)"/)?.[1] ?? "sig_missing";
        return {
          text: JSON.stringify({
            groups: [
              {
                groupId,
                summary: "Chatfix fallback produced a bounded local review.",
                recommendedAction: "Keep the QA verification proposal pending for smoke proof.",
                confidence: 0.83,
              },
            ],
          }),
          modelId,
        };
      },
    });

    expect(completionCalls).toEqual(["ollama/openclaw-control-qwen3-30b-q6-chatfix:latest"]);
    expect(result).toMatchObject({
      mode: "local_retry",
      modelId: "ollama/openclaw-control-qwen3-30b-q6-chatfix:latest",
      ready: true,
      readiness: "degraded",
      readyTier: "crossCheck",
      readyModelId: "ollama/openclaw-control-qwen3-30b-q6-chatfix:latest",
      preflightStatus: "missing_config",
      preflightMs: 7,
      blockedPrimaryReason: "Local model preflight could not find qwen3.6:27b-q8_0.",
      groupsReviewedByLocalLlm: 1,
      confidence: 0.83,
      schemaValidated: true,
    });
    expect(result.attempts).toMatchObject([
      { tier: "primaryReview", status: "blocked", preflightStatus: "missing_config" },
      { tier: "crossCheck", status: "success", preflightStatus: "passed" },
    ]);
    const auditEvents = await listSelfImprovementAuditEvents({ stateDir: tmpDir });
    const analysisEvent = auditEvents.find((event) => event.kind === "analysis_run");
    expect(analysisEvent?.metadata).toMatchObject({
      attemptCount: 2,
      passedAttempts: 1,
      blockedAttempts: 1,
      failedAttempts: 0,
      invalidJsonAttempts: 0,
      attemptStatuses: ["primaryReview:blocked:missing_config", "crossCheck:success:passed"],
      primaryRemediationHint:
        "Verify Ollama is running and the selected local model appears in the local /api/tags catalog, then rerun openclaw self-improvement preflight.",
      blockedRemediationHints: [
        "primaryReview: Verify Ollama is running and the selected local model appears in the local /api/tags catalog, then rerun openclaw self-improvement preflight.",
      ],
      modelReady: true,
      modelReadiness: "degraded",
      readyTier: "crossCheck",
      readyModelId: "ollama/openclaw-control-qwen3-30b-q6-chatfix:latest",
      blockedPrimaryReason: "Local model preflight could not find qwen3.6:27b-q8_0.",
      confidence: 0.83,
    });
  });

  it("records degraded model readiness separately from invalid chatfix JSON", async () => {
    await upsertSelfImprovementRecommendations({
      stateDir: tmpDir,
      recommendations: [recommendation()],
    });

    const completionCalls: string[] = [];
    const result = await runSelfImprovementAnalysis({
      cfg: {} as OpenClawConfig,
      stateDir: tmpDir,
      now,
      writeHealthSnapshot: false,
      localFirst: true,
      llmPreflight: async (params) => {
        if (params.modelId === "ollama/qwen3.6:27b-q8_0") {
          return {
            ok: false,
            status: "missing_config",
            elapsedMs: 2,
            reason: "Local model preflight could not find qwen3.6:27b-q8_0.",
          };
        }
        return {
          ok: true,
          status: "passed",
          elapsedMs: 5,
        };
      },
      llmCompletion: async ({ modelId }) => {
        completionCalls.push(modelId ?? "");
        return {
          text: "<think>scratch</think>not json",
          modelId,
        };
      },
    });

    expect(completionCalls).toEqual(["ollama/openclaw-control-qwen3-30b-q6-chatfix:latest"]);
    expect(result).toMatchObject({
      mode: "fallback",
      reviewPolicy: "local_first",
      localFirst: true,
      modelId: "ollama/openclaw-control-qwen3-30b-q6-chatfix:latest",
      ready: true,
      readiness: "degraded",
      readyTier: "crossCheck",
      readyModelId: "ollama/openclaw-control-qwen3-30b-q6-chatfix:latest",
      preflightStatus: "missing_config",
      preflightMs: 7,
      blockedPrimaryReason: "Local model preflight could not find qwen3.6:27b-q8_0.",
      schemaValidated: false,
      groupsReviewedByLlm: 0,
      groupsReviewedByLocalLlm: 0,
      confidence: 0.9,
    });
    expect(result.attempts).toMatchObject([
      { tier: "primaryReview", status: "blocked", preflightStatus: "missing_config" },
      {
        tier: "crossCheck",
        status: "invalid_json",
        preflightStatus: "passed",
        diagnostic: "no_balanced_json",
      },
    ]);
    expect(result.fallbackReason).toContain("LLM review returned invalid JSON");
    const auditEvents = await listSelfImprovementAuditEvents({ stateDir: tmpDir });
    const analysisEvent = auditEvents.find((event) => event.kind === "analysis_run");
    expect(analysisEvent?.metadata).toMatchObject({
      attemptCount: 2,
      blockedAttempts: 1,
      invalidJsonAttempts: 1,
      invalidJsonDiagnostics: ["no_balanced_json"],
      modelReady: true,
      modelReadiness: "degraded",
      readyTier: "crossCheck",
      readyModelId: "ollama/openclaw-control-qwen3-30b-q6-chatfix:latest",
      blockedPrimaryReason: "Local model preflight could not find qwen3.6:27b-q8_0.",
      schemaValidated: false,
    });
  });
});
