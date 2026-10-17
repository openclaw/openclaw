import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
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
  needs?: string[] | string;
  permissions?: Record<string, string>;
  steps: WorkflowStep[];
};

function requireJob(workflow: string, jobId: string): WorkflowJob {
  const data: { jobs: Record<string, WorkflowJob> } = parse(
    readFileSync(`.github/workflows/${workflow}.yml`, "utf8"),
  );
  return expectDefined(data.jobs[jobId], `${workflow}/${jobId}`);
}

function requireStep(job: WorkflowJob, name: string): WorkflowStep {
  return expectDefined(
    job.steps.find((candidate) => candidate.name === name),
    `step ${name}`,
  );
}

function containsAll(script: string | undefined, fragments: string[]) {
  for (const fragment of fragments) {
    expect(script).toContain(fragment);
  }
}

const core = "openclaw-npm-release";
const plugin = "plugin-npm-release";
const clawhub = "plugin-clawhub-release";
const coreValidation = "validate_publish_request";
const pluginValidation = "validate_release_publish_approval";
const coreFlow = [core, coreValidation, "openclaw"] as const;
const pluginFlow = [plugin, pluginValidation, "plugins"] as const;
const parentPolicy = "RELEASE_PUBLISH_PARENT_STATE_POLICY";
const parentEnv = {
  RELEASE_PUBLISH_RUN_ID: "${{ inputs.release_publish_run_id }}",
  RELEASE_PUBLISH_RUN_ATTEMPT: "${{ inputs.release_publish_run_attempt }}",
  EXPECTED_WORKFLOW_SHA: "${{ github.workflow_sha }}",
};
const receiptOutput = "${{ steps.receipt.outputs.parent_approval }}";

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
  const [write, attest, upload] = publish.steps.slice(initializeIndex + 1, initializeIndex + 4);
  expect(write).toMatchObject({ id: "approval_receipt" });
  expect(write?.run).toContain("release-approval-receipt.mjs create");
  expect(attest?.with?.["subject-path"]).toBe(
    "${{ runner.temp }}/openclaw-release-approval/approval.json",
  );
  expect(upload?.with).toMatchObject({
    name: "${{ steps.approval_receipt.outputs.artifact_name }}",
    path: "${{ runner.temp }}/openclaw-release-approval/approval.json",
    "if-no-files-found": "error",
  });
});

it.each([
  [plugin, pluginValidation],
  [core, coreValidation],
  [clawhub, pluginValidation],
])("%s verifies the parent receipt and attestation for bot dispatches", (workflow, jobId) => {
  const job = requireJob(workflow, jobId);
  expect(job.permissions?.attestations).toBe("read");
  const step = job.steps.at(-1);
  expect(step?.if).toBeUndefined();
  expect(step).toMatchObject({
    name: "Verify release approval receipt",
    id: "receipt",
    env: {
      GH_TOKEN: "${{ github.token }}",
      ...parentEnv,
      EXPECTED_WORKFLOW_BRANCH: "${{ inputs.release_publish_branch || github.ref_name }}",
      EXPECTED_WORKFLOW_FULL_REF:
        workflow === clawhub
          ? "${{ inputs.release_publish_full_ref }}"
          : "${{ inputs.release_publish_full_ref || github.ref }}",
      ...(workflow === clawhub ? { RELEASE_PUBLISH_PARENT_STATE_POLICY: "active-or-success" } : {}),
      ...(workflow === core
        ? {
            RELEASE_TAG: "${{ inputs.tag }}",
            RELEASE_NPM_DIST_TAG: "${{ inputs.npm_dist_tag }}",
          }
        : {
            RELEASE_TARGET_SHA: `\${{ needs.${workflow === plugin ? "preview_plugins_npm" : "preview_plugins_clawhub"}.outputs.ref_revision }}`,
          }),
    },
  });
  // Zizmor bot-conditions rejects `if: github.actor == ...`; the guard lives in bash.
  containsAll(step?.run, [
    'if [[ "${GITHUB_ACTOR}" != "github-actions[bot]" ]]; then',
    "release-approval-receipt.mjs verify",
    'gh attestation verify "$RUNNER_TEMP/openclaw-release-approval/approval.json"',
    '--signer-workflow "$GITHUB_REPOSITORY/.github/workflows/openclaw-release-publish.yml"',
    '--signer-digest "$EXPECTED_WORKFLOW_SHA"',
    '--source-digest "$EXPECTED_WORKFLOW_SHA"',
    '--source-ref "$EXPECTED_WORKFLOW_FULL_REF"',
    "--deny-self-hosted-runners",
  ]);
  if (workflow === core) {
    expect(requireStep(job, "Checkout trusted approval verifier").with).toMatchObject({
      ref: "${{ github.workflow_sha }}",
      path: "trusted-workflow",
      "sparse-checkout": "scripts",
    });
    expect(step?.run).toContain(
      "node trusted-workflow/scripts/release-approval-receipt.mjs verify",
    );
  }
});

