import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { UPLOAD_ARTIFACT_V7, type WorkflowStep } from "./ci-workflow.test-support.js";

const WORKFLOW = ".github/workflows/native-app-locale-refresh.yml";

function readWorkflow() {
  return parse(readFileSync(WORKFLOW, "utf8"));
}

function compact(value: string): string {
  return value.replace(/\s+/gu, " ");
}

describe("native app locale refresh workflow", () => {
  it("keeps non-publishing dispatches separate from credentialed publication", () => {
    const workflow = readWorkflow();
    const resolveBase = workflow.jobs["resolve-base"];
    const preflight = workflow.jobs["publisher-preflight"];
    const refresh = workflow.jobs.refresh;
    const finalize = workflow.jobs.finalize;
    const resolveStep = resolveBase.steps.find(
      (step: WorkflowStep) => step.name === "Resolve source commit",
    );
    const patchStep = finalize.steps.find(
      (step: WorkflowStep) => step.name === "Prepare non-publishing locale patch",
    );
    const uploadStep = finalize.steps.find(
      (step: WorkflowStep) => step.name === "Upload non-publishing locale patch",
    );
    const publishStep = finalize.steps.find(
      (step: WorkflowStep) => step.name === "Open or update generated locale PR",
    );
    const reviewStep = resolveBase.steps.find(
      (step: WorkflowStep) => step.name === "Require reviewed source for translation",
    );
    const revalidateStepIndex = refresh.steps.findIndex(
      (step: WorkflowStep) => step.name === "Revalidate reviewed source",
    );
    const translateStepIndex = refresh.steps.findIndex(
      (step: WorkflowStep) => step.name === "Refresh locale translations",
    );
    const revalidateStep = refresh.steps[revalidateStepIndex];

    expect(workflow.on.workflow_dispatch.inputs).toMatchObject({
      full_refresh: { default: false, type: "boolean" },
      publish: { default: true, type: "boolean" },
      preflight_only: { default: false, type: "boolean" },
      source_sha: { required: false, type: "string" },
    });
    expect(workflow.permissions).toEqual({ contents: "read", "pull-requests": "read" });
    expect(compact(workflow.concurrency.group)).toBe(
      "${{ github.event_name == 'workflow_dispatch' && inputs.preflight_only && format('native-app-locale-preflight-{0}', github.ref) || 'native-app-locale-refresh' }}",
    );
    expect(compact(resolveBase.if)).toBe(
      "github.repository == 'openclaw/openclaw' && (github.event_name != 'workflow_dispatch' || (inputs.publish && !inputs.preflight_only && github.ref == 'refs/heads/main') || (!inputs.publish && !inputs.preflight_only && github.ref == 'refs/heads/main') || (inputs.preflight_only && github.ref_type == 'branch'))",
    );
    expect(resolveStep.env.WORKFLOW_SHA).toBe("${{ github.workflow_sha }}");
    expect(resolveStep.env.REQUESTED_SOURCE_SHA).toBe("${{ inputs.source_sha }}");
    expect(compact(resolveStep.env.NON_PUBLISHING)).toBe(
      "${{ github.event_name == 'workflow_dispatch' && (!inputs.publish || inputs.preflight_only) }}",
    );
    expect(resolveStep.run).toContain('sha="${WORKFLOW_SHA}"');
    expect(resolveStep.run).toContain('sha="${REQUESTED_SOURCE_SHA}"');
    expect(reviewStep.if).toBe(
      "github.event_name == 'workflow_dispatch' && !inputs.publish && !inputs.preflight_only",
    );
    expect(reviewStep.env.SOURCE_SHA).toBe("${{ steps.base.outputs.sha }}");
    expect(reviewStep.run).toContain('.reviewDecision == "APPROVED"');
    expect(resolveBase.outputs["reviewed-pr"]).toBe("${{ steps.review.outputs.pr }}");
    expect(compact(preflight.if)).toBe(
      "needs.resolve-base.result == 'success' && (github.event_name != 'workflow_dispatch' || (inputs.publish && !inputs.preflight_only))",
    );
    expect(compact(refresh.if)).toBe(
      "always() && needs.resolve-base.result == 'success' && (needs.publisher-preflight.result == 'success' || (github.event_name == 'workflow_dispatch' && !inputs.publish && needs.publisher-preflight.result == 'skipped')) && !(github.event_name == 'workflow_dispatch' && inputs.preflight_only)",
    );
    expect(revalidateStepIndex).toBeGreaterThan(-1);
    expect(translateStepIndex).toBe(revalidateStepIndex + 1);
    expect(revalidateStep.env).toEqual({
      DEFAULT_BRANCH: "${{ github.event.repository.default_branch }}",
      GH_TOKEN: "${{ github.token }}",
      REPOSITORY: "${{ github.repository }}",
      REVIEWED_PR: "${{ needs.resolve-base.outputs.reviewed-pr }}",
      SOURCE_SHA: "${{ needs.resolve-base.outputs.sha }}",
    });
    expect(revalidateStep.run).toContain('.reviewDecision == "APPROVED"');
    expect(revalidateStep.run).toContain(".head.sha == $sha");
    expect(compact(finalize.if)).toBe(
      "always() && needs.resolve-base.result == 'success' && (needs.publisher-preflight.result == 'success' || (github.event_name == 'workflow_dispatch' && !inputs.publish && needs.publisher-preflight.result == 'skipped')) && needs.refresh.result == 'success'",
    );
    expect(patchStep.if).toBe("github.event_name == 'workflow_dispatch' && !inputs.publish");
    expect(patchStep.run).toContain("Unexpected generated path");
    expect(patchStep.run).toContain("git diff --cached --binary --full-index");
    expect(uploadStep).toMatchObject({
      if: "github.event_name == 'workflow_dispatch' && !inputs.publish",
      uses: UPLOAD_ARTIFACT_V7,
    });
    expect(publishStep.if).toBe("github.event_name != 'workflow_dispatch' || inputs.publish");
  });
});
