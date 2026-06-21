import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const FULL_VALIDATION = ".github/workflows/full-release-validation.yml";
const RELEASE_CHECKS = ".github/workflows/openclaw-release-checks.yml";
const MACOS_RELEASE = ".github/workflows/macos-release.yml";

type WorkflowInput = {
  default?: boolean | string;
  required?: boolean;
  type?: string;
};

type WorkflowStep = {
  env?: Record<string, string>;
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

function text(path: string): string {
  return readFileSync(path, "utf8");
}

function workflow(path: string): Workflow {
  return parse(text(path)) as Workflow;
}

function job(path: string, name: string): WorkflowJob {
  const value = workflow(path).jobs?.[name];
  if (!value) {
    throw new Error(`Missing workflow job ${path}/${name}`);
  }
  return value;
}

function step(path: string, jobName: string, name: string): WorkflowStep {
  const value = job(path, jobName).steps?.find((candidate) => candidate.name === name);
  if (!value) {
    throw new Error(`Missing workflow step ${path}/${jobName}/${name}`);
  }
  return value;
}

describe("Full Release Validation strict release policy", () => {
  it("keeps legacy as the default and adds explicit strict selector ingress", () => {
    const inputs = workflow(FULL_VALIDATION).on?.workflow_dispatch?.inputs ?? {};
    expect(inputs.policy_mode).toMatchObject({ required: true, default: "legacy", type: "choice" });
    expect(inputs.release_selector).toMatchObject({ required: false, type: "string" });
    expect(inputs.external_contract_revision).toMatchObject({ required: false, type: "string" });

    const ingress = step(FULL_VALIDATION, "release_policy", "Validate release policy ingress");
    expect(ingress.run).toContain("release_selector must be omitted in legacy mode");
    expect(ingress.run).toContain("alpha|beta|daily|stable");
    expect(ingress.run).toContain("^[0-9a-f]{40}$");
  });

  it("directly produces attempt-qualified internal-validation evidence before release checks", () => {
    const resolveTarget = job(FULL_VALIDATION, "resolve_target");
    expect(resolveTarget.needs).toBeUndefined();
    expect(step(FULL_VALIDATION, "resolve_target", "Resolve target SHA").env?.TARGET_REF).toBe(
      "${{ inputs.ref }}",
    );

    const policy = job(FULL_VALIDATION, "release_policy");
    expect(policy.environment).toBeUndefined();
    expect(policy.permissions).toEqual({ actions: "read", contents: "read" });
    expect(policy.needs).toEqual(["resolve_target"]);

    const verify = step(
      FULL_VALIDATION,
      "release_policy",
      "Verify strict internal validation authority",
    );
    expect(verify.if).toContain("strict_release == 'true'");
    expect(verify.run).toContain('operation: "internal-validation"');
    expect(verify.run).toContain("verify-release-operation.mjs");
    expect(verify.run).toContain('workflowPath: ".github/workflows/full-release-validation.yml"');
    expect(verify.run).toContain("targetRef: process.env.GITHUB_REF");
    expect(verify.run).toContain("releasePolicySha256");

    const upload = step(
      FULL_VALIDATION,
      "release_policy",
      "Upload strict internal validation verifier evidence",
    );
    expect(upload.with?.name).toBe(
      "release-operation-verifier-v1-internal-validation-${{ steps.verify.outputs.release_version }}-${{ github.run_id }}-${{ github.run_attempt }}",
    );
    expect(upload.with?.path).toBe("${{ runner.temp }}/openclaw-full-validation-verifier");

    const checks = job(FULL_VALIDATION, "release_checks");
    expect(checks.needs).toEqual([
      "resolve_target",
      "release_policy",
      "docker_runtime_assets_preflight",
    ]);
    const dispatch = step(FULL_VALIDATION, "release_checks", "Dispatch and monitor release checks");
    for (const descriptor of [
      'verifier_run_id="$VERIFIER_RUN_ID"',
      'verifier_run_attempt="$VERIFIER_RUN_ATTEMPT"',
      'verifier_artifact_name="$VERIFIER_ARTIFACT_NAME"',
      'verifier_payload_sha256="$VERIFIER_PAYLOAD_SHA256"',
    ]) {
      expect(dispatch.run).toContain(descriptor);
    }
  });

  it("writes v3 only for strict mode and sends the pinned public contract descriptor", () => {
    const manifest = step(FULL_VALIDATION, "summary", "Write release validation manifest");
    expect(manifest.run).toContain("version: (if $strictRelease then 3 else 2 end)");
    expect(manifest.run).toContain("releasePolicy: $releasePolicy");
    expect(manifest.run).toContain("releasePolicySha256: $releasePolicySha256");
    expect(manifest.run).toContain("strictTargetRef");

    const dispatch = step(FULL_VALIDATION, "summary", "Request release evidence update");
    for (const field of [
      "verifier_run_id",
      "verifier_run_attempt",
      "verifier_artifact_name",
      "verifier_payload_sha256",
      "external_contract_revision",
    ]) {
      expect(dispatch.run).toContain(`${field}: $${field}`);
    }
    expect(dispatch.run).toContain("https://api.github.com/repos/openclaw/releases/dispatches");
  });
});

describe("release verifier evidence consumers", () => {
  it("authenticates only parent internal-validation evidence in release checks", () => {
    const inputs = workflow(RELEASE_CHECKS).on?.workflow_dispatch?.inputs ?? {};
    for (const name of [
      "verifier_run_id",
      "verifier_run_attempt",
      "verifier_artifact_name",
      "verifier_payload_sha256",
    ]) {
      expect(inputs[name]).toMatchObject({ required: false, type: "string" });
    }

    const consumer = step(
      RELEASE_CHECKS,
      "resolve_target",
      "Authenticate parent internal-validation verifier evidence",
    );
    expect(consumer.run).toContain('.path == ".github/workflows/full-release-validation.yml"');
    expect(consumer.run).toContain('payload.operation !== "internal-validation"');
    expect(consumer.run).toContain("payload.execution.runId !== process.env.VERIFIER_RUN_ID");
    expect(consumer.run).toContain("payload.target.targetSha !== process.env.EXPECTED_SHA");
    expect(consumer.run).toContain("Expected exactly one unexpired verifier artifact");
    expect(consumer.run).toContain("Verifier payload digest mismatch");
    expect(consumer.run).toContain(
      "release-ci child execution requires authenticated parent verifier evidence",
    );
    expect(text(RELEASE_CHECKS)).not.toContain("verify-release-operation.mjs");
  });

  it("requires exact completed npm tag-preflight evidence before public macOS validation", () => {
    const inputs = workflow(MACOS_RELEASE).on?.workflow_dispatch?.inputs ?? {};
    expect(inputs.release_sha).toMatchObject({ required: true, type: "string" });
    for (const name of [
      "verifier_run_id",
      "verifier_run_attempt",
      "verifier_artifact_name",
      "verifier_payload_sha256",
    ]) {
      expect(inputs[name]).toMatchObject({ required: true, type: "string" });
    }

    const macos = job(MACOS_RELEASE, "validate_macos_release_request");
    expect(macos.permissions).toEqual({ actions: "read", contents: "read" });
    expect(macos.steps?.[0]?.name).toBe("Authenticate npm tag-preflight verifier evidence");
    const consumer = step(
      MACOS_RELEASE,
      "validate_macos_release_request",
      "Authenticate npm tag-preflight verifier evidence",
    );
    expect(consumer.run).toContain('.path == ".github/workflows/openclaw-npm-release.yml"');
    expect(consumer.run).toContain('.status == "completed"');
    expect(consumer.run).toContain('payload.operation !== "tag-preflight"');
    expect(consumer.run).toContain("payload.target.targetSha !== process.env.RELEASE_SHA");
    expect(consumer.run).toContain("payload.target.authorizedSourceRef !== expectedSourceRef");
    expect(consumer.run).toContain("^stable/[0-9]{4}\\.[1-9][0-9]*\\.33$");
    expect(consumer.run).not.toContain("^stable/[0-9]{4}\\.[1-9][0-9]*\\.[1-9][0-9]*$");
    expect(consumer.run).toContain("Verifier payload digest mismatch");
    expect(text(MACOS_RELEASE)).not.toContain("verify-release-operation.mjs");

    const checkout = step(MACOS_RELEASE, "validate_macos_release_request", "Checkout selected tag");
    expect(checkout.with?.ref).toBe("${{ inputs.release_sha }}");
    expect(
      step(
        MACOS_RELEASE,
        "validate_macos_release_request",
        "Verify release tag still resolves to authenticated SHA",
      ).run,
    ).toContain("Release tag moved after authenticated npm preflight evidence");
  });
});
