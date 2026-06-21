import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const WORKFLOW_PATH = ".github/workflows/openclaw-npm-release.yml";

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

describe("OpenClaw npm release policy workflow", () => {
  it("keeps workflow_dispatch and exposes the closed compatibility inputs", () => {
    const dispatch = workflow().on?.workflow_dispatch;
    expect(dispatch).toBeDefined();
    const inputs = dispatch?.inputs ?? {};

    expect(Object.keys(inputs)).toEqual([
      "tag",
      "preflight_only",
      "preflight_run_id",
      "full_release_validation_run_id",
      "release_publish_run_id",
      "npm_dist_tag",
      "policy_mode",
      "release_selector",
      "publish_manifest_run_id",
      "publish_manifest_run_attempt",
      "publish_manifest_artifact_name",
      "publish_manifest_payload_sha256",
    ]);
    expect(inputs.policy_mode).toMatchObject({ required: true, default: "legacy", type: "choice" });
    expect(inputs.release_selector).toMatchObject({ required: false, type: "string" });
    expect(inputs.npm_dist_tag).toMatchObject({ required: false, type: "string" });
    for (const name of [
      "publish_manifest_run_id",
      "publish_manifest_run_attempt",
      "publish_manifest_artifact_name",
      "publish_manifest_payload_sha256",
    ]) {
      expect(inputs[name]).toMatchObject({ required: false, type: "string" });
    }
  });

  it("runs one unprivileged fail-closed policy and evidence gate first", () => {
    const policy = job("release_policy");
    expect(policy.needs).toBeUndefined();
    expect(policy.environment).toBeUndefined();
    expect(policy.permissions).toEqual({ actions: "read", contents: "read" });
    expect(policy.outputs).toMatchObject({
      publish_eligible: "${{ steps.policy.outputs.publish_eligible }}",
      release_policy: "${{ steps.policy.outputs.release_policy }}",
      release_policy_sha256: "${{ steps.policy.outputs.release_policy_sha256 }}",
    });

    const gate = step("release_policy", "Validate release policy and immutable publish evidence");
    expect(gate.run).toContain("validateStrictPublishPolicy");
    expect(gate.run).toContain("resolveNpmPublishPlan");
    expect(gate.run).toContain("verify-release-operation.mjs");
    expect(gate.run).toContain("sha-preflight");
    expect(gate.run).toContain("tag-preflight");
    expect(gate.run).toContain("publish_manifest_run_attempt");
    expect(gate.run).toContain("release-publish-manifest.json");
    expect(gate.run).toContain("validatePublishManifest");
    expect(gate.run).toContain("validatePreflightManifest");
    expect(gate.run).toContain("validateFullValidationManifest");
    expect(gate.run).toContain("exactly one release-publish-manifest.json");
    expect(gate.run).toContain("publish manifest payload digest mismatch");
    expect(gate.run).toContain("publish manifest policy mismatch");
    expect(gate.run).toContain("publish manifest predecessor mismatch");
    expect(gate.run).toContain(
      "Full Validation predecessor artifact must contain exactly its manifest",
    );
    expect(gate.run).toContain("Strict preflight dependency-evidence closure is incomplete");
    expect(gate.run).toContain("Strict preflight artifact root file set is not closed");
    expect(gate.run).toContain("publish manifest target mismatch");
    expect(gate.run).toContain("publish manifest changelog mismatch");
    expect(gate.run).not.toContain('alpha) expected_dist_tag="alpha"');
  });

  it("emits the exact policy-only v2 bundle and preserves strict publishable v2", () => {
    const policyArtifact = step("release_policy", "Upload policy-only stable preflight");
    expect(policyArtifact.if).toContain("publish_eligible == 'false'");
    expect(policyArtifact.with?.path).toBe("${{ runner.temp }}/openclaw-npm-policy-only-preflight");

    const gate = step("release_policy", "Validate release policy and immutable publish evidence");
    expect(gate.run).toContain("policy-only strict stable preflight requires preflight_only=true");
    expect(gate.run).toContain("policy-only strict stable preflight cannot be promoted");
    expect(gate.run).toContain("npmDistTag: null");
    expect(gate.run).toContain("tarballName: null");
    expect(gate.run).toContain("dependencyEvidenceManifest: null");

    const pack = step("preflight_openclaw_npm", "Pack prepared npm tarball");
    expect(pack.run).toContain("POLICY_MODE");
    expect(pack.run).toContain('version: policyMode === "strict" ? 2 : 1');
    expect(pack.run).toContain("releasePolicySha256");
    expect(pack.run).toContain("validatePreflightManifest");
  });

  it("guards every build, environment, and publish path on policy eligibility", () => {
    const preflight = job("preflight_openclaw_npm");
    const validate = job("validate_publish_request");
    const publish = job("publish_openclaw_npm");

    expect(preflight.needs).toEqual(["release_policy"]);
    expect(preflight.if).toContain("needs.release_policy.outputs.publish_eligible == 'true'");
    expect(validate.needs).toEqual(["release_policy"]);
    expect(validate.if).toContain("needs.release_policy.outputs.publish_eligible == 'true'");
    expect(publish.needs).toEqual(["release_policy", "validate_publish_request"]);
    expect(publish.if).toContain("needs.release_policy.outputs.publish_eligible == 'true'");
    expect(publish.environment).toBe("npm-release");

    const text = workflowText();
    expect(text.indexOf("release_policy:")).toBeLessThan(text.indexOf("preflight_openclaw_npm:"));
    expect(text.indexOf("release_policy:")).toBeLessThan(text.indexOf("environment: npm-release"));
    expect(text.indexOf("release_policy:")).toBeLessThan(text.indexOf("id-token: write"));
  });
});
