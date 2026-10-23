import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const fullValidationPath = ".github/workflows/full-release-validation.yml";
const releaseChecksPath = ".github/workflows/openclaw-release-checks.yml";

type Step = { env?: Record<string, string>; name?: string; run?: string };
type Workflow = { jobs?: Record<string, { steps?: Step[] }> };

function stepRun(path: string, jobName: string, stepName: string): string {
  return expectDefined(workflowStep(path, jobName, stepName).run, `${jobName} / ${stepName}`);
}

function workflowStep(path: string, jobName: string, stepName: string): Step {
  const workflow = parse(readFileSync(path, "utf8")) as Workflow;
  return expectDefined(
    workflow.jobs?.[jobName]?.steps?.find((step) => step.name === stepName),
    `${jobName} / ${stepName}`,
  );
}

function runReleaseChecksTrustedRefGuard(workflowRef: string): ReturnType<typeof spawnSync> {
  const guard = stepRun(
    releaseChecksPath,
    "resolve_target",
    "Require trusted workflow ref for release checks",
  );
  return spawnSync("bash", ["-euo", "pipefail", "-c", guard], {
    encoding: "utf8",
    env: {
      ...process.env,
      RELEASE_REF: "extended-stable/2026.6.33",
      WORKFLOW_REF: workflowRef,
    },
  });
}

describe("extended-stable Full Release Validation workflow", () => {
  it("passes frozen target context to both plugin prerelease phases", () => {
    for (const phase of ["independent", "candidate"]) {
      const dispatch = workflowStep(
        fullValidationPath,
        `plugin_prerelease_${phase}`,
        `Dispatch plugin prerelease ${phase} phase`,
      );
      expect(dispatch.env?.TARGET_CONTEXT_REF).toBe("${{ inputs.target_context_ref }}");
      expect(dispatch.run).toContain('args+=(-f target_context_ref="$TARGET_CONTEXT_REF")');
    }
  });

  it("lets the exact extended-stable branch reach every child at the target SHA", () => {
    const fullValidation = readFileSync(fullValidationPath, "utf8");
    const targetRef = '-f target_ref="$TARGET_SHA"';
    const expectedSha = '-f expected_sha="$TARGET_SHA"';
    for (const [job, step, childWorkflow, target, phased] of [
      ["normal_ci", "CI", "ci", targetRef, false],
      [
        "plugin_prerelease",
        "plugin prerelease",
        "plugin-prerelease",
        `${targetRef} ${expectedSha}`,
        true,
      ],
      ["release_checks", "release checks", "openclaw-release-checks", expectedSha, true],
      ["performance", "OpenClaw Performance", "openclaw-performance", targetRef, false],
    ] as const) {
      for (const phase of phased ? ["independent", "candidate"] : [""]) {
        const run = stepRun(
          fullValidationPath,
          phase ? `${job}_${phase}` : job,
          `Dispatch ${step}${phase ? ` ${phase} phase` : ""}`,
        );
        expect(run).toContain(`${childWorkflow}.yml`);
        expect(run).toContain('--ref "$CHILD_WORKFLOW_REF"');
        expect(run).toContain(target);
        if (phased) {
          expect(run).toContain('-f phase="$PHASE"');
        }
      }
    }

    expect(fullValidation).toContain("PARENT_WORKFLOW_SHA: ${{ github.sha }}");
    expect(fullValidation).toContain('if [[ "$child_head_sha" != "$PARENT_WORKFLOW_SHA" ]]');
    expect(fullValidation).toContain(
      "child run used workflow SHA ${child_head_sha}, expected parent workflow SHA ${PARENT_WORKFLOW_SHA}",
    );
  });

  it("accepts only the exact extended-stable/YYYY.M.33 workflow-ref shape", () => {
    for (const month of [6, 12]) {
      const result = runReleaseChecksTrustedRefGuard(`refs/heads/extended-stable/2026.${month}.33`);
      expect(result.status, String(result.stderr)).toBe(0);
    }

    for (const suffix of "2026.0.33 2026.01.33 2026.13.33 2026.6.32 2026.6.34 2026.6.33/extra not-a-release".split(
      " ",
    )) {
      const invalid = `refs/heads/extended-stable/${suffix}`;
      const result = runReleaseChecksTrustedRefGuard(invalid);
      expect(result.status, invalid).not.toBe(0);
      expect(result.stderr).toContain("extended-stable/YYYY.M.33");
    }
  });
});
