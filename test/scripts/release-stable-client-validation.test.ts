import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  releaseChildSpec,
  terminalPolicyPass,
  validateReleaseExecutionPlanArtifact,
  releaseExecutionPlanSha256,
} from "../../scripts/full-release-validation-policy.mjs";
import { releaseChildDispatchInputs } from "../../scripts/lib/full-release-child-request.mjs";
import {
  resolveQualificationCoverage,
  validateQualificationJobs,
} from "../../scripts/release-qualification-coverage.mjs";
import {
  canonicalCandidateRequest,
  executionPlan,
  plan,
} from "./full-release-validation-state.test-support.js";

const role = "stableClientCompatibility";
const gate = "Verify stable client compatibility";
const targetSha = "b".repeat(40);

describe("stable release client validation", () => {
  it.each(["beta", "stable", "full"])(
    "selects stable clients independently of candidate mobile builds (%s)",
    (releaseProfile) => {
      for (const rerunGroup of ["all", "ci"]) {
        const result = plan({ childPhaseVersion: 3, releaseProfile, rerunGroup });
        expect(result.children.find((child) => child.key === role)).toMatchObject({
          required: true,
          selected: true,
          workflow: "stable-release-source-compatibility.yml",
          displayTitle:
            "Stable Release Source Compatibility full-release-validation-77-2-stable-client",
        });
      }
      const policy = JSON.parse(
        readFileSync("scripts/lib/release-qualification-coverage.json", "utf8"),
      );
      expect(
        resolveQualificationCoverage(policy, {
          release_profile: releaseProfile,
          rerun_group: "all",
          mode: "both",
          trusted_workflow_json: "{}",
        }).children.find((child) => child.key === role)?.requiredJobs,
      ).toEqual([gate]);
    },
  );

  it("keeps stable clients selected under npm beta coverage", () => {
    const result = plan({
      childPhaseVersion: 3,
      releaseProfile: "beta",
      rerunGroup: "all",
      coveragePolicy: "npm-beta-v1",
      targetVersion: "2026.8.28-beta.1",
      runReleaseSoak: false,
      skipPackageTelegramE2e: true,
    });
    expect(result.children.find((child) => child.key === role)).toMatchObject({
      required: true,
      selected: true,
    });
    expect(result.children.find((child) => child.key === "productPerformance")?.selected).toBe(
      false,
    );
  });

  it("binds dispatch inputs to the exact Gateway SHA, not a target ref", () => {
    const spec = releaseChildSpec(role);
    expect(
      releaseChildDispatchInputs(readFileSync(".github/workflows/" + spec.workflow, "utf8"), [
        "-f",
        "target_sha=" + targetSha,
        "-f",
        "dispatch_id=full-release-validation-77-2-stable-client",
      ]),
    ).toEqual({ target_sha: targetSha });
  });

  it.each(["missing", "failure", "skipped", "neutral", "cancelled", "success"])(
    "requires an explicitly successful compatibility gate (%s)",
    (conclusion) => {
      const jobs =
        conclusion === "missing" ? [] : [{ name: gate, status: "completed", conclusion }];
      const child = { key: role, status: "completed", conclusion: "success", jobs };
      expect(terminalPolicyPass(child)).toBe(conclusion === "success");
      if (conclusion === "success") {
        expect(() => validateQualificationJobs(jobs, [gate])).not.toThrow();
      } else {
        expect(() => validateQualificationJobs(jobs, [gate])).toThrow(/required job/);
      }
    },
  );

  it("continues reading sealed phase-three plans that predate stable clients", () => {
    const current = executionPlan(
      { childPhaseVersion: 3, rerunGroup: "ci" },
      { attemptEvidenceVersion: 3, candidateRequest: canonicalCandidateRequest() },
    );
    const historical = {
      ...current,
      children: current.children.filter((child) => child.key !== role),
    };
    historical.sha256 = releaseExecutionPlanSha256(historical);
    expect(
      validateReleaseExecutionPlanArtifact(historical).children.some((child) => child.key === role),
    ).toBe(false);
  });
});