it.each([coreFlow, pluginFlow])(
  "%s requires human approval or a verified receipt before publication",
  (workflow, validationId, owner) => {
    const approvalId = `approve_${owner}_npm_release`;
    const mutationName = owner === "openclaw" ? "Publish" : "Publish with trusted publisher";
    const approval = requireJob(workflow, approvalId);
    const publish = requireJob(workflow, `publish_${owner}_npm`);
    expect(requireJob(workflow, validationId).outputs?.parent_approval).toBe(receiptOutput);
    expect(approval).toMatchObject({
      environment: "npm-release",
      steps: [{ run: expect.stringMatching(/^echo /) }],
    });
    expect(approval.permissions).toEqual({ contents: "read" });
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
    if (workflow === plugin) {
      expect(evaluate(approval.if, "", "skipped", "success", false, false, "false")).toBe(false);
      expect(evaluate(publish.if, "receipt", "skipped", "success", false, false, "false")).toBe(
        false,
      );
    }
    const wait = requireStep(publish, "Wait for the release parent's npm authorization");
    expect(wait).toMatchObject({
      if: `needs.${validationId}.outputs.parent_approval == 'receipt'`,
      env: {
        GH_TOKEN: "${{ github.token }}",
        ...parentEnv,
      },
      run: `node ${workflow === core ? "trusted-workflow/" : ""}scripts/release-approval-receipt.mjs wait-npm-authorization`,
    });
    const names = publish.steps.map((step) => step.name);
    expect(names.indexOf(wait.name)).toBeLessThan(names.indexOf(mutationName));
    const checkout = requireStep(
      publish,
      workflow === core
        ? "Checkout trusted validation verifier"
        : "Checkout trusted publication tooling",
    );
    expect(checkout.with?.ref).toBe("${{ github.workflow_sha }}");
    expect(names.indexOf(checkout.name)).toBeLessThan(names.indexOf(wait.name));
  },
);

it.each([
  [coreFlow, "Publish", parentPolicy],
  [pluginFlow, "Publish with trusted publisher", `OPENCLAW_${parentPolicy}`],
  [pluginFlow, "Publish approved bootstrap tarball", parentPolicy],
] as const)(
  "%s %s re-verifies a live parent before npm publish on the receipt route (%s)",
  ([workflow, validationId, owner], stepName, policyVariable) => {
    const job = requireJob(workflow, `publish_${owner}_npm`);
    const publish = requireStep(job, stepName);
    const policyExpression = expectDefined(publish.env?.[policyVariable], "parent state policy");
    const policyFor = (parentApproval: string, actor: string) =>
      runInNewContext(policyExpression.replace(/^\$\{\{|\}\}$/gu, ""), {
        github: { actor },
        inputs: { release_publish_run_id: "67890" },
        needs: { [validationId]: { outputs: { parent_approval: parentApproval } } },
      });
    const bot = "github-actions[bot]";
    expect(policyFor("receipt", bot)).toBe("active");
    expect(policyFor("", "release-manager")).toBe("manual-recovery");
    if (workflow === plugin) {
      // Human-approved bot children keep the existing finish-after-failure contract.
      expect(policyFor("", bot)).toBe("active-or-failure");
    }

    const script = expectDefined(publish.run, "publication script");
    if (workflow === core) {
      const publishes =
        script.match(/bash trusted-workflow\/scripts\/openclaw-npm-publish\.sh --publish/gu) ?? [];
      expect(publishes).toHaveLength(2);
      const wrapper = readFileSync("scripts/openclaw-npm-publish.sh", "utf8");
      expect(wrapper).toContain("--verify-publication-authority");
      const authority = readFileSync("scripts/npm-preflight-tooling-identity.mjs", "utf8");
      containsAll(authority, [
        "releasePublishParentStatePolicy: env.RELEASE_PUBLISH_PARENT_STATE_POLICY",
        "verifyReleaseToolingIdentity(publicationAuthority)",
      ]);
    } else {
      const verified = script.indexOf(`--release-publish-parent-state-policy "$${policyVariable}"`);
      expect(verified).toBeGreaterThan(-1);
      expect(verified).toBeLessThan(script.indexOf("npm publish"));
    }
  },
);

it("replaces only the ClawHub human gate after parent receipt verification succeeds", () => {
  const validate = requireJob(clawhub, pluginValidation);
  const approve = requireJob(clawhub, "approve_plugins_clawhub_release");
  expect(validate.outputs?.parent_approval).toBe(receiptOutput);
  expect(approve).toMatchObject({
    environment:
      "${{ needs.validate_release_publish_approval.outputs.parent_approval != 'receipt' && 'clawhub-plugin-release' || '' }}",
    if: expect.stringContaining("needs.validate_release_publish_approval.result == 'success'"),
  });
  const receiptRoute =
    "needs.validate_release_publish_approval.outputs.parent_approval == 'receipt'";
  const wait = requireStep(approve, "Wait for the release parent's ClawHub authorization");
  expect(wait).toMatchObject({
    if: receiptRoute,
    env: parentEnv,
    run: "node scripts/release-approval-receipt.mjs wait-clawhub-authorization",
  });
  for (const name of ["Checkout trusted release tooling", "Setup Node"]) {
    expect(requireStep(approve, name).if).toContain(receiptRoute);
  }
  const publish = requireJob(clawhub, "publish_plugins_clawhub");
  expect(publish?.needs).toContain("approve_plugins_clawhub_release");
  expect(publish?.if).toContain("needs.approve_plugins_clawhub_release.result == 'success'");
});
