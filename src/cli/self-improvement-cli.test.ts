import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCliRuntimeCapture } from "./test-runtime-capture.js";

const callGatewayFromCli = vi.fn();
const addGatewayClientOptions = vi.fn((command: Command) => command);

const { runtimeLogs, defaultRuntime, resetRuntimeCapture } = createCliRuntimeCapture();

vi.mock("./gateway-rpc.js", () => ({
  addGatewayClientOptions,
  callGatewayFromCli,
}));

vi.mock("../runtime.js", async () => ({
  ...(await vi.importActual<typeof import("../runtime.js")>("../runtime.js")),
  defaultRuntime,
  writeRuntimeJson: (runtime: { log: (...args: unknown[]) => void }, value: unknown, space = 2) =>
    runtime.log(JSON.stringify(value, null, space > 0 ? space : undefined)),
}));

const { registerSelfImprovementCli } = await import("./self-improvement-cli.js");

describe("self-improvement-cli", () => {
  async function runCli(args: string[]) {
    const program = new Command();
    registerSelfImprovementCli(program);
    try {
      await program.parseAsync(args, { from: "user" });
    } catch (error) {
      if (!(error instanceof Error && error.message.startsWith("__exit__:"))) {
        throw error;
      }
    }
  }

  beforeEach(() => {
    vi.clearAllMocks();
    resetRuntimeCapture();
    callGatewayFromCli.mockResolvedValue({ recommendations: [], total: 0 });
  });

  it("routes list filters to the recommendations list RPC", async () => {
    await runCli([
      "self-improvement",
      "list",
      "--status",
      "open,acknowledged",
      "--severity",
      "high",
      "--route",
      "qa",
    ]);

    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "selfImprovement.recommendations.list",
      expect.any(Object),
      {
        status: ["open", "acknowledged"],
        severity: ["high"],
        route: ["qa"],
        category: undefined,
        limit: 100,
      },
      { expectFinal: false },
    );
    expect(runtimeLogs).toEqual(["No self-improvement recommendations."]);
  });

  it("routes scan to the scan RPC", async () => {
    callGatewayFromCli.mockResolvedValueOnce({ scan: { produced: 2, open: 2 } });

    await runCli(["self-improvement", "scan"]);

    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "selfImprovement.scan",
      expect.any(Object),
      {},
      { expectFinal: false },
    );
    expect(runtimeLogs).toEqual(["Produced 2 recommendation(s), 2 open."]);
  });

  it("routes summary to the summary RPC", async () => {
    callGatewayFromCli.mockResolvedValueOnce({
      scorecard: {
        activeRecommendations: 3,
        groupedRecommendations: 2,
        criticalOpen: 0,
        highOpen: 1,
        testRequired: 2,
        approvalRequired: 2,
      },
      groups: [],
    });

    await runCli(["self-improvement", "summary", "--status", "open,reopened", "--limit", "10"]);

    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "selfImprovement.summary",
      expect.any(Object),
      { status: ["open", "reopened"], limit: 10 },
      { expectFinal: false },
    );
    expect(runtimeLogs[0]).toContain("Active 3");
  });

  it("prints confidence in recommendation and group summaries", async () => {
    callGatewayFromCli.mockResolvedValueOnce({
      recommendations: [
        {
          id: "sir_1",
          severity: "high",
          status: "open",
          confidence: 0.82,
          route: { targetAgentLabel: "QA Test Agent" },
          title: "Verify dashboard smoke failures",
        },
      ],
    });

    await runCli(["self-improvement", "list"]);

    expect(runtimeLogs[0]).toContain("confidence 82%");

    callGatewayFromCli.mockResolvedValueOnce({
      scorecard: { activeRecommendations: 1, groupedRecommendations: 1 },
      groups: [
        {
          priority: "high",
          status: "open",
          count: 2,
          route: { targetAgentLabel: "QA Test Agent" },
          title: "Dashboard smoke failures",
          analysis: { confidence: 0.91 },
        },
      ],
    });
    resetRuntimeCapture();

    await runCli(["self-improvement", "summary"]);

    expect(runtimeLogs[1]).toContain("confidence 91%");
  });

  it("lists continuous-improvement opportunities through the recommendation list RPC", async () => {
    callGatewayFromCli.mockResolvedValueOnce({
      total: 1,
      recommendations: [
        {
          id: "sir_efficiency",
          category: "efficiency_opportunity",
          priority: "high",
          status: "open",
          confidence: 0.84,
          route: { targetAgentLabel: "Builder Agent" },
          title: "Repeated verification workflow needs efficiency review",
          recommendedAction: "Propose the smallest measurable workflow improvement.",
        },
      ],
    });

    await runCli([
      "self-improvement",
      "opportunities",
      "--category",
      "efficiency_opportunity,workflow_simplification",
      "--route",
      "builder",
      "--limit",
      "7",
    ]);

    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "selfImprovement.recommendations.list",
      expect.any(Object),
      {
        status: ["open", "acknowledged", "assigned", "in_progress", "reopened", "quarantined"],
        route: ["builder"],
        category: ["efficiency_opportunity", "workflow_simplification"],
        limit: 7,
      },
      { expectFinal: false },
    );
    expect(runtimeLogs[0]).toContain("Improvement opportunities 1");
    expect(runtimeLogs[1]).toContain("efficiency_opportunity");
    expect(runtimeLogs[1]).toContain("confidence 84%");
    expect(runtimeLogs[2]).toContain("smallest measurable");
  });

  it("prints the action queue and routes triage filters through summary", async () => {
    callGatewayFromCli.mockResolvedValueOnce({
      actionQueue: {
        total: 1,
        unassigned: 1,
        overdue: 1,
        proofMissing: 1,
        readyToResolve: 0,
        items: [
          {
            kind: "group",
            id: "sig_1",
            title: "Dashboard smoke failures",
            status: "open",
            priority: "high",
            route: { targetAgentLabel: "QA Test Agent" },
            actionability: {
              ownerState: "unassigned",
              slaState: "overdue",
              proofState: "missing",
              closureState: "blocked",
              rank: 3950,
              nextAction: "Assign an owner immediately and attach the proof path.",
            },
          },
        ],
      },
    });

    await runCli([
      "self-improvement",
      "triage",
      "--route",
      "qa",
      "--status",
      "open,reopened",
      "--limit",
      "5",
    ]);

    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "selfImprovement.summary",
      expect.any(Object),
      { route: ["qa"], status: ["open", "reopened"], limit: 5 },
      { expectFinal: false },
    );
    expect(runtimeLogs[0]).toContain("Action Queue total 1");
    expect(runtimeLogs[1]).toContain("owner unassigned");
    expect(runtimeLogs[2]).toContain("Assign an owner");
  });

  it("routes scorecard options to the scorecard RPC", async () => {
    callGatewayFromCli.mockResolvedValueOnce({
      current: { activeRecommendations: 1, groupedRecommendations: 1 },
      scorecards: [],
    });

    await runCli(["self-improvement", "scorecard", "--days", "7", "--limit", "5"]);

    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "selfImprovement.scorecard",
      expect.any(Object),
      { days: 7, limit: 5 },
      { expectFinal: false },
    );
    expect(runtimeLogs[0]).toContain("Active 1");
  });

  it("routes health options to the health RPC and supports readiness gates", async () => {
    callGatewayFromCli.mockResolvedValueOnce({
      current: {
        status: "degraded",
        score: 72,
        trend: "worsening",
        generatedAt: Date.parse("2026-06-06T12:00:00.000Z"),
        dimensions: [
          {
            id: "reviewer",
            status: "degraded",
            score: 70,
            summary: "Latest reviewer eval is stale.",
            blockers: ["Latest reviewer eval is stale."],
          },
        ],
        nextActions: ["Run reviewer evals."],
      },
      snapshots: [{ id: "sih_1" }],
    });

    await runCli(["self-improvement", "health", "--days", "7", "--limit", "5"]);

    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "selfImprovement.health",
      expect.any(Object),
      { days: 7, limit: 5 },
      { expectFinal: false },
    );
    expect(runtimeLogs[0]).toContain("Operational health degraded");
    expect(runtimeLogs[1]).toContain("reviewer");

    callGatewayFromCli.mockResolvedValueOnce({
      current: {
        status: "degraded",
        score: 72,
        trend: "worsening",
        generatedAt: Date.parse("2026-06-06T12:00:00.000Z"),
        dimensions: [],
        nextActions: [],
      },
      snapshots: [],
    });
    resetRuntimeCapture();

    await runCli(["self-improvement", "health", "--fail-on-degraded"]);

    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("routes production-check options and supports readiness exits", async () => {
    callGatewayFromCli.mockResolvedValueOnce({
      checkedAt: Date.parse("2026-06-06T12:00:00.000Z"),
      status: "blocked",
      ready: false,
      score: 40,
      blockers: ["Model readiness proof is required."],
      warnings: ["No retention maintenance audit event is recorded yet."],
      evidence: [
        {
          key: "models",
          label: "Model readiness",
          status: "blocked",
          summary: "Latest model preflight is blocked.",
        },
      ],
    });

    await runCli([
      "self-improvement",
      "production-check",
      "--days",
      "7",
      "--limit",
      "5",
      "--require-model-ready",
      "--require-evals-ready",
      "--fail-on-blocked",
    ]);

    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "selfImprovement.productionCheck",
      expect.any(Object),
      {
        days: 7,
        limit: 5,
        failOnDegraded: false,
        failOnBlocked: true,
        requireModelReady: true,
        requireEvalsReady: true,
      },
      { expectFinal: false },
    );
    expect(runtimeLogs[0]).toContain("Production check blocked");
    expect(runtimeLogs[1]).toContain("Model readiness proof");
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("routes maintenance dry-run and apply commands", async () => {
    callGatewayFromCli.mockResolvedValueOnce({
      maintainedAt: Date.parse("2026-06-06T12:00:00.000Z"),
      dryRun: true,
      applied: false,
      stores: [
        {
          store: "recommendations",
          before: 2,
          after: 1,
          pruned: 1,
          retainedActive: 1,
          retentionDays: 90,
        },
      ],
      totalBefore: 2,
      totalAfter: 1,
      totalPruned: 1,
    });

    await runCli(["self-improvement", "maintain", "--dry-run"]);

    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "selfImprovement.maintenance.run",
      expect.any(Object),
      { apply: false },
      { expectFinal: false },
    );
    expect(runtimeLogs[0]).toContain("Retention maintenance dry run");

    callGatewayFromCli.mockResolvedValueOnce({
      maintainedAt: Date.parse("2026-06-06T12:00:00.000Z"),
      dryRun: false,
      applied: true,
      stores: [],
      totalBefore: 0,
      totalAfter: 0,
      totalPruned: 0,
      auditEventId: "sie_maintenance",
    });
    resetRuntimeCapture();

    await runCli(["self-improvement", "maintain", "--apply"]);

    expect(callGatewayFromCli).toHaveBeenLastCalledWith(
      "selfImprovement.maintenance.run",
      expect.any(Object),
      { apply: true },
      { expectFinal: false },
    );
    expect(runtimeLogs.join("\n")).toContain("Audit event: sie_maintenance");
  });

  it("routes audit event filters to the audit ledger RPC", async () => {
    callGatewayFromCli.mockResolvedValueOnce({
      events: [
        {
          id: "sie_1",
          createdAt: Date.parse("2026-05-07T12:00:00.000Z"),
          kind: "model_preflight",
          actor: "gateway",
          targetId: "self-improvement-models",
          summary: "Checked Self-Improvement model readiness: degraded.",
          metadata: {
            readiness: "degraded",
            attemptCount: 2,
            blockedRemediationHints: [
              "primaryReview: Run openclaw self-improvement models template.",
            ],
          },
        },
      ],
      total: 1,
    });

    await runCli([
      "self-improvement",
      "audit-events",
      "--kind",
      "model_preflight,analysis_run",
      "--limit",
      "5",
    ]);

    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "selfImprovement.auditEvents.list",
      expect.any(Object),
      { kind: ["model_preflight", "analysis_run"], limit: 5 },
      { expectFinal: false },
    );
    expect(runtimeLogs[0]).toContain("model_preflight/gateway");
    expect(runtimeLogs[0]).toContain("Checked Self-Improvement model readiness");
    expect(runtimeLogs[1]).toContain("readiness=degraded");
    expect(runtimeLogs[1]).toContain("blockedRemediationHints=primaryReview");
  });

  it("prints the read-only local model setup template without calling the Gateway", async () => {
    await runCli(["self-improvement", "models", "template"]);

    expect(callGatewayFromCli).not.toHaveBeenCalled();
    expect(runtimeLogs[0]).toContain("ollama/qwen3.6:27b-q8_0");
    expect(runtimeLogs.join("\n")).toContain("ollama/qwen3.6:27b-q8_0");
    expect(runtimeLogs.join("\n")).toContain("ollama/openclaw-control-qwen3-30b-q6-chatfix:latest");
    expect(runtimeLogs.join("\n")).toContain("ollama/openclaw-strategic-qwen3-235b:latest");
    expect(runtimeLogs.join("\n")).toContain("kimi-local/moonshotai/Kimi-K2.6");
    expect(runtimeLogs.join("\n")).toContain(
      "openclaw infer model run --model ollama/qwen3.6:27b-q8_0",
    );
    expect(runtimeLogs.join("\n")).toContain(
      "Config patch: not required for the default local-only policy.",
    );
    expect(runtimeLogs.join("\n")).toContain("This template is read-only");
  });

  it("routes analysis requests to the analysis RPC", async () => {
    callGatewayFromCli.mockResolvedValueOnce({
      mode: "fallback",
      ready: true,
      readiness: "degraded",
      confidence: 0.74,
      readyTier: "crossCheck",
      readyModelId: "ollama/openclaw-control-qwen3-30b-q6-chatfix:latest",
      groupsAnalyzed: 2,
      groupsReviewedByLlm: 0,
      groupsReviewedByLocalLlm: 0,
      attempts: [
        {
          attempt: 1,
          tier: "crossCheck",
          modelId: "ollama/openclaw-control-qwen3-30b-q6-chatfix:latest",
          status: "invalid_json",
          local: true,
          schemaValidated: false,
          groupsReviewed: 0,
          preflightStatus: "passed",
          preflightSource: "default_ollama",
          providerConfigured: false,
          preflightMs: 7,
          completionMs: 1234,
          diagnostic: "missing_required_fields",
          error:
            "Reviewer returned invalid JSON. Reason: review groups were missing summary, recommendedAction, or confidence.",
        },
      ],
      schemaValidated: false,
      preflightStatus: "unavailable",
      proposalsCreated: 1,
      fallbackReason: "LLM analysis was requested.",
      blockedPrimaryReason: "Local model preflight could not find qwen3.6:27b-q8_0.",
    });

    await runCli([
      "self-improvement",
      "analyze",
      "--limit",
      "12",
      "--llm",
      "--approve-llm-review",
      "--model",
      "gpt-5.5",
      "--review-model",
      "ollama/qwen3.6:27b-q8_0",
      "--fallback-model",
      "ollama/openclaw-control-qwen3-30b-q6-chatfix:latest",
      "--strategic-model",
      "ollama/openclaw-strategic-qwen3-235b:latest",
      "--local-first",
      "--allow-strategic-local",
      "--allow-hosted-escalation",
      "--reviewer-agent",
      "self-improvement-governor",
    ]);

    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "selfImprovement.analysis.run",
      expect.any(Object),
      {
        limit: 12,
        llm: true,
        llmApproval: true,
        modelId: "gpt-5.5",
        reviewModelId: "ollama/qwen3.6:27b-q8_0",
        fallbackModelId: "ollama/openclaw-control-qwen3-30b-q6-chatfix:latest",
        strategicModelId: "ollama/openclaw-strategic-qwen3-235b:latest",
        localFirst: true,
        allowStrategicLocal: true,
        allowHostedEscalation: true,
        reviewerAgentId: "self-improvement-governor",
      },
      { expectFinal: false },
    );
    expect(runtimeLogs[0]).toContain("Analysis fallback");
    expect(runtimeLogs[0]).toContain("confidence 74%");
    expect(runtimeLogs[0]).toContain("readiness degraded");
    expect(runtimeLogs[0]).toContain(
      "ready true via crossCheck ollama/openclaw-control-qwen3-30b-q6-chatfix:latest",
    );
    expect(runtimeLogs[0]).toContain("preflight unavailable");
    expect(runtimeLogs[1]).toContain("Attempt 1 crossCheck invalid_json");
    expect(runtimeLogs[1]).toContain("completion 1234ms");
    expect(runtimeLogs[1]).toContain("source default_ollama");
    expect(runtimeLogs[1]).toContain("provider default");
    expect(runtimeLogs[1]).toContain("diagnostic missing_required_fields");
    expect(runtimeLogs[2]).toContain("Model fallback");
    expect(runtimeLogs[3]).toContain("Primary blocked");
  });

  it("routes reviewer eval runs and prints scorecard health", async () => {
    callGatewayFromCli.mockResolvedValueOnce({
      evaluatedAt: Date.parse("2026-06-06T12:00:00.000Z"),
      fixtureSet: "smoke",
      ready: false,
      readiness: "degraded",
      reviewPolicy: "local_first",
      reviewModelId: "ollama/qwen3.6:27b-q8_0",
      modelId: "ollama/qwen3.6:27b-q8_0",
      localFirst: true,
      scorecard: {
        casesTotal: 2,
        casesPassed: 1,
        passRate: 0.5,
        schemaValidRate: 1,
        safetyPassRate: 0.5,
        routePreservationRate: 1,
        p95CompletionMs: 4321,
        diagnostics: [{ code: "unsafe_action", count: 1 }],
      },
      cases: [
        {
          caseId: "skill_workshop_pending_only",
          passed: false,
          diagnostics: ["unsafe_action"],
        },
      ],
    });

    await runCli([
      "self-improvement",
      "evals",
      "run",
      "--fixture-set",
      "smoke",
      "--limit",
      "2",
      "--review-model",
      "ollama/qwen3.6:27b-q8_0",
      "--fallback-model",
      "ollama/openclaw-control-qwen3-30b-q6-chatfix:latest",
      "--strategic-model",
      "ollama/openclaw-strategic-qwen3-235b:latest",
      "--allow-strategic-local",
      "--reviewer-agent",
      "self-improvement-governor",
      "--fail-on-threshold",
    ]);

    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "selfImprovement.evals.run",
      expect.any(Object),
      {
        fixtureSet: "smoke",
        limit: 2,
        reviewModelId: "ollama/qwen3.6:27b-q8_0",
        fallbackModelId: "ollama/openclaw-control-qwen3-30b-q6-chatfix:latest",
        strategicModelId: "ollama/openclaw-strategic-qwen3-235b:latest",
        localFirst: true,
        allowStrategicLocal: true,
        allowHostedEscalation: false,
        llmApproval: false,
        reviewerAgentId: "self-improvement-governor",
        failOnThreshold: true,
      },
      { expectFinal: false },
    );
    expect(runtimeLogs[0]).toContain("Reviewer eval degraded");
    expect(runtimeLogs[0]).toContain("pass 50%");
    expect(runtimeLogs[0]).toContain("schema 100%");
    expect(runtimeLogs[1]).toContain("Failed skill_workshop_pending_only: unsafe_action");
    expect(runtimeLogs[2]).toContain("unsafe_action=1");
  });

  it("routes local-first model preflight requests to the readiness RPC", async () => {
    callGatewayFromCli.mockResolvedValueOnce({
      checkedAt: Date.parse("2026-05-07T12:00:00.000Z"),
      ready: false,
      readiness: "blocked",
      reviewPolicy: "local_first",
      reviewModelId: "ollama/qwen3.6:27b-q8_0",
      fallbackModelId: "ollama/openclaw-control-qwen3-30b-q6-chatfix:latest",
      strategicModelId: "ollama/openclaw-strategic-qwen3-235b:latest",
      localFirst: true,
      hostedEscalationAllowed: false,
      strategicLocalAllowed: true,
      strategicRequested: true,
      attempts: [
        {
          attempt: 1,
          tier: "primaryReview",
          modelId: "ollama/qwen3.6:27b-q8_0",
          status: "blocked",
          local: true,
          schemaValidated: false,
          groupsReviewed: 0,
          preflightStatus: "missing_config",
          preflightMs: 1,
          error: "Local model preflight could not find qwen3.6:27b-q8_0.",
          remediationHint:
            "Verify Ollama is running and the selected local model appears in the local /api/tags catalog, then rerun openclaw self-improvement preflight.",
        },
        {
          attempt: 2,
          tier: "crossCheck",
          modelId: "ollama/openclaw-control-qwen3-30b-q6-chatfix:latest",
          status: "blocked",
          local: true,
          schemaValidated: false,
          groupsReviewed: 0,
          preflightStatus: "missing_config",
          preflightMs: 1,
          error:
            "Local model preflight could not find openclaw-control-qwen3-30b-q6-chatfix:latest.",
        },
        {
          attempt: 3,
          tier: "strategic",
          modelId: "ollama/openclaw-strategic-qwen3-235b:latest",
          status: "blocked",
          local: true,
          schemaValidated: false,
          groupsReviewed: 0,
          preflightStatus: "missing_config",
          preflightMs: 1,
          error: "Local model preflight could not find openclaw-strategic-qwen3-235b:latest.",
          remediationHint:
            "Verify Ollama is running and the selected local model appears in the local /api/tags catalog, then rerun openclaw self-improvement preflight.",
        },
      ],
      preflightStatus: "missing_config",
      preflightMs: 1,
      schemaValidated: false,
      fallbackReason: "Local model preflight could not find openclaw-strategic-qwen3-235b:latest.",
      blockedPrimaryReason:
        "Local model preflight could not find openclaw-strategic-qwen3-235b:latest.",
    });

    await runCli([
      "self-improvement",
      "preflight",
      "--review-model",
      "ollama/qwen3.6:27b-q8_0",
      "--fallback-model",
      "ollama/openclaw-control-qwen3-30b-q6-chatfix:latest",
      "--strategic-model",
      "ollama/openclaw-strategic-qwen3-235b:latest",
      "--strategic",
      "--allow-strategic-local",
      "--reviewer-agent",
      "self-improvement-governor",
    ]);

    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "selfImprovement.models.preflight",
      expect.any(Object),
      {
        llm: false,
        llmApproval: false,
        modelId: undefined,
        reviewModelId: "ollama/qwen3.6:27b-q8_0",
        fallbackModelId: "ollama/openclaw-control-qwen3-30b-q6-chatfix:latest",
        strategicModelId: "ollama/openclaw-strategic-qwen3-235b:latest",
        localFirst: true,
        allowStrategicLocal: true,
        allowHostedEscalation: false,
        strategic: true,
        reviewerAgentId: "self-improvement-governor",
      },
      { expectFinal: false },
    );
    expect(runtimeLogs[0]).toContain("Model preflight blocked");
    expect(runtimeLogs[0]).toContain("ready false");
    expect(runtimeLogs[1]).toContain("Attempt 1 primaryReview blocked");
    expect(runtimeLogs[2]).toContain("Attempt 2 crossCheck blocked");
    expect(runtimeLogs[3]).toContain("Attempt 3 strategic blocked");
    expect(runtimeLogs[3]).toContain("next Verify Ollama is running");
    expect(runtimeLogs[4]).toContain("Model fallback");
    expect(runtimeLogs[5]).toContain("Primary blocked");
  });

  it("prints degraded model preflight readiness with the usable fallback tier", async () => {
    callGatewayFromCli.mockResolvedValueOnce({
      checkedAt: Date.parse("2026-05-07T12:00:00.000Z"),
      ready: true,
      readiness: "degraded",
      readyTier: "crossCheck",
      readyModelId: "ollama/openclaw-control-qwen3-30b-q6-chatfix:latest",
      reviewPolicy: "local_first",
      reviewModelId: "ollama/qwen3.6:27b-q8_0",
      fallbackModelId: "ollama/openclaw-control-qwen3-30b-q6-chatfix:latest",
      strategicModelId: "ollama/openclaw-strategic-qwen3-235b:latest",
      localFirst: true,
      hostedEscalationAllowed: false,
      strategicLocalAllowed: false,
      strategicRequested: false,
      attempts: [
        {
          attempt: 1,
          tier: "primaryReview",
          modelId: "ollama/qwen3.6:27b-q8_0",
          status: "blocked",
          local: true,
          schemaValidated: false,
          groupsReviewed: 0,
          preflightStatus: "missing_config",
          preflightMs: 1,
          error: "Local model preflight could not find qwen3.6:27b-q8_0.",
          remediationHint:
            "Verify Ollama is running and the selected local model appears in the local /api/tags catalog, then rerun openclaw self-improvement preflight.",
        },
        {
          attempt: 2,
          tier: "crossCheck",
          modelId: "ollama/openclaw-control-qwen3-30b-q6-chatfix:latest",
          status: "success",
          local: true,
          schemaValidated: false,
          groupsReviewed: 0,
          preflightStatus: "passed",
          preflightSource: "default_ollama",
          providerConfigured: false,
          preflightMs: 6,
        },
      ],
      preflightStatus: "missing_config",
      preflightMs: 7,
      schemaValidated: false,
      blockedPrimaryReason: "Local model preflight could not find qwen3.6:27b-q8_0.",
    });

    await runCli(["self-improvement", "preflight"]);

    expect(runtimeLogs[0]).toContain("Model preflight degraded");
    expect(runtimeLogs[0]).toContain("ready true");
    expect(runtimeLogs[0]).toContain(
      "ready via crossCheck ollama/openclaw-control-qwen3-30b-q6-chatfix:latest",
    );
    expect(runtimeLogs[1]).toContain("next Verify Ollama is running");
    expect(runtimeLogs[2]).toContain("source default_ollama");
    expect(runtimeLogs[2]).toContain("provider default");
    expect(runtimeLogs[3]).toContain("Primary blocked");
  });

  it("routes update status to the update RPC", async () => {
    await runCli([
      "self-improvement",
      "update",
      "sir_1",
      "--status",
      "resolved",
      "--note",
      "reviewed",
      "--assign",
      "qa-test-agent",
      "--claimed-by",
      "QA Test Agent",
      "--proof",
      "pnpm test src/self-improvement/auditor.test.ts passed",
    ]);

    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "selfImprovement.recommendations.update",
      expect.any(Object),
      {
        id: "sir_1",
        status: "resolved",
        note: "reviewed",
        assignedTargetAgentId: "qa-test-agent",
        claimedBy: "QA Test Agent",
        resolutionProof: "pnpm test src/self-improvement/auditor.test.ts passed",
        dismissalReason: undefined,
      },
      { expectFinal: false },
    );
  });

  it("routes assign and prove convenience commands to recommendation updates", async () => {
    await runCli([
      "self-improvement",
      "assign",
      "sir_1",
      "--agent",
      "qa-test-agent",
      "--claimed-by",
      "QA Test Agent",
      "--note",
      "owned by QA",
    ]);
    await runCli([
      "self-improvement",
      "prove",
      "sir_1",
      "--proof",
      "pnpm test src/self-improvement/actionability.test.ts passed",
      "--resolve",
    ]);

    expect(callGatewayFromCli).toHaveBeenNthCalledWith(
      1,
      "selfImprovement.recommendations.update",
      expect.any(Object),
      {
        id: "sir_1",
        status: "assigned",
        note: "owned by QA",
        assignedTargetAgentId: "qa-test-agent",
        claimedBy: "QA Test Agent",
      },
      { expectFinal: false },
    );
    expect(callGatewayFromCli).toHaveBeenNthCalledWith(
      2,
      "selfImprovement.recommendations.update",
      expect.any(Object),
      {
        id: "sir_1",
        status: "resolved",
        note: undefined,
        resolutionProof: "pnpm test src/self-improvement/actionability.test.ts passed",
      },
      { expectFinal: false },
    );
  });

  it("routes group updates to the group update RPC", async () => {
    await runCli([
      "self-improvement",
      "groups",
      "update",
      "sig_1",
      "--status",
      "resolved",
      "--proof",
      "pnpm test src/self-improvement/analysis.test.ts passed",
    ]);

    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "selfImprovement.groups.update",
      expect.any(Object),
      {
        id: "sig_1",
        status: "resolved",
        note: undefined,
        assignedTargetAgentId: undefined,
        claimedBy: undefined,
        resolutionProof: "pnpm test src/self-improvement/analysis.test.ts passed",
        dismissalReason: undefined,
      },
      { expectFinal: false },
    );
  });

  it("routes group proof convenience command to the group update RPC", async () => {
    await runCli([
      "self-improvement",
      "groups",
      "prove",
      "sig_1",
      "--proof",
      "pnpm test src/self-improvement/summary.test.ts passed",
      "--resolve",
    ]);

    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "selfImprovement.groups.update",
      expect.any(Object),
      {
        id: "sig_1",
        status: "resolved",
        note: undefined,
        resolutionProof: "pnpm test src/self-improvement/summary.test.ts passed",
      },
      { expectFinal: false },
    );
  });

  it("routes proposal list and update commands", async () => {
    await runCli([
      "self-improvement",
      "proposals",
      "list",
      "--status",
      "pending",
      "--kind",
      "verification",
      "--limit",
      "10",
    ]);
    await runCli([
      "self-improvement",
      "proposals",
      "update",
      "sip_1",
      "--status",
      "approved",
      "--proof",
      "operator approved",
    ]);

    expect(callGatewayFromCli).toHaveBeenNthCalledWith(
      1,
      "selfImprovement.proposals.list",
      expect.any(Object),
      { status: ["pending"], kind: ["verification"], limit: 10 },
      { expectFinal: false },
    );
    expect(callGatewayFromCli).toHaveBeenNthCalledWith(
      2,
      "selfImprovement.proposals.update",
      expect.any(Object),
      {
        id: "sip_1",
        status: "approved",
        note: undefined,
        approvalProof: "operator approved",
        dismissalReason: undefined,
      },
      { expectFinal: false },
    );
  });

  it("routes curator list, show, accept, link, reject, and promotion-proof commands", async () => {
    callGatewayFromCli.mockResolvedValue({
      proposals: [
        {
          id: "sip_memory",
          kind: "memory_skill",
          status: "pending",
          curatorStatus: "pending_review",
          route: { targetAgentLabel: "Memory/Knowledge Curator" },
          title: "Pending memory update",
        },
      ],
      total: 1,
    });

    await runCli([
      "self-improvement",
      "curator",
      "list",
      "--status",
      "pending_review,accepted_for_workshop",
      "--limit",
      "5",
    ]);
    await runCli(["self-improvement", "curator", "show", "sip_memory"]);
    await runCli([
      "self-improvement",
      "curator",
      "accept",
      "sip_memory",
      "--proof",
      "reviewed against Skill Workshop pending mode",
      "--workshop-proposal-id",
      "swp_memory_1",
    ]);
    await runCli([
      "self-improvement",
      "curator",
      "workshop-link",
      "sip_memory",
      "--workshop-proposal-id",
      "swp_memory_1",
      "--proof",
      "pending proposal created",
    ]);
    await runCli([
      "self-improvement",
      "curator",
      "reject",
      "sip_memory",
      "--reason",
      "duplicate memory proposal",
    ]);
    await runCli([
      "self-improvement",
      "curator",
      "promote-proof",
      "sip_memory",
      "--proof",
      "Skill Workshop item applied",
      "--workshop-proposal-id",
      "swp_memory_1",
    ]);

    expect(callGatewayFromCli).toHaveBeenNthCalledWith(
      1,
      "selfImprovement.curator.list",
      expect.any(Object),
      { status: ["pending_review", "accepted_for_workshop"], limit: 5 },
      { expectFinal: false },
    );
    expect(callGatewayFromCli).toHaveBeenNthCalledWith(
      2,
      "selfImprovement.curator.get",
      expect.any(Object),
      { id: "sip_memory" },
      { expectFinal: false },
    );
    expect(callGatewayFromCli).toHaveBeenNthCalledWith(
      3,
      "selfImprovement.curator.update",
      expect.any(Object),
      {
        id: "sip_memory",
        curatorStatus: "accepted_for_workshop",
        proof: "reviewed against Skill Workshop pending mode",
        workshopProposalId: "swp_memory_1",
        workshopProposalStatus: "pending",
        note: undefined,
      },
      { expectFinal: false },
    );
    expect(callGatewayFromCli).toHaveBeenNthCalledWith(
      4,
      "selfImprovement.curator.update",
      expect.any(Object),
      {
        id: "sip_memory",
        curatorStatus: "accepted_for_workshop",
        proof: "pending proposal created",
        workshopProposalId: "swp_memory_1",
        workshopProposalStatus: "pending",
        note: undefined,
      },
      { expectFinal: false },
    );
    expect(callGatewayFromCli).toHaveBeenNthCalledWith(
      5,
      "selfImprovement.curator.update",
      expect.any(Object),
      {
        id: "sip_memory",
        curatorStatus: "rejected",
        reason: "duplicate memory proposal",
        note: undefined,
      },
      { expectFinal: false },
    );
    expect(callGatewayFromCli).toHaveBeenNthCalledWith(
      6,
      "selfImprovement.curator.update",
      expect.any(Object),
      {
        id: "sip_memory",
        curatorStatus: "promoted",
        proof: "Skill Workshop item applied",
        workshopProposalId: "swp_memory_1",
        workshopProposalStatus: "applied",
        note: undefined,
      },
      { expectFinal: false },
    );
    expect(runtimeLogs[0]).toContain("curator pending_review");
  });
});
