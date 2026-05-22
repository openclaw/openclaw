import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const WORKFLOW = ".github/workflows/crabbox-pr-desktop-lease.yml";

type WorkflowStep = {
  env?: Record<string, string>;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, string>;
};

type WorkflowJob = {
  concurrency?: {
    "cancel-in-progress"?: boolean;
    group?: string;
  };
  needs?: string | string[];
  outputs?: Record<string, string>;
  steps?: WorkflowStep[];
};

type Workflow = {
  env?: Record<string, string>;
  jobs?: Record<string, WorkflowJob>;
  on?: {
    workflow_dispatch?: {
      inputs?: Record<string, { options?: string[]; type?: string }>;
    };
  };
  permissions?: Record<string, string>;
};

function readWorkflow(): Workflow {
  return parse(readFileSync(WORKFLOW, "utf8")) as Workflow;
}

describe("Crabbox PR desktop lease workflow", () => {
  it("exposes only supported desktop lease inputs", () => {
    const inputs = readWorkflow().on?.workflow_dispatch?.inputs ?? {};

    expect(inputs.pr_number?.type).toBe("string");
    expect(inputs.platform?.options).toEqual(["linux", "mac"]);
    expect(inputs.provider?.options).toEqual(["aws", "azure", "hetzner"]);
  });

  it("keeps the secret-bearing harness on trusted code", () => {
    const workflow = readWorkflow();
    const text = readFileSync(WORKFLOW, "utf8");
    const checkout = workflow.jobs?.["pr-desktop-lease"]?.steps?.find(
      (step) => step.name === "Checkout harness ref",
    );

    expect(workflow.env?.CRABBOX_REF).toMatch(/^[0-9a-f]{40}$/);
    expect(checkout?.uses).toBe("actions/checkout@v6");
    expect(checkout?.with?.ref).toBe("main");
    expect(text).not.toContain('--arg target_repo "${{ inputs.target_repo }}"');
    expect(text).not.toContain('--arg item_number "${{ inputs.item_number }}"');
  });

  it("uses narrow permissions and current artifact upload action", () => {
    const workflow = readWorkflow();
    const upload = workflow.jobs?.["pr-desktop-lease"]?.steps?.find(
      (step) => step.name === "Upload Crabbox PR desktop lease summary",
    );

    expect(workflow.permissions).toEqual({
      contents: "read",
      issues: "write",
      "pull-requests": "read",
    });
    expect(upload?.uses).toBe("actions/upload-artifact@v7");
  });

  it("does not queue new-head lease replacement behind the live bridge job", () => {
    const workflow = readWorkflow();
    const text = readFileSync(WORKFLOW, "utf8");
    const leaseJob = workflow.jobs?.["pr-desktop-lease"];

    expect(leaseJob?.needs).toEqual(["authorize_actor", "resolve_lease_key"]);
    expect(leaseJob?.concurrency?.group).toBe("${{ needs.resolve_lease_key.outputs.group }}");
    expect(leaseJob?.concurrency?.["cancel-in-progress"]).toBe(false);
    expect(workflow.jobs?.resolve_lease_key?.outputs?.head_sha).toBe(
      "${{ steps.key.outputs.head_sha }}",
    );
    expect(text).toContain('head_sha="$(gh pr view "$pr_number"');
    expect(text).toContain('CLIENT_HEAD_SHA: ${{ github.event.client_payload.head_sha }}');
    expect(text).toContain('head_sha="${INPUT_HEAD_SHA:-${CLIENT_HEAD_SHA:-}}"');
    expect(text).toContain('key_tail="${head_sha:-$RUN_ID}"');
    expect(text).toContain('echo "head_sha=$head_sha" >> "$GITHUB_OUTPUT"');
    expect(text).toContain(
      "INPUT_HEAD_SHA: ${{ inputs.head_sha || needs.resolve_lease_key.outputs.head_sha }}",
    );
    expect(text).toContain(
      "CRABBOX_PR_DESKTOP_LEASE_HEAD_SHA: ${{ needs.resolve_lease_key.outputs.head_sha }}",
    );
    expect(text).not.toContain('target_repo="${INPUT_TARGET_REPO:-${{ github.event.client_payload');
  });
});
