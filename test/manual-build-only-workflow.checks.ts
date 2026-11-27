import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parse } from "yaml";
import { loadPlan } from "../scripts/frv.mjs";
import {
  parseArgs,
  releaseEvidenceVerificationArgs,
} from "../scripts/full-release-validation-at-sha.mts";
import { candidatePublicationFixture } from "./scripts/candidate-publication.test-support.js";
import {
  evaluateWorkflowCondition,
  evaluateWorkflowExpression,
} from "./scripts/ci-workflow.test-support.js";

const workflow = parse(readFileSync(".github/workflows/full-release-validation.yml", "utf8"));
const validationJobs = [
  "plugin_compatibility_readiness",
  "normal_ci",
  "plugin_prerelease_independent",
  "plugin_prerelease_candidate",
  "release_checks_independent",
  "release_checks_candidate",
  "npm_telegram",
  "performance",
  "evidence_reuse",
];
const artifactJobs = [
  "prepare_npm_package",
  "qualify_npm_package",
  "prepare_plugin_npm",
  "prepare_docker_release",
];
function context(rerunGroup: string, readiness: "success" | "skipped" | "failure" = "skipped") {
  return {
    eventName: "workflow_dispatch" as const,
    repository: "openclaw/openclaw",
    runAttempt: 1,
    inputs: {
      rerun_group: rerunGroup,
      release_profile: "stable",
      reuse_evidence: true,
      run_release_soak: true,
    },
    jobResults: { resolve_target: "success" },
    resolveTargetOutputs: {
      candidate_required: "true",
      plugin_candidate_required: "true",
      plugin_npm_preflight_required: "true",
      coverage_policy: "",
      live_suite_filter: "",
      performance_exempt: "false",
      npm_dist_tag: "beta",
      publication_selection_json: JSON.stringify({ npmDistTag: "latest" }),
    },
    additionalNeeds: {
      plugin_compatibility_readiness: {
        result: readiness,
        outputs: {},
      },
      evidence_reuse: { result: "skipped" as const, outputs: { reuse: "false" } },
      prepare_npm_package: { result: "success" as const, outputs: {} },
      candidate_acquisition: { result: "success" as const, outputs: { state: "ready" } },
    },
  };
}
it("build-only schedules artifact preparation without dispatching any validation lane, even for stable soak", () => {
  for (const id of validationJobs) {
    expect(evaluateWorkflowCondition(workflow.jobs[id].if, context("build-only")), id).toBe(false);
  }
  for (const id of artifactJobs) {
    expect(evaluateWorkflowCondition(workflow.jobs[id].if, context("build-only")), id).toBe(true);
  }
  expect(
    evaluateWorkflowExpression(
      workflow.jobs.prepare_npm_package.env.PREFLIGHT_PHASE,
      context("build-only"),
    ),
  ).toBe("build-only");
});
it("build-only seals stable npm artifacts for the exact publication channel, not the beta qualification channel", () => {
  const distTag = workflow.jobs.prepare_npm_package.env.NPM_DIST_TAG;
  expect(evaluateWorkflowExpression(distTag, context("build-only"))).toBe("latest");
  expect(evaluateWorkflowExpression(distTag, context("all"))).toBe("beta");
});
it("ordinary all-group validation remains selected and artifact preparation fails closed on source readiness failure", () => {
  for (const id of [
    "normal_ci",
    "performance",
    "plugin_prerelease_independent",
    "release_checks_independent",
  ]) {
    expect(evaluateWorkflowCondition(workflow.jobs[id].if, context("all", "success")), id).toBe(
      true,
    );
  }
  for (const id of ["prepare_npm_package", "prepare_plugin_npm", "prepare_docker_release"]) {
    expect(evaluateWorkflowCondition(workflow.jobs[id].if, context("all", "skipped")), id).toBe(
      false,
    );
    expect(
      evaluateWorkflowCondition(workflow.jobs[id].if, context("build-only", "failure")),
      id,
    ).toBe(false);
  }
});

