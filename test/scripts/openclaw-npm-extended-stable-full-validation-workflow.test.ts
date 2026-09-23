import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const fullValidationPath = ".github/workflows/full-release-validation.yml";
const releaseChecksPath = ".github/workflows/openclaw-release-checks.yml";

type Step = { env?: Record<string, string>; name?: string; run?: string };
type Job = { outputs?: Record<string, string>; steps?: Step[] };
type Workflow = { jobs?: Record<string, Job> };

function workflow(path: string): Workflow {
  return parse(readFileSync(path, "utf8")) as Workflow;
}

function stepRun(path: string, jobName: string, stepName: string): string {
  const step = workflowStep(path, jobName, stepName);
  if (!step.run) {
    throw new Error(`Missing workflow step run: ${jobName} / ${stepName}`);
  }
  return step.run;
}

function workflowStep(path: string, jobName: string, stepName: string): Step {
  const job = workflow(path).jobs?.[jobName];
  const step = job?.steps?.find((candidate) => candidate.name === stepName);
  if (!step) {
    throw new Error(`Missing workflow step: ${jobName} / ${stepName}`);
  }
  return step;
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

function resolveLaneWaiver(rawWaiver: string, targetVersion: string) {
  const root = mkdtempSync(join(tmpdir(), "openclaw-frv-lane-waiver-"));
  const target = join(root, "target");
  const output = join(root, "output");
  mkdirSync(target);
  writeFileSync(join(target, "package.json"), JSON.stringify({ version: targetVersion }));
  try {
    const step = workflowStep(
      fullValidationPath,
      "resolve_target",
      "Resolve applicable lane waiver",
    );
    const result = spawnSync("bash", ["-euo", "pipefail", "-c", step.run ?? ""], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_OUTPUT: output,
        REPOSITORY_LANE_WAIVER: rawWaiver,
      },
    });
    return { output: readFileSync(output, "utf8"), result };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function outputValue(output: string): string {
  if (output === "value=\n") {
    return "";
  }
  const match = /^value<<(\S+)\n([\s\S]*)\n\1\n$/u.exec(output);
  if (!match) {
    throw new Error(`Invalid GitHub output: ${JSON.stringify(output)}`);
  }
  const value = match[2];
  if (value === undefined) {
    throw new Error(`Missing GitHub output value: ${JSON.stringify(output)}`);
  }
  return value;
}

describe("extended-stable Full Release Validation workflow", () => {
  it("ignores a lane waiver owned by another release", () => {
    const unrelated = resolveLaneWaiver("2026.9.6 ship now", "2026.8.33");
    expect(unrelated.result.status, unrelated.result.stderr).toBe(0);
    expect(outputValue(unrelated.output)).toBe("");
    expect(unrelated.result.stdout).toContain("Lane waiver not applicable");

    const matching = resolveLaneWaiver("2026.8.33 ship now", "2026.8.33");
    expect(matching.result.status, matching.result.stderr).toBe(0);
    expect(outputValue(matching.output)).toBe("2026.8.33 ship now");

    const multiline = resolveLaneWaiver(
      "2026.8.33 ship now\napproved by release owner",
      "2026.8.33",
    );
    expect(multiline.result.status, multiline.result.stderr).toBe(0);
    expect(outputValue(multiline.output)).toBe("2026.8.33 ship now\napproved by release owner");

    const source = readFileSync(fullValidationPath, "utf8");
    const resolveTarget = workflow(fullValidationPath).jobs?.resolve_target;
    expect(resolveTarget?.outputs?.lane_waiver).toBe("${{ steps.lane_waiver.outputs.value }}");
    expect(source.match(/vars\.OPENCLAW_FRV_LANE_WAIVER/gu)).toHaveLength(2);
  });

  it("passes frozen target context to both plugin prerelease phases", () => {
    const phases = [
      {
        job: "plugin_prerelease_independent",
        step: "Dispatch plugin prerelease independent phase",
      },
      { job: "plugin_prerelease_candidate", step: "Dispatch plugin prerelease candidate phase" },
    ];
    for (const phase of phases) {
      const dispatch = workflowStep(fullValidationPath, phase.job, phase.step);
      expect(dispatch.env?.TARGET_CONTEXT_REF).toBe("${{ inputs.target_context_ref }}");
      expect(dispatch.run).toContain('args+=(-f target_context_ref="$TARGET_CONTEXT_REF")');
    }
  });

  it("lets the exact extended-stable branch reach every child at the target SHA", () => {
    const fullValidation = readFileSync(fullValidationPath, "utf8");
    const childDispatches = [
      {
        job: "normal_ci",
        step: "Dispatch CI",
        workflow: "ci.yml",
        target: '-f target_ref="$TARGET_SHA"',
      },
      {
        job: "plugin_prerelease_independent",
        step: "Dispatch plugin prerelease independent phase",
        workflow: "plugin-prerelease.yml",
        target: '-f target_ref="$TARGET_SHA" -f expected_sha="$TARGET_SHA"',
      },
      {
        job: "plugin_prerelease_candidate",
        step: "Dispatch plugin prerelease candidate phase",
        workflow: "plugin-prerelease.yml",
        target: '-f target_ref="$TARGET_SHA" -f expected_sha="$TARGET_SHA"',
      },
      {
        job: "release_checks_independent",
        step: "Dispatch release checks independent phase",
        workflow: "openclaw-release-checks.yml",
        target: '-f expected_sha="$TARGET_SHA"',
      },
      {
        job: "release_checks_candidate",
        step: "Dispatch release checks candidate phase",
        workflow: "openclaw-release-checks.yml",
        target: '-f expected_sha="$TARGET_SHA"',
      },
      {
        job: "performance",
        step: "Dispatch OpenClaw Performance",
        workflow: "openclaw-performance.yml",
        target: '-f target_ref="$TARGET_SHA"',
      },
    ];

    for (const child of childDispatches) {
      const run = stepRun(fullValidationPath, child.job, child.step);
      expect(run).toContain(child.workflow);
      expect(run).toContain('--ref "$CHILD_WORKFLOW_REF"');
      expect(run).toContain(child.target);
      if (child.job.includes("plugin_prerelease") || child.job.includes("release_checks")) {
        expect(run).toContain('-f phase="$PHASE"');
      }
    }

    expect(fullValidation).toContain("PARENT_WORKFLOW_SHA: ${{ github.sha }}");
    expect(fullValidation).toContain('if [[ "$child_head_sha" != "$PARENT_WORKFLOW_SHA" ]]');
    expect(fullValidation).toContain(
      "child run used workflow SHA ${child_head_sha}, expected parent workflow SHA ${PARENT_WORKFLOW_SHA}",
    );
  });

  it("accepts only the exact extended-stable/YYYY.M.33 workflow-ref shape", () => {
    for (const valid of [
      "refs/heads/extended-stable/2026.6.33",
      "refs/heads/extended-stable/2026.12.33",
    ]) {
      const result = runReleaseChecksTrustedRefGuard(valid);
      expect(result.status, String(result.stderr)).toBe(0);
    }

    for (const invalid of [
      "refs/heads/extended-stable/2026.0.33",
      "refs/heads/extended-stable/2026.01.33",
      "refs/heads/extended-stable/2026.13.33",
      "refs/heads/extended-stable/2026.6.32",
      "refs/heads/extended-stable/2026.6.34",
      "refs/heads/extended-stable/2026.6.33/extra",
      "refs/heads/extended-stable/not-a-release",
    ]) {
      const result = runReleaseChecksTrustedRefGuard(invalid);
      expect(result.status, invalid).not.toBe(0);
      expect(result.stderr).toContain("extended-stable/YYYY.M.33");
    }
  });
});
