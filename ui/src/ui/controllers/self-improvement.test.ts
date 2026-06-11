import { describe, expect, it, vi } from "vitest";
import {
  loadSelfImprovementRecommendations,
  runSelfImprovementMaintenanceDryRun,
  runSelfImprovementProductionCheck,
  updateSelfImprovementCuratorProposal,
  updateSelfImprovementGroup,
  updateSelfImprovementRecommendation,
  type SelfImprovementState,
} from "./self-improvement.ts";

function createState(): { state: SelfImprovementState; request: ReturnType<typeof vi.fn> } {
  const request = vi.fn();
  const state: SelfImprovementState = {
    client: {
      request,
    } as unknown as SelfImprovementState["client"],
    connected: true,
    selfImprovementLoading: false,
    selfImprovementError: null,
    selfImprovementRecommendations: [],
    selfImprovementGroups: [],
    selfImprovementScorecard: null,
    selfImprovementScorecards: [],
    selfImprovementHealth: null,
    selfImprovementProposals: [],
    selfImprovementAuditEvents: [],
    selfImprovementTotal: 0,
    selfImprovementScanLoading: false,
    selfImprovementLastScan: null,
    selfImprovementAnalysisLoading: false,
    selfImprovementLastAnalysis: null,
    selfImprovementModelPreflightLoading: false,
    selfImprovementLastModelPreflight: null,
    selfImprovementProductionCheckLoading: false,
    selfImprovementLastProductionCheck: null,
    selfImprovementMaintenanceLoading: false,
    selfImprovementLastMaintenance: null,
  };
  return { state, request };
}

