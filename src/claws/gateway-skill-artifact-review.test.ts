import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeClawHubSha256Integrity } from "../infra/clawhub-integrity.js";
import { projectClawAddPlan } from "./gateway-plan-projection.js";
import type { ClawAddPlan, ClawAddPlanAction } from "./types.js";

const root = "/tmp/claw-skill-artifact-review";
const oldIntegrity = `sha256:${"a".repeat(64)}`;
const newIntegrity = `sha256:${"b".repeat(64)}`;
const addConfig: OpenClawConfig = { agents: { entries: {} } };

function skillAction(version: string, integrity: string): ClawAddPlanAction {
  return {
    kind: "package",
    id: "skill:triage",
    action: "install",
    target: `clawhub:triage@${version}`,
    digest: integrity,
    blocked: false,
    details: {
      kind: "skill",
      source: "clawhub",
      ref: "triage",
      version,
      integrity,
      ownerAction: "install",
    },
  };
}

function addPlan(): ClawAddPlan {
  return {
    schemaVersion: "openclaw.clawAddPlan.v1",
    manifestSchemaVersion: 1,
    stability: "experimental",
    dryRun: true,
    mutationAllowed: false,
    planIntegrity: "sha256:source",
    claw: {
      kind: "package",
      name: "@openclaw/worker",
      version: "1.0.0",
      packageRoot: root,
      manifestPath: `${root}/CLAW.md`,
      integrityKind: "artifact",
      integrity: oldIntegrity,
      byteLength: 100,
    },
    agent: {
      requestedId: "worker",
      finalId: "worker",
      workspace: "/tmp/worker",
      config: { id: "worker", workspace: "/tmp/worker" },
    },
    summary: {
      totalActions: 1,
      agentActions: 0,
      workspaceActions: 0,
      packageActions: 1,
      mcpServerActions: 0,
      cronJobActions: 0,
      blockedActions: 0,
      capabilityEscalations: 0,
    },
    actions: [skillAction("1.0.0", oldIntegrity)],
    capabilityChanges: [],
    readiness: { ready: true, requirements: [] },
    blockers: [],
    diagnostics: [],
  };
}

describe("Claw skill artifact review", () => {
  it("discloses every Add skill's exact artifact without requiring a trust warning", () => {
    const plan = addPlan();
    const projected = projectClawAddPlan(plan, root, [], addConfig);
    expect(projected.blockers).toEqual([]);
    expect(projected.skillReviews).toEqual([]);
    expect(projected.actions[0]?.effect).toEqual({
      type: "skill-package",
      desired: {
        source: "clawhub",
        ref: "triage",
        version: "1.0.0",
        integrity: normalizeClawHubSha256Integrity(oldIntegrity),
      },
    });
    expect(JSON.stringify(projected)).not.toContain(root);

    const reused = addPlan();
    reused.actions[0]!.action = "reuse";
    reused.actions[0]!.details!.ownerAction = "reuse";
    expect(projectClawAddPlan(reused, root, [], addConfig).actions[0]?.effect).toEqual(
      projected.actions[0]?.effect,
    );

    const missing = addPlan();
    delete missing.actions[0]?.details?.integrity;
    expect(projectClawAddPlan(missing, root, [], addConfig).blockers).toContainEqual(
      expect.objectContaining({ code: "effect_disclosure_unavailable" }),
    );

    const mismatched = addPlan();
    mismatched.actions[0]!.target = "clawhub:other@1.0.0";
    expect(projectClawAddPlan(mismatched, root, [], addConfig).blockers).toContainEqual(
      expect.objectContaining({ code: "effect_disclosure_unavailable" }),
    );

    const stalePreflight = addPlan();
    stalePreflight.actions[0]!.digest = newIntegrity;
    expect(projectClawAddPlan(stalePreflight, root, [], addConfig).blockers).toContainEqual(
      expect.objectContaining({ code: "effect_disclosure_unavailable" }),
    );
  });
});
