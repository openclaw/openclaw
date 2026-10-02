import { describe, expect, it } from "vitest";
import { normalizeClawHubSha256Integrity } from "../infra/clawhub-integrity.js";
import {
  projectClawAddPlan,
  projectClawRemovePlan,
  projectClawUpdatePlan,
} from "./gateway-plan-projection.js";
import type { ClawRemovePlan } from "./lifecycle-remove-contract.js";
import { projectClawPackageRemovePlan } from "./package-remove-plan.js";
import { digestClawPackageRef } from "./package-update-provenance.js";
import type { PersistedClawPackageRef } from "./provenance.js";
import type { ClawAddPlan, ClawAddPlanAction } from "./types.js";
import { makeEmptyClawUpdatePlan } from "./update-plan-empty.js";

const root = "/tmp/claw-skill-artifact-review";
const oldIntegrity = `sha256:${"a".repeat(64)}`;
const newIntegrity = `sha256:${"b".repeat(64)}`;
const addConfig = { agents: { list: [] } };
const config = { agents: { list: [{ id: "worker" }] } };

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

function currentSkillRef(): PersistedClawPackageRef {
  return {
    schemaVersion: "openclaw.clawPackageRef.v1",
    agentId: "worker",
    clawName: "@openclaw/worker",
    kind: "skill",
    source: "clawhub",
    ref: "triage",
    version: "1.0.0",
    integrity: oldIntegrity,
    status: "complete",
    relationship: "managed",
    origin: "claw-introduced",
    independentOwner: false,
    installedAtMs: 1,
    updatedAtMs: 1,
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

  it("shows current and desired skill artifacts on Update and blocks an undisclosed target", () => {
    const current = currentSkillRef();
    const plan = makeEmptyClawUpdatePlan({
      agentId: "worker",
      source: addPlan().claw,
      found: true,
      blockers: [],
    });
    plan.actions.push({
      kind: "package",
      id: "skill:triage",
      action: "change",
      target: "clawhub:triage@2.0.0",
      blocked: false,
      reason: "Update the skill.",
      currentDigest: digestClawPackageRef(current),
      desiredDigest: "sha256:next-ref",
    });
    const review = {
      config,
      desiredAgent: { id: "worker" },
      currentJobs: [],
      targetJobs: [],
      targetActions: [skillAction("2.0.0", newIntegrity)],
      currentPackages: [current],
    };
    const projected = projectClawUpdatePlan(plan, root, review);
    expect(projected.blockers).toEqual([]);
    expect(projected.actions[0]?.effect).toEqual({
      type: "skill-package",
      current: {
        source: "clawhub",
        ref: "triage",
        version: "1.0.0",
        integrity: normalizeClawHubSha256Integrity(oldIntegrity),
      },
      desired: {
        source: "clawhub",
        ref: "triage",
        version: "2.0.0",
        integrity: normalizeClawHubSha256Integrity(newIntegrity),
      },
    });

    const missing = projectClawUpdatePlan(plan, root, { ...review, targetActions: [] });
    expect(missing.blockers).toContainEqual(
      expect.objectContaining({ code: "effect_disclosure_unavailable" }),
    );
    const missingCurrent = projectClawUpdatePlan(plan, root, {
      ...review,
      currentPackages: [],
    });
    expect(missingCurrent.blockers).toContainEqual(
      expect.objectContaining({ code: "effect_disclosure_unavailable" }),
    );
  });

  it("shows the retained artifact when Update releases a skill", () => {
    const current = currentSkillRef();
    const plan = makeEmptyClawUpdatePlan({
      agentId: "worker",
      source: addPlan().claw,
      found: true,
      blockers: [],
    });
    plan.actions.push({
      kind: "package",
      id: "skill:triage",
      action: "release",
      target: "clawhub:triage@1.0.0",
      blocked: false,
      reason: "Release the skill.",
      currentDigest: digestClawPackageRef(current),
    });
    const projected = projectClawUpdatePlan(plan, root, {
      config,
      desiredAgent: { id: "worker" },
      currentJobs: [],
      targetJobs: [],
      currentPackages: [current],
    });
    expect(projected.blockers).toEqual([]);
    expect(projected.actions[0]?.effect).toEqual({
      type: "skill-package",
      current: {
        source: "clawhub",
        ref: "triage",
        version: "1.0.0",
        integrity: normalizeClawHubSha256Integrity(oldIntegrity),
      },
    });
  });

  it("binds Remove's skill artifact and ownership to the review", () => {
    const pkg = currentSkillRef();
    const packageActions = projectClawPackageRemovePlan({
      decisions: [
        {
          packageRef: pkg,
          workspace: "/tmp/worker",
          action: "uninstall",
          affectedClawAgentIds: [],
        },
      ],
      inspections: [{ ...pkg, state: "present" }],
    }).actions;
    const plan: ClawRemovePlan = {
      schemaVersion: "openclaw.clawRemovePlan.v1",
      stability: "experimental",
      dryRun: true,
      mutationAllowed: false,
      planIntegrity: "sha256:remove",
      target: "worker",
      agentId: "worker",
      blockers: [],
      actions: packageActions,
    };
    const projected = projectClawRemovePlan(plan);
    expect(projected.blockers).toEqual([]);
    expect(projected.actions[0]?.effect).toEqual({
      type: "skill-package",
      current: {
        source: "clawhub",
        ref: "triage",
        version: "1.0.0",
        integrity: normalizeClawHubSha256Integrity(oldIntegrity),
      },
      ownership: {
        relationship: "managed",
        origin: "claw-introduced",
        independentOwner: false,
        affectedClawCount: 0,
      },
    });

    delete plan.actions[0]?.details?.integrity;
    expect(projectClawRemovePlan(plan).blockers).toContainEqual(
      expect.objectContaining({ code: "effect_disclosure_unavailable" }),
    );
  });
});
