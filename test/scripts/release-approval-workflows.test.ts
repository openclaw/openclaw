import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { validateReleasePublishParentRun } from "../../scripts/release-tooling-identity.mjs";

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
  needs?: string[] | string;
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
    expect(step?.if).toBeUndefined();
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
      expect(
        job.steps.find((candidate) => candidate.name === "Checkout trusted approval verifier")
          ?.with,
      ).toMatchObject({
        ref: "${{ github.workflow_sha }}",
        path: "trusted-workflow",
        "sparse-checkout": "scripts",
      });
      expect(step?.run).toContain(
        "node trusted-workflow/scripts/release-approval-receipt.mjs verify",
      );
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
  ])("%s %s uses the npm trusted-publisher environment", (workflow, jobId) => {
    expect(requireJob(workflow, jobId).environment).toBe("npm-publish");
  });

  it.each([
    [
      "openclaw-npm-release",
      "validate_publish_request",
      "approve_openclaw_npm_release",
      "publish_openclaw_npm",
      "Publish",
    ],
    [
      "plugin-npm-release",
      "validate_release_publish_approval",
      "approve_plugins_npm_release",
      "publish_plugins_npm",
      "Publish with trusted publisher",
    ],
  ])(
    "%s requires human approval or a verified receipt before publication",
    (workflow, validationId, approvalId, publishId, mutationName) => {
      const validation = requireJob(workflow, validationId);
      const approval = requireJob(workflow, approvalId);
      const publish = requireJob(workflow, publishId);
      expect(validation.outputs?.parent_approval).toBe(
        "${{ steps.receipt.outputs.parent_approval }}",
      );
      expect(approval.environment).toBe("npm-release");
      expect(approval.permissions).toEqual({ contents: "read" });
      expect(approval.steps).toHaveLength(1);
      expect(approval.steps[0]?.run).toMatch(/^echo /);
      expect(publish.needs).toContain(approvalId);
      expect(publish.if).toContain("always() && !cancelled()");
      const evaluate = (
        expression: string | undefined,
        parentApproval: string,
        approvalResult: string,
        validationResult = "success",
        preflight = false,
        cancelled = false,
        hasCandidates = "true",
      ) =>
        runInNewContext(expression!.replace(/^\$\{\{|\}\}$/gu, ""), {
          always: () => true,
          cancelled: () => cancelled,
          github: { event_name: "workflow_dispatch" },
          inputs: { preflight_only: preflight, prepared_artifact: "" },
          needs: {
            [validationId]: {
              result: validationResult,
              outputs: { parent_approval: parentApproval },
            },
            [approvalId]: { result: approvalResult },
            preview_plugins_npm: { result: "success", outputs: { has_candidates: hasCandidates } },
            preview_plugin_pack: { result: "success" },
            verify_plugin_npm_preflight: { result: "success" },
          },
        });
      expect(evaluate(approval.if, "", "skipped")).toBe(true);
      expect(evaluate(approval.if, "receipt", "skipped")).toBe(false);
      expect(evaluate(approval.if, "", "skipped", "failure")).toBe(false);
      expect(evaluate(approval.if, "", "skipped", "success", true)).toBe(false);
      for (const [receipt, result, allowed] of [
        ["", "success", true],
        ["receipt", "skipped", true],
        ["", "skipped", false],
        ["receipt", "failure", false],
        ["receipt", "cancelled", false],
      ] as const) {
        expect(evaluate(publish.if, receipt, result), `${receipt}/${result}`).toBe(allowed);
      }
      expect(evaluate(publish.if, "receipt", "skipped", "failure")).toBe(false);
      expect(evaluate(publish.if, "receipt", "skipped", "success", true)).toBe(false);
      expect(evaluate(publish.if, "receipt", "skipped", "success", false, true)).toBe(false);
      if (workflow === "plugin-npm-release") {
        expect(evaluate(approval.if, "", "skipped", "success", false, false, "false")).toBe(false);
        expect(evaluate(publish.if, "receipt", "skipped", "success", false, false, "false")).toBe(
          false,
        );
      }
      const wait = publish.steps.find(
        (step) => step.name === "Wait for the release parent's npm authorization",
      );
      expect(wait).toMatchObject({
        if: `needs.${validationId}.outputs.parent_approval == 'receipt'`,
        env: {
          GH_TOKEN: "${{ github.token }}",
          RELEASE_PUBLISH_RUN_ID: "${{ inputs.release_publish_run_id }}",
          RELEASE_PUBLISH_RUN_ATTEMPT: "${{ inputs.release_publish_run_attempt }}",
          EXPECTED_WORKFLOW_SHA: "${{ github.workflow_sha }}",
        },
      });
      expect(wait?.run).toBe(
        `node ${workflow === "openclaw-npm-release" ? "trusted-workflow/" : ""}scripts/release-approval-receipt.mjs wait-npm-authorization`,
      );
      const names = publish.steps.map((step) => step.name);
      expect(names.indexOf(wait!.name)).toBeLessThan(names.indexOf(mutationName));
      const checkout = publish.steps.find(
        (step) =>
          step.name ===
          (workflow === "openclaw-npm-release"
            ? "Checkout trusted validation verifier"
            : "Checkout trusted publication tooling"),
      );
      expect(checkout?.with?.ref).toBe("${{ github.workflow_sha }}");
      expect(names.indexOf(checkout!.name)).toBeLessThan(names.indexOf(wait!.name));
    },
  );

  it.each([
    [
      "openclaw-npm-release",
      "validate_publish_request",
      "Publish",
      "RELEASE_PUBLISH_PARENT_STATE_POLICY",
    ],
    [
      "plugin-npm-release",
      "validate_release_publish_approval",
      "Publish with trusted publisher",
      "OPENCLAW_RELEASE_PUBLISH_PARENT_STATE_POLICY",
    ],
    [
      "plugin-npm-release",
      "validate_release_publish_approval",
      "Publish approved bootstrap tarball",
      "RELEASE_PUBLISH_PARENT_STATE_POLICY",
    ],
  ] as const)(
    "%s %s re-verifies a live parent before npm publish on the receipt route (%s)",
    (workflow, validationId, stepName, policyVariable) => {
      const job = requireJob(
        workflow,
        workflow === "openclaw-npm-release" ? "publish_openclaw_npm" : "publish_plugins_npm",
      );
      const publish = job.steps.find((step) => step.name === stepName);
      const policyExpression = publish?.env?.[policyVariable];
      if (!publish?.run || !policyExpression) {
        throw new Error(`${workflow} ${stepName} has no parent state policy`);
      }
      const policyFor = (parentApproval: string, actor: string) =>
        runInNewContext(policyExpression.replace(/^\$\{\{|\}\}$/gu, ""), {
          github: { actor },
          inputs: { release_publish_run_id: "67890" },
          needs: { [validationId]: { outputs: { parent_approval: parentApproval } } },
        });
      const bot = "github-actions[bot]";
      const receiptPolicy = policyFor("receipt", bot);
      expect(receiptPolicy).toBe("active");
      expect(policyFor("", "release-manager")).toBe("manual-recovery");
      if (workflow === "plugin-npm-release") {
        // Human-approved bot children keep the existing finish-after-failure contract.
        expect(policyFor("", bot)).toBe("active-or-failure");
      }

      const sha = "a".repeat(40);
      const ref = `release-publish/${sha.slice(0, 12)}-123`;
      const verifyParent = (status: string, conclusion: string | null) =>
        validateReleasePublishParentRun({
          identity: { ref, fullRef: `refs/tags/${ref}`, sha },
          releasePublishFullRef: `refs/tags/${ref}`,
          releasePublishParentStatePolicy: receiptPolicy,
          releasePublishRef: ref,
          releasePublishRunAttempt: "2",
          releasePublishRunId: "67890",
          repository: "openclaw/openclaw",
          run: {
            id: 67890,
            run_attempt: 2,
            repository: { full_name: "openclaw/openclaw" },
            path: `.github/workflows/openclaw-release-publish.yml@refs/tags/${ref}`,
            event: "workflow_dispatch",
            head_branch: ref,
            head_sha: sha,
            status,
            conclusion,
          },
        });
      // The parent failed after the child's authorization wait: refuse before npm I/O.
      expect(() => verifyParent("completed", "failure")).toThrow(
        "release publish parent run state is not allowed by active",
      );
      expect(() => verifyParent("completed", "success")).toThrow();
      expect(() => verifyParent("in_progress", null)).not.toThrow();

      const script = publish.run;
      const mutation =
        workflow === "openclaw-npm-release"
          ? /verify_release_tooling_identity\n\s*bash scripts\/openclaw-npm-publish\.sh --publish/gu
          : null;
      if (mutation) {
        const publishes = script.match(/bash scripts\/openclaw-npm-publish\.sh --publish/gu) ?? [];
        expect(publishes.length).toBeGreaterThan(0);
        expect(script.match(mutation)).toHaveLength(publishes.length);
      } else {
        const verified = script.indexOf(
          `--release-publish-parent-state-policy "$${policyVariable}"`,
        );
        expect(verified).toBeGreaterThan(-1);
        expect(verified).toBeLessThan(script.indexOf("npm publish"));
      }
    },
  );

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
