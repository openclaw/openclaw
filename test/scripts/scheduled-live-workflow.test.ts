import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const workflow = parse(
  readFileSync(".github/workflows/openclaw-scheduled-live-checks.yml", "utf8"),
);

describe("scheduled live and E2E workflow", () => {
  it("uses a logged dispatcher job instead of a top-level reusable workflow job", () => {
    const jobs = Object.values(workflow.jobs ?? {}) as Array<Record<string, unknown>>;

    expect(jobs.some((job) => typeof job.uses === "string")).toBe(false);

    const dispatchJob = workflow.jobs?.dispatch_live_and_e2e_checks;
    expect(dispatchJob).toMatchObject({
      "runs-on": "ubuntu-24.04",
    });
    expect(dispatchJob.permissions).toMatchObject({
      actions: "write",
      contents: "read",
    });
    expect(dispatchJob.steps.map((step: { name?: string }) => step.name)).toEqual(
      expect.arrayContaining([
        "Checkout",
        "Run workflow sanity preflight",
        "Dispatch stable live and E2E checks",
      ]),
    );
  });

  it("dispatches the reusable workflow with stable nightly inputs", () => {
    const dispatchStep = workflow.jobs.dispatch_live_and_e2e_checks.steps.find(
      (step: { name?: string }) => step.name === "Dispatch stable live and E2E checks",
    );

    expect(dispatchStep.env).toMatchObject({
      CHILD_WORKFLOW: "openclaw-live-and-e2e-checks-reusable.yml",
      CHILD_WORKFLOW_REF: "${{ github.ref_name }}",
    });
    expect(dispatchStep.run).toContain("scripts/github/dispatch-and-monitor-workflow.sh");
    expect(dispatchStep.env.CHILD_WORKFLOW_FIELDS).toContain("ref=${{ github.sha }}");
    expect(dispatchStep.env.CHILD_WORKFLOW_FIELDS).toContain("include_repo_e2e=true");
    expect(dispatchStep.env.CHILD_WORKFLOW_FIELDS).toContain("include_release_path_suites=true");
    expect(dispatchStep.env.CHILD_WORKFLOW_FIELDS).toContain("include_openwebui=false");
    expect(dispatchStep.env.CHILD_WORKFLOW_FIELDS).toContain("include_live_suites=true");
    expect(dispatchStep.env.CHILD_WORKFLOW_FIELDS).toContain("live_models_only=true");
    expect(dispatchStep.env.CHILD_WORKFLOW_FIELDS).toContain("live_model_providers=openai");
    expect(dispatchStep.env.CHILD_WORKFLOW_FIELDS).toContain("release_test_profile=stable");
    expect(dispatchStep.env.CHILD_WORKFLOW_FIELDS).toContain(
      "docker_lanes=config-reload mcp-channels plugin-update",
    );
  });

  it("keeps live credential skips visible as JSON artifacts", () => {
    const reusable = parse(
      readFileSync(".github/workflows/openclaw-live-and-e2e-checks-reusable.yml", "utf8"),
    );
    const targeted = reusable.jobs.validate_live_models_docker_targeted;
    const preflight = targeted.steps.find(
      (step: { name?: string }) => step.name === "Check provider credentials",
    );
    const upload = targeted.steps.find(
      (step: { name?: string }) => step.name === "Upload live lane summary",
    );
    const runStep = targeted.steps.find(
      (step: { name?: string }) => step.name === "Run Docker live model sweep",
    );

    expect(preflight.run).toContain("scripts/github/live-provider-preflight.mjs");
    expect(runStep.if).toContain("steps.credential_preflight.outputs.should_run == '1'");
    expect(upload).toMatchObject({
      uses: "actions/upload-artifact@v7",
    });
    expect(upload.with.path).toBe(".artifacts/live-lane-summaries/*.json");
  });
});
