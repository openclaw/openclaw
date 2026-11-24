import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { publicationSourceJson } from "../../scripts/full-release-publication-contract.mjs";
import {
  buildReleaseExecutionPlanArtifact,
  validateReleaseExecutionPlanArtifact,
  releaseExecutionPlanSha256,
} from "../../scripts/full-release-validation-policy.mjs";
import { buildReleaseValidationManifest } from "../../scripts/lib/full-release-manifest.mjs";
import { validateReleaseRunEvidence } from "../../scripts/release-ci-summary.mjs";
import {
  resolveQualificationCoverage,
  validateQualificationJobs,
} from "../../scripts/release-qualification-coverage.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { candidatePublicationFixture } from "./candidate-publication.test-support.js";
import { runCollector } from "./full-release-validation-state.test-support.js";

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

  it.each(["exact", "changelog", "beta promotion"])(
    "revalidates admitted whole-parent reuse through decision, drain, and manifest upload validation (%s)",
    async (mode) => {
      const descendant = mode !== "exact";
      const promotion = mode === "beta promotion";
      const root = candidatePublicationFixture(
        promotion ? { candidateVersion: "2026.8.28-beta.1", releaseProfile: "stable" } : {},
      );
      const current = candidatePublicationFixture({
        candidateSha: descendant ? "d".repeat(40) : root.q,
        ...(promotion ? { candidateVersion: "2026.8.28" } : {}),
        runId: "29071366026",
      });
      current.plan.sourceAdmission = JSON.parse(
        publicationSourceJson(current.plan.sourceAdmission),
      );
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
      const reusePolicy = promotion
        ? "stable-qualified-beta-final-v1"
        : descendant
          ? "split-changelog-release-v1"
          : "exact-target-full-validation-v1";
      const changedPaths = promotion
        ? ["package.json"]
        : descendant
          ? ["CHANGELOG/2026.8.28.md", "CHANGELOG/records/2026.8.28.md"]
          : [];
      const sealed = buildReleaseExecutionPlanArtifact({
        ...current.plan,
        expected: current.plan,
        children: root.plan.children.map((child) => ({ ...child, source: "reused" })),
        evidenceReuse: {
          requested: true,
          policy: reusePolicy,
          rootRunId: root.runId,
          selectedRunId: root.runId,
          evidenceSha: root.q,
          changedPaths,
          runUrl: root.parent.html_url,
          sourceArtifact: evidence.root.artifact,
          sourceWorkflow: { ref: root.manifest.workflowRef, sha: root.manifest.workflowSha },
        },
      });
      expect(sealed.evidenceReuse.sourceManifest).toBeUndefined();
      const directory = tempDirs.make("frv-admitted-reuse-decision-");
      const bin = join(directory, "bin");
      mkdirSync(bin);
      const planPath = join(directory, "plan.json");
      const statePath = join(directory, "decision.json");
      const validator = join(directory, "verifier.mjs");
      const evidencePath = join(directory, "evidence.json");
      writeFileSync(planPath, JSON.stringify(sealed));
      // Keep full evidence out of environment entries, which have OS size limits.
      writeFileSync(evidencePath, JSON.stringify(evidence));
      writeFileSync(
        validator,
        `import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
const args = process.argv;
const value = (flag) => args[args.indexOf(flag) + 1];
const expected = JSON.parse(process.env.FRV_EXPECTED_VERIFIER);
for (const [flag, wanted] of Object.entries(expected)) {
  const actual = flag === "--qualification-reuse-json" ? JSON.parse(value(flag)) : value(flag);
  if (!isDeepStrictEqual(actual, wanted)) throw new Error("Admitted verifier mismatch: " + flag);
}
console.log(readFileSync(process.env.FRV_VERIFIED_EVIDENCE_PATH, "utf8"));
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
      const env = {
        GITHUB_RUN_ID: current.runId,
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_REF_NAME: current.branch,
        GITHUB_SHA: current.q,
        TARGET_SHA: current.q,
        RELEASE_PROFILE: current.plan.releaseProfile,
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
          ...(descendant
            ? {
                "--expected-target-sha": current.q,
                "--expected-evidence-sha": root.q,
                "--expected-evidence-policy": reusePolicy,
                "--expected-changed-paths-json": JSON.stringify(changedPaths),
              }
            : {}),
        }),
        FRV_VERIFIED_EVIDENCE_PATH: evidencePath,
        FRV_GITHUB_RESPONSES: JSON.stringify(responses),
        PATH: `${bin}:${process.env.PATH}`,
      };
      const result = runCollector("decision", env);
      const decisionJson = existsSync(statePath)
        ? readFileSync(statePath, "utf8")
        : "<missing decision>";
      expect(
        result.status,
        [result.error, result.signal, result.stderr, result.stdout, decisionJson].join("\n"),
      ).toBe(0);
      expect(JSON.parse(readFileSync(statePath, "utf8"))).toMatchObject({ state: "passed" });
      const drainPath = join(directory, "drain.json");
      const drained = runCollector("drain", { ...env, FULL_RELEASE_STATE_PATH: drainPath });
      expect(drained.status, drained.stderr).toBe(0);
      const drain = JSON.parse(readFileSync(drainPath, "utf8"));
      const manifestPath = join(directory, "manifest.json");
      const manifest = buildReleaseValidationManifest({
        plan: sealed,
        drain,
        context: current.manifest,
        reusedManifest: root.manifest,
      });
      writeFileSync(manifestPath, JSON.stringify(manifest));
      const manifestEnv = {
        ...env,
        RELEASE_EXECUTION_PLAN_PATH: planPath,
        RELEASE_DECISION_PATH: statePath,
        DIAGNOSTIC_DRAIN_PATH: drainPath,
        RELEASE_VALIDATION_MANIFEST_PATH: manifestPath,
      };
      const validated = runCollector("validate-manifest", manifestEnv);
      expect(validated.status, validated.stderr).toBe(0);
      expect(JSON.parse(readFileSync(manifestPath, "utf8")).evidenceReuse.publication).toEqual(
        manifest.evidenceReuse.publication,
      );
      delete manifest.evidenceReuse.publication;
      writeFileSync(manifestPath, JSON.stringify(manifest));
      const missingRoot = runCollector("validate-manifest", manifestEnv);
      expect(missingRoot.status).not.toBe(0);
      expect(missingRoot.stderr).toContain("differs from the immutable execution plan");
    },
  );

  it.each(["skipped", "duplicate"])(
    "rejects a successful parent whose mandatory gate is %s",
    (failure) => {
      const passed = { name: "Required matrix gate", status: "completed", conclusion: "success" };
      const jobs =
        failure === "duplicate" ? [passed, passed] : [{ ...passed, conclusion: failure }];
      expect(() => validateQualificationJobs(jobs, [passed.name])).toThrow(
        "required job did not succeed",
      );
      expect(() => validateQualificationJobs([passed], [passed.name])).not.toThrow();
    },
  );

  it.each<Record<string, string>>([
    { rerun_group: "ci" },
    { release_package_spec: "openclaw@2026.9.1" },
    { skip_package_telegram_e2e: "true" },
    { allow_frozen_target_scenario_omissions: "true" },
  ])("rejects a narrowed candidate request: %j", (narrowed) => {
    expect(() => resolveQualificationCoverage(policy, { ...inputs, ...narrowed })).toThrow();
  });

  it("rejects changed or removed admitted children even after an attacker rehashes the plan", () => {
    const root = candidatePublicationFixture();
    root.plan.sourceAdmission = JSON.parse(publicationSourceJson(root.plan.sourceAdmission));
    const sealed = buildReleaseExecutionPlanArtifact({ ...root.plan, expected: root.plan });
    const coverage = sealed.qualificationCoverage;
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

    const current = candidatePublicationFixture({ candidateSha: "c".repeat(40) });
    current.plan.sourceAdmission = JSON.parse(publicationSourceJson(current.plan.sourceAdmission));
    const reused = buildReleaseExecutionPlanArtifact({ ...current.plan, expected: current.plan });
    reused.evidenceReuse = {
      requested: true,
      changedPaths: ["CHANGELOG.md"],
      evidenceSha: root.q,
      policy: "changelog-only-release-v1",
      rootRunId: root.runId,
      selectedRunId: root.runId,
      runUrl: "",
      sourceManifest: {
        workflowSha: root.q,
        workflowRef: root.branch,
        qualificationCoverage: coverage,
      },
    };
    reused.children = sealed.children.map((child) =>
      Object.assign({}, child, { source: "reused" }),
    );
    reused.sha256 = releaseExecutionPlanSha256(reused);
    const restored = validateReleaseExecutionPlanArtifact(reused, {
      qualificationCoverage: coverage,
    });
    expect(restored.children.every((child) => child.workflowSha === root.q)).toBe(true);
  });
});