describe("loadSelfImprovementRecommendations", () => {
  it("loads recent sanitized audit events with the dashboard recommendation snapshot", async () => {
    const { state, request } = createState();
    request.mockImplementation((method: string) => {
      if (method === "selfImprovement.summary") {
        return Promise.resolve({
          scorecard: {
            activeRecommendations: 1,
            groupedRecommendations: 0,
            criticalOpen: 0,
            highOpen: 1,
            testRequired: 0,
            approvalRequired: 0,
            reopenedLast24h: 0,
            resolvedLast24h: 0,
            byCategory: [],
            byRoute: [],
            needsApproval: [],
            whatImproved: [],
            whatWorsened: [],
          },
          groups: [],
        });
      }
      if (method === "selfImprovement.recommendations.list") {
        return Promise.resolve({ recommendations: [], total: 1 });
      }
      if (method === "selfImprovement.scorecard") {
        return Promise.resolve({ current: null, scorecards: [] });
      }
      if (method === "selfImprovement.health") {
        return Promise.resolve({
          current: {
            generatedAt: Date.parse("2026-05-07T12:00:00.000Z"),
            status: "degraded",
            score: 72,
            trend: "worsening",
            intervalMs: 21_600_000,
            staleAfterMs: 43_200_000,
            dimensions: [],
            blockers: ["Latest model preflight is degraded."],
            nextActions: ["Run preflight."],
          },
          snapshots: [],
        });
      }
      if (method === "selfImprovement.proposals.list") {
        return Promise.resolve({ proposals: [], total: 0 });
      }
      if (method === "selfImprovement.curator.list") {
        return Promise.resolve({
          proposals: [
            {
              id: "sip_memory",
              kind: "memory_skill",
              status: "pending",
              curatorStatus: "pending_review",
            },
          ],
          total: 1,
        });
      }
      if (method === "selfImprovement.auditEvents.list") {
        return Promise.resolve({
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
                primaryRemediationHint:
                  "Run openclaw self-improvement models template, then rerun preflight.",
              },
            },
          ],
          total: 1,
        });
      }
      throw new Error(`unexpected method ${method}`);
    });

    await loadSelfImprovementRecommendations(state);

    expect(request).toHaveBeenCalledWith(
      "selfImprovement.health",
      { days: 14, limit: 14 },
      { timeoutMs: 15_000 },
    );
    expect(request).toHaveBeenCalledWith(
      "selfImprovement.curator.list",
      { limit: 50 },
      { timeoutMs: 15_000 },
    );
    expect(request).toHaveBeenCalledWith(
      "selfImprovement.auditEvents.list",
      { limit: 20 },
      { timeoutMs: 15_000 },
    );
    expect(state.selfImprovementHealth?.current.status).toBe("degraded");
    expect(state.selfImprovementProposals).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "sip_memory" })]),
    );
    expect(state.selfImprovementAuditEvents).toHaveLength(1);
    expect(state.selfImprovementAuditEvents[0]?.kind).toBe("model_preflight");
    expect(state.selfImprovementAuditEvents[0]?.metadata?.primaryRemediationHint).toContain(
      "models template",
    );
    expect(state.selfImprovementError).toBeNull();
  });

  it("updates recommendation action state through the Gateway and refreshes", async () => {
    const { state, request } = createState();
    request.mockImplementation((method: string) => {
      if (method === "selfImprovement.recommendations.update") {
        return Promise.resolve({ recommendation: { id: "sir_1" } });
      }
      if (method === "selfImprovement.summary") {
        return Promise.resolve({ scorecard: { activeRecommendations: 0 }, groups: [] });
      }
      if (method === "selfImprovement.recommendations.list") {
        return Promise.resolve({ recommendations: [], total: 0 });
      }
      if (method === "selfImprovement.scorecard") {
        return Promise.resolve({ current: null, scorecards: [] });
      }
      if (method === "selfImprovement.health") {
        return Promise.resolve(null);
      }
      if (method === "selfImprovement.proposals.list") {
        return Promise.resolve({ proposals: [], total: 0 });
      }
      if (method === "selfImprovement.curator.list") {
        return Promise.resolve({ proposals: [], total: 0 });
      }
      if (method === "selfImprovement.auditEvents.list") {
        return Promise.resolve({ events: [], total: 0 });
      }
      throw new Error(`unexpected method ${method}`);
    });

    await updateSelfImprovementRecommendation(state, {
      id: "sir_1",
      status: "resolved",
      resolutionProof: "pnpm test src/self-improvement/actionability.test.ts passed",
    });

    expect(request).toHaveBeenCalledWith(
      "selfImprovement.recommendations.update",
      {
        id: "sir_1",
        status: "resolved",
        note: undefined,
        assignedTargetAgentId: undefined,
        claimedBy: undefined,
        resolutionProof: "pnpm test src/self-improvement/actionability.test.ts passed",
        dismissalReason: undefined,
      },
      { timeoutMs: 15_000 },
    );
    expect(request).toHaveBeenCalledWith(
      "selfImprovement.summary",
      { limit: 50 },
      { timeoutMs: 15_000 },
    );
    expect(state.selfImprovementError).toBeNull();
  });

  it("updates grouped recommendations through the Gateway and refreshes", async () => {
    const { state, request } = createState();
    request.mockImplementation((method: string) => {
      if (method === "selfImprovement.groups.update") {
        return Promise.resolve({ group: { id: "sig_1" }, recommendations: [] });
      }
      if (method === "selfImprovement.summary") {
        return Promise.resolve({ scorecard: { activeRecommendations: 0 }, groups: [] });
      }
      if (method === "selfImprovement.recommendations.list") {
        return Promise.resolve({ recommendations: [], total: 0 });
      }
      if (method === "selfImprovement.scorecard") {
        return Promise.resolve({ current: null, scorecards: [] });
      }
      if (method === "selfImprovement.health") {
        return Promise.resolve(null);
      }
      if (method === "selfImprovement.proposals.list") {
        return Promise.resolve({ proposals: [], total: 0 });
      }
      if (method === "selfImprovement.curator.list") {
        return Promise.resolve({ proposals: [], total: 0 });
      }
      if (method === "selfImprovement.auditEvents.list") {
        return Promise.resolve({ events: [], total: 0 });
      }
      throw new Error(`unexpected method ${method}`);
    });

    await updateSelfImprovementGroup(state, {
      id: "sig_1",
      status: "assigned",
      assignedTargetAgentId: "qa-test-agent",
    });

    expect(request).toHaveBeenCalledWith(
      "selfImprovement.groups.update",
      {
        id: "sig_1",
        status: "assigned",
        note: undefined,
        assignedTargetAgentId: "qa-test-agent",
        claimedBy: undefined,
        resolutionProof: undefined,
        dismissalReason: undefined,
      },
      { timeoutMs: 15_000 },
    );
    expect(state.selfImprovementError).toBeNull();
  });

  it("updates curator proposals through the Gateway and refreshes", async () => {
    const { state, request } = createState();
    request.mockImplementation((method: string) => {
      if (method === "selfImprovement.curator.update") {
        return Promise.resolve({ proposal: { id: "sip_memory" } });
      }
      if (method === "selfImprovement.summary") {
        return Promise.resolve({ scorecard: { activeRecommendations: 0 }, groups: [] });
      }
      if (method === "selfImprovement.recommendations.list") {
        return Promise.resolve({ recommendations: [], total: 0 });
      }
      if (method === "selfImprovement.scorecard") {
        return Promise.resolve({ current: null, scorecards: [] });
      }
      if (method === "selfImprovement.health") {
        return Promise.resolve(null);
      }
      if (method === "selfImprovement.proposals.list") {
        return Promise.resolve({ proposals: [], total: 0 });
      }
      if (method === "selfImprovement.curator.list") {
        return Promise.resolve({ proposals: [], total: 0 });
      }
      if (method === "selfImprovement.auditEvents.list") {
        return Promise.resolve({ events: [], total: 0 });
      }
      throw new Error(`unexpected method ${method}`);
    });

    await updateSelfImprovementCuratorProposal(state, {
      id: "sip_memory",
      curatorStatus: "accepted_for_workshop",
      proof: "reviewed against Skill Workshop pending mode",
      workshopProposalId: "swp_memory_1",
      workshopProposalStatus: "pending",
    });

    expect(request).toHaveBeenCalledWith(
      "selfImprovement.curator.update",
      {
        id: "sip_memory",
        curatorStatus: "accepted_for_workshop",
        proof: "reviewed against Skill Workshop pending mode",
        reason: undefined,
        workshopProposalId: "swp_memory_1",
        workshopProposalStatus: "pending",
        note: undefined,
      },
      { timeoutMs: 15_000 },
    );
    expect(state.selfImprovementError).toBeNull();
  });

  it("runs a production readiness check without refreshing recommendation state", async () => {
    const { state, request } = createState();
    request.mockResolvedValueOnce({
      checkedAt: Date.parse("2026-05-07T12:00:00.000Z"),
      status: "ready",
      ready: true,
      score: 100,
      evidence: [],
      blockers: [],
      warnings: [],
      nextActions: [],
      health: {
        generatedAt: Date.parse("2026-05-07T12:00:00.000Z"),
        status: "ready",
        score: 100,
        trend: "stable",
        intervalMs: 21_600_000,
        staleAfterMs: 43_200_000,
        dimensions: [],
        blockers: [],
        nextActions: [],
      },
    });

    await runSelfImprovementProductionCheck(state);

    expect(request).toHaveBeenCalledWith(
      "selfImprovement.productionCheck",
      {},
      { timeoutMs: 15_000 },
    );
    expect(state.selfImprovementLastProductionCheck?.status).toBe("ready");
    expect(state.selfImprovementError).toBeNull();
  });

  it("runs retention maintenance as a dry run from the dashboard", async () => {
    const { state, request } = createState();
    request.mockResolvedValueOnce({
      maintainedAt: Date.parse("2026-05-07T12:00:00.000Z"),
      dryRun: true,
      applied: false,
      stores: [],
      totalBefore: 0,
      totalAfter: 0,
      totalPruned: 0,
    });

    await runSelfImprovementMaintenanceDryRun(state);

    expect(request).toHaveBeenCalledWith(
      "selfImprovement.maintenance.run",
      { apply: false },
      { timeoutMs: 15_000 },
    );
    expect(state.selfImprovementLastMaintenance?.dryRun).toBe(true);
    expect(state.selfImprovementError).toBeNull();
  });
});
