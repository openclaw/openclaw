import { describe, expect, it } from "vitest";
import {
  buildModuleDryRunPlan,
  buildProposalOnlyPlan,
} from "../../scripts/generate-openclaw-card-module-dry-run.mjs";

function createGraph(nodeOverrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "openclaw-card-framework-graph",
    source: {
      registryPath: "reports/openclaw-card-framework-cards.json",
    },
    validation: {
      ok: true,
    },
    graph: {
      nodes: [
        {
          id: "module-3d-viewpoint-node-model",
          label: "3D viewpoint node model",
          type: "module",
          openclawTarget: "runtime",
          sourceUrls: ["reports/openclaw-card-framework-graph.json"],
          linksTo: ["contract-3d-viewpoint-node-graph-gate"],
          linkedBy: ["source-3d-viewpoint-node-graph-standards"],
          contract: "read graph only",
          rollbackPath: "rollback graph",
          nextSafeTask: "review plan",
          ...nodeOverrides,
        },
      ],
      links: [],
      missingLinks: [],
      duplicateNodeIds: [],
    },
    viewpoints: [],
  };
}

describe("generate-openclaw-card-module-dry-run", () => {
  it("creates a runtime dry-run plan without writing runtime files", () => {
    const plan = buildModuleDryRunPlan(createGraph());

    expect(plan.ok).toBe(true);
    expect(plan.dryRunOnly).toBe(true);
    expect(plan.sourceGraph).toBe("reports/openclaw-card-framework-graph.json");
    expect(plan.sourceRegistry).toBe("reports/openclaw-card-framework-cards.json");
    expect(plan.summary).toMatchObject({
      candidates: 1,
      runtimeWritesNow: 0,
      externalApiEnabled: false,
      liveTradingEnabled: false,
      applyProposals: 1,
      reviewRequired: 1,
    });
    expect(plan.decisions[0]).toMatchObject({
      cardId: "module-3d-viewpoint-node-model",
      artifactKind: "runtime-module",
      dryRunOnly: true,
      safety: {
        writesRuntimeNow: false,
        externalApiEnabled: false,
        liveTradingEnabled: false,
      },
    });
    expect(plan.decisions[0].wouldWriteFiles).toContain(
      "scripts/module-3d-viewpoint-node-model.mjs",
    );
    expect(plan.decisions[0].wouldRunValidation).toContain("pnpm check:openclaw-card-framework");
    expect(plan.decisions[0].applyProposal).toMatchObject({
      proposalId: "apply-module-3d-viewpoint-node-model",
      mode: "staged-patch-plan",
      requiresCardId: "module-3d-viewpoint-node-model",
      dryRunOnly: true,
      safety: {
        writesRuntimeNow: false,
        externalApiEnabled: false,
        liveTradingEnabled: false,
      },
    });
    expect(plan.decisions[0].applyProposal.preflightCommands).toContain(
      "pnpm check:openclaw-card-framework",
    );
    expect(plan.decisions[0].applyProposal.patchSteps).toContainEqual(
      expect.objectContaining({
        file: "scripts/module-3d-viewpoint-node-model.mjs",
        action: "add",
        templateKind: "runtime-script",
      }),
    );
    expect(plan.decisions[0].applyProposal.postValidationCommands).toContain(
      "pnpm openclaw:card:generate:check",
    );
    expect(plan.decisions[0].applyProposal.rollbackPlan).toMatchObject({
      mode: "planned-files-only",
      runtimeWritesNow: 0,
    });
    expect(plan.decisions[0].applyProposal.blockedUntil).toEqual([
      "human-review-approved",
      "card-framework-pass",
      "graph-export-check-pass",
      "same-case-rerun-pass",
    ]);
  });

  it("can dry-run only a selected card", () => {
    const plan = buildModuleDryRunPlan(createGraph(), {
      cardId: "module-3d-viewpoint-node-model",
    });

    expect(plan.ok).toBe(true);
    expect(plan.selectedCardId).toBe("module-3d-viewpoint-node-model");
    expect(plan.decisions).toHaveLength(1);
  });

  it("can export single-card proposal only", () => {
    const proposalPlan = buildProposalOnlyPlan(createGraph(), {
      cardId: "module-3d-viewpoint-node-model",
    });

    expect(proposalPlan.ok).toBe(true);
    expect(proposalPlan.mode).toBe("proposal-only");
    expect(proposalPlan.selectedCardId).toBe("module-3d-viewpoint-node-model");
    expect(proposalPlan.summary).toMatchObject({
      runtimeWritesNow: 0,
      externalApiEnabled: false,
      liveTradingEnabled: false,
      proposalSteps: 4,
    });
    expect(proposalPlan.proposal).toMatchObject({
      mode: "staged-patch-plan",
      requiresCardId: "module-3d-viewpoint-node-model",
      dryRunOnly: true,
    });
    expect(proposalPlan.proposal.patchSteps).toContainEqual(
      expect.objectContaining({
        file: "scripts/module-3d-viewpoint-node-model.mjs",
        action: "add",
      }),
    );
  });

  it("blocks proposal-only mode when card id is missing", () => {
    const proposalPlan = buildProposalOnlyPlan(createGraph());

    expect(proposalPlan.ok).toBe(false);
    expect(proposalPlan.mode).toBe("proposal-only");
    expect(proposalPlan.failures).toContain("card id is required for proposal-only mode");
  });

  it("blocks when the requested card is missing", () => {
    const plan = buildModuleDryRunPlan(createGraph(), { cardId: "missing-card" });

    expect(plan.ok).toBe(false);
    expect(plan.failures).toContain("card not found: missing-card");
    expect(plan.decisions).toHaveLength(0);
  });

  it("blocks invalid graph input", () => {
    const plan = buildModuleDryRunPlan({
      kind: "openclaw-card-framework-graph",
      validation: { ok: false },
      graph: { nodes: [], missingLinks: [{ source: "a", target: "b" }], duplicateNodeIds: [] },
    });

    expect(plan.ok).toBe(false);
    expect(plan.failures).toContain("graph validation must be ok");
    expect(plan.failures).toContain("graph has missing links");
  });
});
