import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type WorkflowStep = {
  name: string;
  id?: string;
  if?: string;
  env?: Record<string, string>;
  run?: string;
  with?: Record<string, string>;
};

type WorkflowJob = {
  environment?: string;
  if?: string;
  outputs?: Record<string, string>;
  permissions?: Record<string, string>;
  steps: WorkflowStep[];
};

function readWorkflow(name: string): { jobs: Record<string, WorkflowJob> } {
  return parse(readFileSync(`.github/workflows/${name}.yml`, "utf8"));
}

function requireJob(workflow: string, jobId: string): WorkflowJob {
  const job = readWorkflow(workflow).jobs[jobId];
  if (!job) {
    throw new Error(`${workflow}.yml has no job ${jobId}`);
  }
  return job;
}

function requireStep(job: WorkflowJob, index: number): WorkflowStep {
  const step = job.steps[index];
  if (!step) {
    throw new Error(`missing step ${index}`);
  }
  return step;
}

describe("release approval workflow contracts", () => {
  it("attests and uploads the gated parent receipt before dispatching children", () => {
    const publish = requireJob("openclaw-release-publish", "publish");
    expect(publish.environment).toBe("npm-release");
    const names = publish.steps.map((step) => step.name);
    const initializeIndex = names.indexOf("Initialize postpublish diagnostics");
    expect(initializeIndex).toBeGreaterThanOrEqual(0);
    expect(names.slice(initializeIndex + 1, initializeIndex + 5)).toEqual([
      "Write release approval receipt",
      "Attest release approval receipt",
      "Upload release approval receipt",
      "Verify all prepared plugin bytes before publication",
    ]);
    expect(names.indexOf("Upload release approval receipt")).toBeLessThan(
      names.indexOf("Dispatch publish workflows"),
    );
    const write = requireStep(publish, initializeIndex + 1);
    expect(write.id).toBe("approval_receipt");
    expect(write.run).toContain("release-approval-receipt.mjs create");
    expect(requireStep(publish, initializeIndex + 2).with?.["subject-path"]).toBe(
      "${{ runner.temp }}/openclaw-release-approval/approval.json",
    );
    expect(requireStep(publish, initializeIndex + 3).with).toMatchObject({
      name: "${{ steps.approval_receipt.outputs.artifact_name }}",
      path: "${{ runner.temp }}/openclaw-release-approval/approval.json",
      "if-no-files-found": "error",
    });
  });

  it.each([
    ["plugin-npm-release", "validate_release_publish_approval"],
    ["openclaw-npm-release", "validate_publish_request"],
    ["plugin-clawhub-release", "validate_release_publish_approval"],
  ])("%s verifies the parent receipt and attestation for bot dispatches", (workflow, jobId) => {
    const job = requireJob(workflow, jobId);
    expect(job.permissions?.attestations).toBe("read");
    const step = job.steps.at(-1);
    expect(step).toMatchObject({
      name: "Verify release approval receipt",
      id: "receipt",
      env: {
        GH_TOKEN: "${{ github.token }}",
        RELEASE_PUBLISH_RUN_ID: "${{ inputs.release_publish_run_id }}",
        RELEASE_PUBLISH_RUN_ATTEMPT: "${{ inputs.release_publish_run_attempt }}",
        EXPECTED_WORKFLOW_BRANCH: "${{ inputs.release_publish_branch || github.ref_name }}",
        EXPECTED_WORKFLOW_SHA: "${{ github.workflow_sha }}",
      },
    });
    // Zizmor bot-conditions rejects `if: github.actor == ...`; the guard lives in bash.
    expect(step?.if).toBe(
      workflow === "openclaw-npm-release" ? "inputs.release_candidate_branch == ''" : undefined,
    );
    expect(step?.run).toContain('if [[ "${GITHUB_ACTOR}" != "github-actions[bot]" ]]; then');
    expect(step?.run).toContain("release-approval-receipt.mjs verify");
    expect(step?.run).toContain(
      'gh attestation verify "$RUNNER_TEMP/openclaw-release-approval/approval.json"',
    );
    expect(step?.run).toContain(
      '--signer-workflow "$GITHUB_REPOSITORY/.github/workflows/openclaw-release-publish.yml"',
    );
    expect(step?.run).toContain('--signer-digest "$EXPECTED_WORKFLOW_SHA"');
    expect(step?.run).toContain('--source-digest "$EXPECTED_WORKFLOW_SHA"');
    expect(step?.run).toContain('--source-ref "$EXPECTED_WORKFLOW_FULL_REF"');
    expect(step?.run).toContain("--deny-self-hosted-runners");
    if (workflow === "openclaw-npm-release") {
      expect(step?.env).toMatchObject({
        RELEASE_TAG: "${{ inputs.tag }}",
        RELEASE_NPM_DIST_TAG: "${{ inputs.npm_dist_tag }}",
      });
    } else {
      expect(step?.env?.RELEASE_TARGET_SHA).toBe(
        `\${{ needs.${workflow === "plugin-npm-release" ? "preview_plugins_npm" : "preview_plugins_clawhub"}.outputs.ref_revision }}`,
      );
    }
    if (workflow === "plugin-clawhub-release") {
      expect(step?.env).toMatchObject({
        EXPECTED_WORKFLOW_FULL_REF: "${{ inputs.release_publish_full_ref }}",
        RELEASE_PUBLISH_PARENT_STATE_POLICY: "active-or-success",
      });
    } else {
      expect(step?.env?.EXPECTED_WORKFLOW_FULL_REF).toBe(
        "${{ inputs.release_publish_full_ref || github.ref }}",
      );
    }
  });

  it.each([
    ["plugin-npm-release", "publish_plugins_npm"],
    ["plugin-npm-release", "trusted_publisher_preflight"],
    ["openclaw-npm-release", "publish_openclaw_npm"],
  ])("%s %s retains the npm trusted-publisher environment", (workflow, jobId) => {
    // npm trusted publishers are bound to this environment; verified with npm trust list on 2026-09-24.
    expect(requireJob(workflow, jobId).environment).toBe("npm-release");
  });

  it("replaces only the ClawHub human gate after parent receipt verification succeeds", () => {
    const validate = requireJob("plugin-clawhub-release", "validate_release_publish_approval");
    const approve = requireJob("plugin-clawhub-release", "approve_plugins_clawhub_release");
    expect(validate.outputs?.parent_approval).toBe("${{ steps.receipt.outputs.parent_approval }}");
    expect(approve.environment).toBe(
      "${{ needs.validate_release_publish_approval.outputs.parent_approval != 'receipt' && 'clawhub-plugin-release' || '' }}",
    );
    expect(approve.if).toContain("needs.validate_release_publish_approval.result == 'success'");
    const receiptRoute =
      "needs.validate_release_publish_approval.outputs.parent_approval == 'receipt'";
    const wait = approve.steps.find(
      (step) => step.name === "Wait for the release parent's ClawHub authorization",
    );
    expect(wait).toMatchObject({
      if: receiptRoute,
      env: {
        RELEASE_PUBLISH_RUN_ID: "${{ inputs.release_publish_run_id }}",
        RELEASE_PUBLISH_RUN_ATTEMPT: "${{ inputs.release_publish_run_attempt }}",
        EXPECTED_WORKFLOW_SHA: "${{ github.workflow_sha }}",
      },
      run: "node scripts/release-approval-receipt.mjs wait-clawhub-authorization",
    });
    for (const name of ["Checkout trusted release tooling", "Setup Node"]) {
      expect(approve.steps.find((step) => step.name === name)?.if).toContain(receiptRoute);
    }
    const publish = readWorkflow("plugin-clawhub-release").jobs.publish_plugins_clawhub as
      | { needs?: string[]; if?: string }
      | undefined;
    expect(publish?.needs).toContain("approve_plugins_clawhub_release");
    expect(publish?.if).toContain("needs.approve_plugins_clawhub_release.result == 'success'");
  });
});