it("accepts build-only at the shell and dispatch boundaries without selecting release checks", () => {
  const invoke = (scope: string) =>
    spawnSync(
      "/bin/bash",
      [
        "-c",
        'source scripts/github/validate-release-suite-filters.sh; validate_release_suite_filters build-only "" "" "$1"',
        "check",
        scope,
      ],
      { encoding: "utf8" },
    );
  expect(invoke("controller").status).toBe(0);
  expect(invoke("release-checks").status).not.toBe(0);
  const buildOnly = parseArgs(["-f", "rerun_group=build-only"]).inputs;
  expect(buildOnly.rerun_group).toBe("build-only");
  expect(buildOnly.reuse_evidence).toBe("false");
  expect(() => parseArgs(["-f", "rerun_group=build-only", "-f", "reuse_evidence=true"])).toThrow(
    "requires fresh qualification",
  );
  const args = releaseEvidenceVerificationArgs(
    "77",
    "a".repeat(40),
    "/trusted/scripts/release-ci-summary.mjs",
    "main",
    true,
  );
  expect(args[0]).toBe("--verify-build-only");
  expect(args).not.toContain("--validate-run");
});

it("read-only FRV commands can load build-only plans, but continuation cannot widen them into full validation", async () => {
  const fixture = candidatePublicationFixture({ rerunGroup: "build-only" });
  for (const command of ["status", "watch", "verify", "cancel"]) {
    await expect(
      loadPlan(
        { command, repository: fixture.repository, runId: fixture.runId },
        async () => fixture.plan,
      ),
    ).resolves.toMatchObject({ rerunGroup: "build-only" });
  }
  for (const command of ["continue", "rerun"]) {
    await expect(
      loadPlan(
        { command, repository: fixture.repository, runId: fixture.runId },
        async () => fixture.plan,
      ),
    ).rejects.toThrow("requires an all-group root");
  }
});

it("build-only always acquires the exact sealed candidate even when external validation package selectors were supplied", () => {
  const source = workflow.jobs.resolve_target.steps.find((step: { run?: string }) =>
    step.run?.includes("release_artifact_required=false"),
  ).run;
  const branch = source.slice(
    source.indexOf("release_artifact_required=false"),
    source.indexOf("\nrequired=false", source.indexOf("release_artifact_required=false")),
  );
  for (const packageSpec of ["", "openclaw@2026.11.9"]) {
    const result = spawnSync(
      "/bin/bash",
      ["-c", `${branch}\nprintf '%s' "$release_artifact_required"`],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          RERUN_GROUP: "build-only",
          RELEASE_PACKAGE_SPEC: packageSpec,
          PACKAGE_ACCEPTANCE_PACKAGE_SPEC: packageSpec,
          LIVE_SUITE_FILTER: "",
        },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("true");
  }
});

it("summary admits intentionally skipped build-only readiness but rejects readiness failures and normal skips", () => {
  const readiness = workflow.jobs.summary.steps.find(
    (step: { name: string }) => step.name === "Require successful source readiness",
  );
  const artifacts = workflow.jobs.summary.steps.find(
    (step: { name: string }) => step.name === "Require qualified publication artifacts",
  );
  for (const mode of ["all", "build-only"]) {
    expect(evaluateWorkflowCondition(artifacts.if, context(mode))).toBe(true);
    for (const result of ["success", "skipped", "failure", "cancelled"]) {
      const run = spawnSync("bash", ["-c", readiness.run], {
        encoding: "utf8",
        env: { ...process.env, RERUN_GROUP: mode, SOURCE_READINESS_RESULT: result },
      });
      expect(run.status, `${mode}/${result}: ${run.stderr}`).toBe(
        result === "success" || (mode === "build-only" && result === "skipped") ? 0 : 1,
      );
    }
  }
});
