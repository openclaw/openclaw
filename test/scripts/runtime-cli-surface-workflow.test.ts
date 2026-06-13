import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const WORKFLOW_PATH = ".github/workflows/runtime-cli-surface.yml";

type WorkflowStep = {
  name?: string;
  with?: Record<string, string>;
};

type WorkflowJob = {
  steps?: WorkflowStep[];
};

type Workflow = {
  jobs?: Record<string, WorkflowJob>;
};

function workflowStep(stepName: string): WorkflowStep {
  const workflow = parse(readFileSync(WORKFLOW_PATH, "utf8")) as Workflow;
  const step = workflow.jobs?.smoke?.steps?.find((candidate) => candidate.name === stepName);
  expect(step, `expected workflow step ${stepName}`).toBeDefined();
  return step!;
}

describe("runtime-cli-surface workflow", () => {
  it("does not fail drift reporting when repository Issues are disabled", () => {
    const script = workflowStep("Open CLI drift issue on assertion failure").with?.script ?? "";

    expect(script).toContain("error.status === 410");
    expect(script).toContain("Issues are disabled on this repository");
    expect(script).toContain("CLI drift issue was not opened");
    expect(script).toContain("async function ensureLabels()");
    expect(script).toContain("await github.rest.issues.createLabel");
    expect(script).toContain("return;");
  });
});
