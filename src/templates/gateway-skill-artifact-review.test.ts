import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeClawHubSha256Integrity } from "../infra/clawhub-integrity.js";
import { projectTemplateAddPlan } from "./gateway-plan-projection.js";
import { packageInstallPlan } from "./packages.test-support.js";

const root = "/tmp/template-skill-artifact-review";
const oldIntegrity = `sha256:${"a".repeat(64)}`;
const newIntegrity = `sha256:${"b".repeat(64)}`;
const addConfig: OpenClawConfig = { agents: { entries: {} } };

function addPlan() {
  const plan = packageInstallPlan([
    {
      kind: "skill",
      source: "clawhub",
      ref: "triage",
      version: "1.0.0",
      integrity: oldIntegrity,
    },
  ]);
  plan.template.packageRoot = root;
  plan.template.manifestPath = `${root}/CLAW.md`;
  plan.actions[0]!.digest = oldIntegrity;
  return plan;
}

describe("Template skill artifact review", () => {
  it("discloses every Add skill's exact artifact without requiring a trust warning", () => {
    const plan = addPlan();
    const projected = projectTemplateAddPlan(plan, root, [], addConfig);
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
    expect(projectTemplateAddPlan(reused, root, [], addConfig).actions[0]?.effect).toEqual(
      projected.actions[0]?.effect,
    );

    const missing = addPlan();
    delete missing.actions[0]?.details?.integrity;
    expect(projectTemplateAddPlan(missing, root, [], addConfig).blockers).toContainEqual(
      expect.objectContaining({ code: "effect_disclosure_unavailable" }),
    );

    const mismatched = addPlan();
    mismatched.actions[0]!.target = "clawhub:other@1.0.0";
    expect(projectTemplateAddPlan(mismatched, root, [], addConfig).blockers).toContainEqual(
      expect.objectContaining({ code: "effect_disclosure_unavailable" }),
    );

    const stalePreflight = addPlan();
    stalePreflight.actions[0]!.digest = newIntegrity;
    expect(projectTemplateAddPlan(stalePreflight, root, [], addConfig).blockers).toContainEqual(
      expect.objectContaining({ code: "effect_disclosure_unavailable" }),
    );
  });
});
