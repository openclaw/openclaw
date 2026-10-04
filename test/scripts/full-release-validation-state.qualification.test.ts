import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  validateReleaseExecutionPlanArtifact,
  releaseExecutionPlanSha256,
} from "../../scripts/full-release-validation-policy.mjs";
import {
  qualificationCoverageSha256,
  resolveQualificationCoverage,
  validateQualificationJobs,
} from "../../scripts/release-qualification-coverage.mjs";
import {
  SHA,
  TRUSTED_MAIN,
  canonicalCandidateRequest,
  plan,
  executionPlan,
  sourceFact,
} from "./full-release-validation-state.test-support.js";
import { qualificationBaselinesJson } from "./release-qualification-admission.test-support.js";

describe("candidate-owned frozen qualification coverage", () => {
  const inputs = {
    release_profile: "stable",
    rerun_group: "all",
    mode: "both",
    trusted_workflow_json: "{}",
  };
  const policy = JSON.parse(
    readFileSync("scripts/lib/release-qualification-coverage.json", "utf8"),
  );

  it("keeps the admitted child and job set when later tooling adds a requirement", () => {
    const admitted = resolveQualificationCoverage(policy, inputs);
    const later = structuredClone(policy);
    later.children.push({
      ...later.children[0],
      key: "laterCheck",
      name: "Later check",
      parentJobName: "Run later check",
      dispatchName: "Dispatch later check",
      suffix: "-later",
      requiredJobs: ["Later required job"],
    });
    later.profiles.stable.push("laterCheck");
    const laterCoverage = resolveQualificationCoverage(later, inputs);
    expect(qualificationCoverageSha256(laterCoverage)).not.toBe(
      qualificationCoverageSha256(admitted),
    );
    const frozen = plan({ childPhaseVersion: 3, qualificationCoverage: admitted });
    expect(frozen.children.map((child) => child.key)).toEqual(
      admitted.children.map((child) => child.key),
    );
    expect(frozen.children.every((child) => child.required && child.selected)).toBe(true);
    expect(
      plan({ childPhaseVersion: 3, qualificationCoverage: laterCoverage }).children,
    ).toHaveLength(frozen.children.length + 1);
  });

  it.each(["missing", "skipped", "failure", "cancelled", "duplicate"])(
    "rejects a successful parent whose mandatory gate is %s",
    (failure) => {
      const passed = { name: "Required matrix gate", status: "completed", conclusion: "success" };
      const jobs =
        failure === "missing"
          ? []
          : failure === "duplicate"
            ? [passed, passed]
            : [{ ...passed, conclusion: failure }];
      expect(() => validateQualificationJobs(jobs, [passed.name])).toThrow(
        "required job did not succeed",
      );
      expect(() => validateQualificationJobs([passed], [passed.name])).not.toThrow();
    },
  );

  it.each<Record<string, string>>([
    { rerun_group: "ci" },
    { live_suite_filter: "one-suite" },
    { release_package_spec: "openclaw@2026.9.1" },
    { npm_telegram_package_spec: "openclaw@2026.9.1" },
    { skip_package_telegram_e2e: "true" },
    { allow_frozen_target_scenario_omissions: "true" },
    {
      trusted_workflow_json: JSON.stringify({
        laneInputs: { extension_test_exclude_patterns_json: '["*.test.ts"]' },
      }),
    },
  ])("rejects a narrowed candidate request: %j", (narrowed) => {
    expect(() => resolveQualificationCoverage(policy, { ...inputs, ...narrowed })).toThrow();
  });

  it("rejects changed or removed admitted children even after an attacker rehashes the plan", () => {
    const coverage = resolveQualificationCoverage(policy, inputs);
    const baselines = JSON.parse(qualificationBaselinesJson).upgradeSurvivorBaselines.join(" ");
    const sourceCoverage = {
      ...sourceFact().coverage,
      coverage_policy: "npm-stable-v1",
      qualification_baselines_json: qualificationBaselinesJson,
    };
    const sourceAdmission = sourceFact(
      Object.assign(
        { candidateSha: SHA, coverage: sourceCoverage },
        { qualificationAdmission: { artifactId: 123 } },
      ),
    );
    const sealed = executionPlan(
      { qualificationCoverage: coverage, childPhaseVersion: 3 },
      {
        attemptEvidenceVersion: 3,
        qualificationCoverage: coverage,
        qualificationInputs: inputs,
        sourceAdmissionContract: "1",
        sourceAdmission,
        candidateRequest: canonicalCandidateRequest({
          targetSha: SHA,
          upgradeSurvivorBaselines: baselines,
        }),
        coveragePolicy: "npm-stable-v1",
        targetVersion: "2026.9.9",
        expected: { targetSha: SHA },
      },
    );
    expect(
      validateReleaseExecutionPlanArtifact(sealed, { qualificationCoverage: coverage }).sha256,
    ).toBe(sealed.sha256);
    const changed = structuredClone(sealed);
    changed.children.pop();
    changed.sha256 = releaseExecutionPlanSha256(changed);
    expect(() =>
      validateReleaseExecutionPlanArtifact(changed, { qualificationCoverage: coverage }),
    ).toThrow("frozen qualification");
    const relabeled = structuredClone(sealed);
    relabeled.children[0]!.required = false;
    relabeled.sha256 = releaseExecutionPlanSha256(relabeled);
    expect(() =>
      validateReleaseExecutionPlanArtifact(relabeled, { qualificationCoverage: coverage }),
    ).toThrow("required coverage changed");

    const nextSha = "c".repeat(40);
    const reused = structuredClone(sealed);
    reused.targetSha = nextSha;
    reused.workflowSha = nextSha;
    reused.trustedWorkflow = { ...TRUSTED_MAIN, sha: nextSha };
    reused.candidateRequest = canonicalCandidateRequest({
      targetSha: nextSha,
      toolingSha: nextSha,
      upgradeSurvivorBaselines: baselines,
    });
    reused.sourceAdmission = sourceFact(
      Object.assign(
        {
          candidateSha: nextSha,
          coverage: sourceCoverage,
          tooling: { ref: "refs/heads/main", sha: nextSha },
          workflow: { ref: "refs/heads/release-ci/tooling", sha: nextSha },
        },
        { qualificationAdmission: { artifactId: 456 } },
      ),
    );
    reused.evidenceReuse = {
      requested: true,
      changedPaths: ["CHANGELOG.md"],
      evidenceSha: SHA,
      policy: "changelog-only-release-v1",
      rootRunId: "76",
      selectedRunId: "76",
      runUrl: "",
      sourceManifest: {
        workflowSha: SHA,
        workflowRef: "release-ci/tooling",
        qualificationCoverage: coverage,
      },
    };
    reused.children = reused.children.map((child) => ({ ...child, source: "reused" }));
    reused.sha256 = releaseExecutionPlanSha256(reused);
    const restored = validateReleaseExecutionPlanArtifact(reused, {
      qualificationCoverage: coverage,
    });
    expect(restored.children.every((child) => child.workflowSha === SHA)).toBe(true);
  });
});
