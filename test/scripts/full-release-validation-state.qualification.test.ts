import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { publicationSourceJson } from "../../scripts/full-release-publication-contract.mjs";
import {
  buildReleaseExecutionPlanArtifact,
  validateReleaseExecutionPlanArtifact,
  releaseExecutionPlanSha256,
} from "../../scripts/full-release-validation-policy.mjs";
import { validateReleaseRunEvidence } from "../../scripts/release-ci-summary.mjs";
import {
  qualificationCoverageSha256,
  resolveQualificationCoverage,
  validateQualificationJobs,
} from "../../scripts/release-qualification-coverage.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { candidatePublicationFixture } from "./candidate-publication.test-support.js";
import {
  SHA,
  TRUSTED_MAIN,
  canonicalCandidateRequest,
  plan,
  executionPlan,
  sourceFact,
  runCollector,
} from "./full-release-validation-state.test-support.js";
import { qualificationBaselinesJson } from "./release-qualification-admission.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

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

  it("revalidates whole-parent reuse with the admitted P verifier before passing the decision", async () => {
    const root = candidatePublicationFixture();
    const current = candidatePublicationFixture({ runId: "29071366026" });
    current.plan.sourceAdmission = JSON.parse(publicationSourceJson(current.plan.sourceAdmission));
    const evidence = await validateReleaseRunEvidence(
      {
        repository: root.repository,
        runId: root.runId,
        trustedWorkflowRef: root.publisherFullRef.slice("refs/tags/".length),
        trustedWorkflowFullRef: root.publisherFullRef,
        trustedWorkflowSha: root.p,
        verifierSourceSha: root.p,
        verifierSourceContent: readFileSync("scripts/release-ci-summary.mjs"),
      },
      root.client,
    );
    const sealed = buildReleaseExecutionPlanArtifact({
      ...current.plan,
      expected: current.plan,
      children: root.plan.children.map((child) => ({ ...child, source: "reused" })),
      evidenceReuse: {
        requested: true,
        policy: "exact-target-full-validation-v1",
        rootRunId: root.runId,
        selectedRunId: root.runId,
        evidenceSha: root.q,
        changedPaths: [],
        runUrl: root.parent.html_url,
        sourceManifest: root.manifest,
      },
    });
    const directory = tempDirs.make("frv-admitted-reuse-decision-");
    const bin = join(directory, "bin");
    mkdirSync(bin);
    const planPath = join(directory, "plan.json");
    const statePath = join(directory, "decision.json");
    const validator = join(directory, "verifier.mjs");
    writeFileSync(planPath, JSON.stringify(sealed));
    writeFileSync(
      validator,
      `import { isDeepStrictEqual } from "node:util";
const args = process.argv;
const value = (flag) => args[args.indexOf(flag) + 1];
const expected = JSON.parse(process.env.FRV_EXPECTED_VERIFIER);
for (const [flag, wanted] of Object.entries(expected)) {
  const actual = flag === "--qualification-reuse-json" ? JSON.parse(value(flag)) : value(flag);
  if (!isDeepStrictEqual(actual, wanted)) throw new Error("Admitted verifier mismatch: " + flag);
}
console.log(process.env.FRV_VERIFIED_EVIDENCE);
`,
    );
    const responses: Record<string, string> = {};
    for (const child of root.plan.children) {
      const prefix = `repos/${root.repository}/actions/runs/${child.runId}`;
      responses[prefix] = JSON.stringify(await root.client.getRun(child.runId));
      responses[`${prefix}/attempts/1/jobs?per_page=100`] = (
        await root.client.getRunAttemptJobs(child.runId)
      )
        .map((job) => JSON.stringify(job))
        .join("\n");
    }
    const gh = join(bin, "gh");
    writeFileSync(
      gh,
      `#!${process.execPath}
const path = process.argv.find((arg) => arg.startsWith("repos/"));
const response = JSON.parse(process.env.FRV_GITHUB_RESPONSES)[path];
if (response === undefined) throw new Error("Unexpected collector request: " + path);
console.log(response);
`,
    );
    chmodSync(gh, 0o755);
    const result = runCollector("decision", {
      GITHUB_RUN_ID: current.runId,
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_REF_NAME: current.branch,
      GITHUB_SHA: current.q,
      TARGET_SHA: current.q,
      RELEASE_PROFILE: "beta",
      RERUN_GROUP: "all",
      FULL_RELEASE_EXECUTION_PLAN_PATH: planPath,
      FULL_RELEASE_STATE_PATH: statePath,
      OPENCLAW_RELEASE_CI_SUMMARY_VALIDATOR: validator,
      FRV_EXPECTED_VERIFIER: JSON.stringify({
        "--trusted-workflow-ref": current.admission.producer.workflowHeadBranch,
        "--trusted-workflow-full-ref": current.publisherFullRef,
        "--trusted-workflow-sha": current.p,
        "--verifier-source-sha": current.p,
        "--qualification-reuse-json": {
          candidateSha: current.q,
          qualificationSha: current.q,
          workflowRef: current.plan.workflowRef,
          descriptor: current.admission.descriptor,
          inputs: current.plan.qualificationInputs,
        },
      }),
      FRV_VERIFIED_EVIDENCE: JSON.stringify(evidence),
      FRV_GITHUB_RESPONSES: JSON.stringify(responses),
      PATH: `${bin}:${process.env.PATH}`,
    });
    const decisionJson = existsSync(statePath)
      ? readFileSync(statePath, "utf8")
      : "<missing decision>";
    expect(result.status, [result.stderr, result.stdout, decisionJson].join("\n")).toBe(0);
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toMatchObject({ state: "passed" });
  });

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

  it("retains complete qualification coverage with an owner-approved Telegram waiver", () => {
    const baseline = resolveQualificationCoverage(policy, inputs);
    expect(
      resolveQualificationCoverage(policy, {
        ...inputs,
        telegram_waiver: "2026.9.9-owner-approved",
      }),
    ).toEqual(baseline);
  });

  it("rejects changed or removed admitted children even after an attacker rehashes the plan", () => {
    const coverage = resolveQualificationCoverage(policy, inputs);
    const qualificationBaselines = JSON.parse(qualificationBaselinesJson);
    const baselines = qualificationBaselines.upgradeSurvivorBaselines.join(" ");
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
          upgradeSurvivorBaseline: qualificationBaselines.upgradeBaseline,
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
      upgradeSurvivorBaseline: qualificationBaselines.upgradeBaseline,
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
