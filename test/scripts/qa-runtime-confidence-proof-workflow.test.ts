import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const WORKFLOW_PATH = ".github/workflows/qa-runtime-confidence-proof.yml";

type WorkflowStep = {
  env?: Record<string, string>;
  if?: string | boolean;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, string | boolean>;
};

type WorkflowJob = {
  env?: Record<string, string>;
  environment?: string;
  if?: string | boolean;
  name?: string;
  needs?: string | string[];
  "timeout-minutes"?: number;
  steps?: WorkflowStep[];
};

type Workflow = {
  jobs?: Record<string, WorkflowJob>;
};

function readWorkflow(): Workflow {
  return parse(readFileSync(WORKFLOW_PATH, "utf8")) as Workflow;
}

function workflowJob(name: string): WorkflowJob {
  const job = readWorkflow().jobs?.[name];
  if (!job) {
    throw new Error(`Expected workflow job ${name}`);
  }
  return job;
}

function workflowStep(job: WorkflowJob, name: string): WorkflowStep {
  const step = job.steps?.find((candidate) => candidate.name === name);
  if (!step) {
    throw new Error(`Expected workflow step ${name}`);
  }
  return step;
}

describe("QA runtime confidence proof workflow", () => {
  it("splits proof into authorization, ref validation, static, mock, live, soak, and final aggregation jobs", () => {
    expect(Object.keys(readWorkflow().jobs ?? {})).toEqual([
      "authorize_actor",
      "validate_selected_ref",
      "static_unit",
      "mock_confidence",
      "live_confidence",
      "soak_confidence",
      "final_confidence",
    ]);
    expect(workflowJob("validate_selected_ref")).toMatchObject({
      needs: "authorize_actor",
    });
    expect(
      workflowStep(workflowJob("validate_selected_ref"), "Validate selected ref").run,
    ).toContain('trusted_reason="same-repository-branch-head"');
    expect(workflowJob("static_unit")).toMatchObject({
      needs: ["validate_selected_ref"],
    });
    expect(workflowJob("soak_confidence")).toMatchObject({
      if: "inputs.run_soak",
      needs: ["validate_selected_ref"],
      "timeout-minutes": 360,
    });
    expect(workflowJob("final_confidence")).toMatchObject({
      if: "always()",
      needs: [
        "validate_selected_ref",
        "static_unit",
        "mock_confidence",
        "live_confidence",
        "soak_confidence",
      ],
    });
  });

  it("keeps mock confidence partial and moves soak to the dedicated long-timeout job", () => {
    const mock = workflowJob("mock_confidence");
    const mockStepNames = mock.steps?.map((step) => step.name) ?? [];

    expect(mockStepNames).not.toContain("Run optional soak-100 lane");
    expect(workflowStep(mock, "Build strict confidence report").run).toContain(
      "--strict-zero-unknowns",
    );
    expect(workflowStep(mock, "Build strict confidence report").run).not.toContain(
      "--strict-global-pass",
    );

    const soakRun = workflowStep(workflowJob("soak_confidence"), "Run soak-100 lane").run;
    expect(soakRun).toContain("--runtime-suite soak-100");
    expect(soakRun).toContain('--output-dir "${root}/soak-100"');
  });

  it("writes live proof lanes into the manifest-compatible artifact root", () => {
    const live = workflowJob("live_confidence");
    const liveRun = workflowStep(live, "Run live proof lanes").run;

    expect(live).toMatchObject({
      needs: ["validate_selected_ref"],
      environment: "qa-live-shared",
    });
    expect(live.env ?? {}).not.toHaveProperty("OPENAI_API_KEY");
    expect(live.env ?? {}).not.toHaveProperty("OPENCLAW_LIVE_OPENAI_KEY");
    expect(workflowStep(live, "Require live credentials").env).toMatchObject({
      OPENAI_API_KEY: "${{ secrets.OPENAI_API_KEY }}",
      OPENCLAW_LIVE_OPENAI_KEY: "${{ secrets.OPENCLAW_LIVE_OPENAI_KEY }}",
    });
    expect(workflowStep(live, "Run live proof lanes").env).toMatchObject({
      OPENAI_API_KEY: "${{ secrets.OPENAI_API_KEY }}",
      OPENCLAW_LIVE_OPENAI_KEY: "${{ secrets.OPENCLAW_LIVE_OPENAI_KEY }}",
    });
    expect(workflowStep(live, "Require live credentials").run).toContain(
      "OPENAI_API_KEY or OPENCLAW_LIVE_OPENAI_KEY",
    );
    expect(liveRun).toContain('root=".artifacts/qa-e2e"');
    expect(liveRun).toContain("--runtime-suite codex-native-live");
    expect(liveRun).toContain("--runtime-suite first-hour-live");
    expect(liveRun).toContain("--runtime-suite openclaw-dynamic-tools");
    expect(liveRun).toContain("--codex-tool-loading searchable");
    expect(liveRun).toContain("openclaw-dynamic-tools-searchable-live");
    expect(liveRun).toContain('--summary "${root}/first-hour-live/qa-suite-summary.json"');
    expect(workflowStep(live, "Upload live confidence artifacts").with).toMatchObject({
      path: ".artifacts/qa-e2e/**",
    });
  });

  it("downloads all lane artifacts and runs final strict global confidence when requested", () => {
    const finalJob = workflowJob("final_confidence");
    const validate = workflowStep(finalJob, "Validate strict global inputs").run;
    const download = workflowStep(finalJob, "Download confidence artifacts");
    const finalReport = workflowStep(finalJob, "Build final confidence report").run;

    expect(validate).toContain("strict_global requires expected_sha");
    expect(validate).toContain("strict_global requires run_live=true and run_soak=true");
    expect(validate).toContain("strict_global requires ${job} to succeed");
    expect(download).toEqual({
      name: "Download confidence artifacts",
      uses: "actions/download-artifact@v7",
      with: {
        pattern: "qa-runtime-confidence-*",
        "merge-multiple": true,
        path: ".artifacts/qa-e2e",
      },
    });
    expect(finalReport).toContain("--strict-zero-unknowns");
    expect(finalReport).toContain("args+=(--strict-global-pass)");
    expect(workflowStep(finalJob, "Upload final confidence artifacts").with).toMatchObject({
      path: ".artifacts/qa-e2e/**",
    });
  });
});
