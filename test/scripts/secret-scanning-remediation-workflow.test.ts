// Secret Scanning Remediation Workflow tests cover the approval-gated workflow shape.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const WORKFLOW = ".github/workflows/secret-scanning-remediation.yml";

type WorkflowStep = {
  env?: Record<string, string>;
  id?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, string | boolean>;
};

type WorkflowJob = {
  environment?: string;
  if?: string;
  needs?: string;
  outputs?: Record<string, string>;
  permissions?: Record<string, string>;
  steps?: WorkflowStep[];
};

type Workflow = {
  jobs?: Record<string, WorkflowJob>;
  permissions?: Record<string, string>;
};

function readWorkflow(): Workflow {
  return parse(readFileSync(WORKFLOW, "utf8")) as Workflow;
}

describe("secret scanning remediation workflow", () => {
  it("uses a private plan job before the protected remediation job", () => {
    const parsed = readWorkflow();
    const plan = parsed.jobs?.["secret-scanning-plan"];
    const remediate = parsed.jobs?.["secret-scanning-remediate"];

    expect(parsed.permissions).toEqual({});
    expect(plan?.permissions).toEqual({
      contents: "read",
      "security-events": "read",
    });
    expect(plan?.outputs?.["remediation-action"]).toBe(
      "${{ steps.plan.outputs.remediation-action }}",
    );
    expect(remediate?.needs).toBe("secret-scanning-plan");
    expect(remediate?.if).toBe(
      "needs.secret-scanning-plan.outputs.remediation-action == 'approval-required'",
    );
    expect(remediate?.environment).toBe("secret-remediation");
  });

  it("checks out trusted default-branch scripts instead of the alert commit", () => {
    const jobs = readWorkflow().jobs ?? {};
    for (const job of Object.values(jobs)) {
      const checkout = job.steps?.[0];
      expect(checkout?.uses).toBe("actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd");
      expect(checkout?.with?.ref).toBe("${{ github.event.repository.default_branch }}");
      expect(checkout?.with?.["persist-credentials"]).toBe(false);
    }
  });

  it("does not post public comments from the plan job", () => {
    const parsed = readWorkflow();
    const plan = parsed.jobs?.["secret-scanning-plan"];
    const planSteps = parsed.jobs?.["secret-scanning-plan"]?.steps ?? [];

    expect(plan?.permissions).not.toHaveProperty("issues");
    expect(plan?.permissions).not.toHaveProperty("pull-requests");
    expect(planSteps.at(-1)?.env?.OPENCLAW_SECRET_SCAN_MODE).toBe("plan");
    expect(planSteps.at(-1)?.run).toBe("node scripts/github/secret-scanning-remediation.mjs");
  });

  it("grants write permissions only after environment approval", () => {
    const remediate = readWorkflow().jobs?.["secret-scanning-remediate"];
    const steps = remediate?.steps ?? [];

    expect(remediate?.permissions).toEqual({
      contents: "read",
      issues: "write",
      "pull-requests": "write",
      "security-events": "write",
    });
    expect(steps.at(-1)?.env?.OPENCLAW_SECRET_SCAN_MODE).toBe("remediate");
    expect(steps.at(-1)?.run).toBe("node scripts/github/secret-scanning-remediation.mjs");
  });
});
