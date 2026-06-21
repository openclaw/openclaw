import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const WORKFLOW_PATH = ".github/workflows/openclaw-release-publish.yml";

type WorkflowInput = {
  default?: boolean | string;
  required?: boolean;
  type?: string;
};

type WorkflowStep = {
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, string>;
};

type WorkflowJob = {
  environment?: string;
  if?: string;
  needs?: string | string[];
  outputs?: Record<string, string>;
  permissions?: Record<string, string>;
  steps?: WorkflowStep[];
};

type Workflow = {
  on?: {
    workflow_dispatch?: {
      inputs?: Record<string, WorkflowInput>;
    };
  };
  jobs?: Record<string, WorkflowJob>;
};

function workflowText(): string {
  return readFileSync(WORKFLOW_PATH, "utf8");
}

function workflow(): Workflow {
  return parse(workflowText()) as Workflow;
}

function job(name: string): WorkflowJob {
  const value = workflow().jobs?.[name];
  if (!value) {
    throw new Error(`Missing workflow job ${name}`);
  }
  return value;
}

function step(jobName: string, name: string): WorkflowStep {
  const value = job(jobName).steps?.find((candidate) => candidate.name === name);
  if (!value) {
    throw new Error(`Missing workflow step ${jobName}/${name}`);
  }
  return value;
}

describe("OpenClaw release publish policy workflow", () => {
  it("exposes additive legacy and strict selector inputs", () => {
    const inputs = workflow().on?.workflow_dispatch?.inputs ?? {};
    expect(inputs.policy_mode).toMatchObject({ required: true, default: "legacy", type: "choice" });
    expect(inputs.release_selector).toMatchObject({ required: false, type: "string" });
    expect(inputs.npm_dist_tag).toMatchObject({ required: false, type: "string" });
  });

  it("rejects nonpublishable policy in an initial unprivileged job", () => {
    const policy = job("release_policy");
    expect(policy.needs).toBeUndefined();
    expect(policy.environment).toBeUndefined();
    expect(policy.permissions).toEqual({ actions: "read", contents: "read" });
    const gate = step("release_policy", "Validate release publication policy");
    expect(gate.run).toContain("validateStrictPublishPolicy");
    expect(gate.run).toContain("resolveNpmPublishPlan");
    expect(gate.run).not.toContain('alpha) expected_dist_tag="alpha"');
    expect(gate.run).toContain("Strict stable policy is nonpublishable");
    expect(gate.run).toContain("Legacy publication rejects uncorrected final patch 33 and greater");
    expect(job("resolve_release_target").needs).toEqual(["release_policy"]);
    expect(job("resolve_release_target").permissions).toEqual({
      actions: "read",
      contents: "read",
    });
    expect(job("publish").environment).toBe("npm-release");
  });

  it("authenticates strict v2 and v3 predecessor evidence", () => {
    const validate = step("resolve_release_target", "Validate strict release predecessor evidence");
    expect(validate.if).toContain("inputs.policy_mode == 'strict'");
    expect(validate.run).toContain("validatePreflightManifest");
    expect(validate.run).toContain("validateFullValidationManifest");
    expect(validate.run).toContain("preflight.version !== 2");
    expect(validate.run).toContain("fullValidation.version !== 3");
    expect(validate.run).toContain("publishEligible !== true");
    expect(validate.run).toContain(".run_attempt");
    expect(validate.run).toContain(".path == $path");
    expect(validate.run).toContain('preflight_payload_sha256="$(sha256sum');
    expect(validate.run).toContain('full_validation_payload_sha256="$(sha256sum');
  });

  it("writes, uploads, verifies, and dispatches one attempt-qualified publish manifest", () => {
    const prepare = step("publish", "Prepare strict publish manifest");
    expect(prepare.run).toContain('operation: "publish"');
    expect(prepare.run).toContain("verify-release-operation.mjs");
    expect(prepare.run).toContain("write-release-publish-manifest.mjs");
    for (const flag of [
      "--release-policy",
      "--release-policy-sha256",
      "--preflight-manifest",
      "--preflight-descriptor",
      "--full-validation-manifest",
      "--full-validation-descriptor",
      "--verification-result",
      "--changelog-evidence",
      "--output",
    ]) {
      expect(prepare.run).toContain(flag);
    }
    expect(workflowText().match(/write-release-publish-manifest\.mjs/g)).toHaveLength(1);

    const upload = step("publish", "Upload strict publish manifest");
    expect(upload.if).toContain("inputs.policy_mode == 'strict'");
    expect(upload.with?.name).toBe(
      "release-publish-manifest-${{ github.run_id }}-${{ github.run_attempt }}",
    );
    expect(upload.with?.path).toBe("${{ runner.temp }}/openclaw-release-publish-manifest");

    const verify = step("publish", "Verify uploaded strict publish manifest");
    expect(verify.run).toContain("exactly one release-publish-manifest.json");
    expect(verify.run).toContain("uploaded publish manifest payload digest mismatch");

    const dispatch = step("publish", "Dispatch publish workflows");
    for (const input of [
      'publish_manifest_run_id="${GITHUB_RUN_ID}"',
      'publish_manifest_run_attempt="${GITHUB_RUN_ATTEMPT}"',
      'publish_manifest_artifact_name="${PUBLISH_MANIFEST_ARTIFACT_NAME}"',
      'publish_manifest_payload_sha256="${PUBLISH_MANIFEST_PAYLOAD_SHA256}"',
    ]) {
      expect(dispatch.run).toContain(input);
    }

    const steps = job("publish").steps ?? [];
    const index = (name: string) => steps.findIndex((candidate) => candidate.name === name);
    expect(index("Prepare strict publish manifest")).toBeLessThan(
      index("Upload strict publish manifest"),
    );
    expect(index("Upload strict publish manifest")).toBeLessThan(
      index("Verify uploaded strict publish manifest"),
    );
    expect(index("Verify uploaded strict publish manifest")).toBeLessThan(
      index("Dispatch publish workflows"),
    );
  });

  it("uses the postpublish verifier and sole v2 writer without later jq mutation", () => {
    const dispatch = step("publish", "Dispatch publish workflows");
    expect(dispatch.run).toContain('.operation = "postpublish"');
    expect(dispatch.run).toContain("write-release-postpublish-evidence.mjs");
    expect(dispatch.run).toContain(
      'postpublish_source="$RUNNER_TEMP/openclaw-release-postpublish-source"',
    );
    expect(dispatch.run).toContain('--source-dir "$postpublish_source"');
    expect(dispatch.run).toContain('--source-sha "$TARGET_SHA"');
    expect(dispatch.run).toContain('--release-publish-run-attempt "$GITHUB_RUN_ATTEMPT"');

    const writerIndex = dispatch.run?.indexOf("write-release-postpublish-evidence.mjs") ?? -1;
    expect(writerIndex).toBeGreaterThan(-1);
    expect(dispatch.run?.slice(writerIndex)).not.toMatch(/jq[^\n]*releasePublishRunId/);

    const upload = step("publish", "Upload postpublish evidence");
    expect(upload.if).toBe("${{ success() }}");
    expect(upload.with?.path).toBe(
      "${{ runner.temp }}/openclaw-release-postpublish-evidence/release-postpublish-evidence.json",
    );
    expect(upload.with?.["if-no-files-found"]).toBe("error");
  });
});
