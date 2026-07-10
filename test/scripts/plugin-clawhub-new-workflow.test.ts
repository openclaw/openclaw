import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type Step = {
  env?: Record<string, string>;
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, boolean | string>;
};

type Job = {
  environment?: string;
  if?: string;
  outputs?: Record<string, string>;
  permissions?: Record<string, string>;
  steps?: Step[];
  "timeout-minutes"?: number;
};

type Workflow = {
  jobs?: Record<string, Job>;
  on?: {
    workflow_dispatch?: {
      inputs?: Record<string, { required?: boolean }>;
    };
  };
};

const source = readFileSync(".github/workflows/plugin-clawhub-new.yml", "utf8");
const workflow = parse(source) as Workflow;
const jobs = workflow.jobs ?? {};
const materializerSource = readFileSync("scripts/materialize-clawhub-cli.sh", "utf8");
const clawhubCliPackage = JSON.parse(
  readFileSync(".github/release/clawhub-cli/package.json", "utf8"),
) as { dependencies?: Record<string, string> };
const clawhubCliLock = JSON.parse(
  readFileSync(".github/release/clawhub-cli/package-lock.json", "utf8"),
) as {
  packages?: Record<string, { integrity?: string; version?: string }>;
};

function job(name: string): Job {
  const value = jobs[name];
  expect(value, `missing ${name}`).toBeDefined();
  return value ?? {};
}

function step(jobValue: Job, name: string): Step {
  const value = jobValue.steps?.find((entry) => entry.name === name);
  expect(value, `missing step ${name}`).toBeDefined();
  return value ?? {};
}

describe("Plugin ClawHub New workflow", () => {
  it("binds trusted-main workflow code to an exact release target SHA", () => {
    for (const input of [
      "ref",
      "release_tag",
      "release_publish_run_id",
      "release_publish_run_attempt",
      "release_publish_branch",
    ]) {
      expect(workflow.on?.workflow_dispatch?.inputs?.[input]?.required, input).toBe(true);
    }
    const resolve = job("resolve_bootstrap_plan");
    const checkout = step(resolve, "Checkout");
    expect(checkout.with?.ref).toBe("${{ github.sha }}");
    const guard = step(resolve, "Require trusted main workflow source").run ?? "";
    expect(guard).toContain('WORKFLOW_REF}" == "refs/heads/main"');
    const target = step(resolve, "Resolve checked-out ref").run ?? "";
    expect(target).toContain('[[ "${TARGET_REF}" =~ ^[a-f0-9]{40}$ ]]');
    expect(target).toContain('git rev-parse "${RELEASE_TAG}^{commit}"');
    expect(target).toContain(
      "Plugin ClawHub bootstrap target ${TARGET_REF} does not match ${RELEASE_TAG} (${tag_sha}).",
    );
    expect(source).not.toContain("refs/remotes/origin/release");
  });

  it("requires an exact attested parent tuple even for dry-run validation", () => {
    const approval = job("validate_release_publish_approval");
    expect(approval.if).not.toContain("inputs.dry_run != true");
    expect(approval.permissions).toEqual({
      actions: "read",
      attestations: "read",
      contents: "read",
    });
    expect(step(approval, "Download parent ClawHub bootstrap approval").with).toMatchObject({
      name: "clawhub-bootstrap-approval-${{ inputs.release_publish_run_id }}-${{ inputs.release_publish_run_attempt }}",
      "run-id": "${{ inputs.release_publish_run_id }}",
    });
    const validation = step(approval, "Validate release publish approval run");
    expect(validation.env).toMatchObject({
      RELEASE_APPROVAL_KIND: "clawhub-bootstrap",
      RELEASE_PACKAGES: "${{ inputs.plugins }}",
      RELEASE_TAG: "${{ inputs.release_tag }}",
      RELEASE_TARGET_SHA: "${{ needs.resolve_bootstrap_plan.outputs.ref_revision }}",
    });
    expect(validation.run).toContain("gh attestation verify");
    expect(validation.run).toContain(
      "actions/runs/${RELEASE_PUBLISH_RUN_ID}/attempts/${EXPECTED_RUN_ATTEMPT}",
    );
    expect(validation.run).toContain('--source-digest "${EXPECTED_WORKFLOW_SHA}"');
  });

  it("packs target code only in the secretless producer", () => {
    const pack = job("pack_bootstrap_plugins");
    expect(pack.environment).toBeUndefined();
    expect(pack.permissions).toEqual({ actions: "read", contents: "read" });
    const serialized = JSON.stringify(pack);
    expect(serialized).not.toContain("secrets.");
    expect(pack.outputs).toMatchObject({
      artifact_digest: "${{ steps.upload.outputs.artifact-digest }}",
      artifact_id: "${{ steps.upload.outputs.artifact-id }}",
      artifact_name: "${{ steps.artifact.outputs.name }}",
      artifact_run_attempt: "${{ github.run_attempt }}",
      artifact_run_id: "${{ github.run_id }}",
      artifact_size: "${{ steps.upload_binding.outputs.size }}",
      clawhub_toolchain_sha256: "${{ steps.clawhub_cli.outputs.lock_sha256 }}",
    });
    expect(step(pack, "Upload immutable ClawHub bootstrap artifact").with).toMatchObject({
      archive: true,
      name: "${{ steps.artifact.outputs.name }}",
      path: "${{ runner.temp }}/clawhub-bootstrap-artifact",
    });
    const packRun = step(pack, "Pack immutable ClawHub bootstrap artifacts").run ?? "";
    expect(packRun).not.toContain('mode}" == "configure-only"');
    expect(packRun).toContain("bash .release-harness/scripts/plugin-clawhub-publish.sh --pack");
    expect(packRun).not.toContain("bash scripts/plugin-clawhub-publish.sh --pack");
    expect(packRun).toContain("--validate-packed");
    expect(packRun).toContain("--clawhub-toolchain-integrity");
    expect(packRun).toContain("--clawhub-toolchain-sha256");
    expect(packRun).toContain("--clawhub-toolchain-version");
  });

  it("always validates the immutable handoff without credentials, including dry runs", () => {
    const validate = job("validate_bootstrap_artifact");
    expect(validate.environment).toBeUndefined();
    expect(validate.permissions).toEqual({ actions: "read", contents: "read" });
    expect(validate.if).not.toContain("inputs.dry_run != true");
    expect(JSON.stringify(validate)).not.toContain("secrets.");
    expect(validate["timeout-minutes"]).toBe(45);
    const binding =
      step(validate, "Download and verify immutable ClawHub bootstrap artifact").run ?? "";
    expect(binding).toContain("clawhub-bootstrap-artifact.mjs download");
    expect(binding).toContain('--artifact-size "${ARTIFACT_SIZE}"');
    expect(binding).toContain('--run-attempt "${ARTIFACT_RUN_ATTEMPT}"');
    expect(binding).toContain("--clawhub-toolchain-integrity");
    expect(binding).toContain("--clawhub-toolchain-sha256");
    expect(binding).toContain("--clawhub-toolchain-version");
    expect(step(validate, "Validate packed ClawHub package identities").run).toContain(
      "--validate-packed",
    );
    expect(step(validate, "Require configure-only registry bytes to match target").run).toContain(
      "--mode configure-only-preflight",
    );
    expect(step(validate, "Require configure-only registry bytes to match target").run).toContain(
      '--terminal-run-attempt "${GITHUB_RUN_ATTEMPT}"',
    );
    expect(step(validate, "Upload immutable bootstrap validation evidence").with?.name).toBe(
      "clawhub-bootstrap-validation-${{ github.run_id }}-${{ github.run_attempt }}",
    );
  });

  it("uses a fresh trusted-main credential job after immutable validation", () => {
    const publish = job("publish_bootstrap_plugins");
    expect(publish.environment).toBe("clawhub-plugin-bootstrap");
    expect(publish.permissions).toEqual({ actions: "read", contents: "read" });
    expect(publish.if).toContain("inputs.dry_run != true");
    expect(publish.if).toContain("needs.validate_bootstrap_artifact.result == 'success'");
    expect(publish["timeout-minutes"]).toBe(120);

    const checkout = step(publish, "Checkout trusted workflow tooling");
    expect(checkout.with).toMatchObject({
      ref: "${{ github.sha }}",
      path: ".release-harness",
      "persist-credentials": false,
    });
    const uses = (publish.steps ?? []).flatMap((entry) => (entry.uses ? [entry.uses] : []));
    expect(uses).toEqual([
      "actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10",
      "actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e",
      "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
    ]);

    const binding =
      step(publish, "Download and verify immutable ClawHub bootstrap artifact").run ?? "";
    expect(binding).toContain("clawhub-bootstrap-artifact.mjs download");
    expect(binding).toContain('--artifact-size "${ARTIFACT_SIZE}"');
    expect(binding).toContain('--run-attempt "${ARTIFACT_RUN_ATTEMPT}"');
    expect(binding).toContain("--clawhub-toolchain-integrity");
    expect(binding).toContain("--clawhub-toolchain-sha256");
    expect(binding).toContain("--clawhub-toolchain-version");
  });

  it("rehashes and validates tgz identity before exposing the token", () => {
    const publish = job("publish_bootstrap_plugins");
    const names = (publish.steps ?? []).map((entry) => entry.name);
    expect(names.indexOf("Rehash immutable ClawHub bootstrap artifacts")).toBeLessThan(
      names.indexOf("Write ClawHub token config"),
    );
    expect(
      names.indexOf("Validate packed ClawHub package identities before credentials"),
    ).toBeLessThan(names.indexOf("Write ClawHub token config"));
    expect(names.indexOf("Materialize locked ClawHub CLI")).toBeLessThan(
      names.indexOf("Write ClawHub token config"),
    );
    expect(
      names.indexOf("Reconfirm configure-only registry bytes before credentials"),
    ).toBeLessThan(names.indexOf("Write ClawHub token config"));
    expect(step(publish, "Rehash immutable ClawHub bootstrap artifacts").run).toContain(
      ".release-harness/scripts/lib/clawhub-bootstrap-artifact.mjs verify",
    );
    expect(
      step(publish, "Validate packed ClawHub package identities before credentials").run,
    ).toContain("--validate-packed");
    expect(step(publish, "Publish exact ClawHub bootstrap artifacts").run).toContain(
      "--publish-packed",
    );
  });

  it("preserves configure-only repair and exact registry byte readback", () => {
    const publish = job("publish_bootstrap_plugins");
    const publishRun = step(publish, "Publish exact ClawHub bootstrap artifacts").run ?? "";
    expect(publishRun).toContain('mode}" == "publish"');
    expect(publishRun).toContain("GitHub Actions immutable bootstrap retry");
    expect(publishRun).toContain("GitHub Actions trusted publisher repair before OIDC migration");
    expect(publishRun).toContain('"${OPENCLAW_CLAWHUB_CLI}" package trusted-publisher set');
    expect(publishRun).toContain("timeout --signal=TERM --kill-after=10s 300s");
    expect(publishRun).toContain("--repository openclaw/openclaw");
    expect(publishRun).toContain("--workflow-filename plugin-clawhub-release.yml");
    expect(publishRun).not.toContain("--environment");
    expect(step(publish, "Verify exact ClawHub registry artifact bytes").run).toContain(
      ".release-harness/scripts/verify-clawhub-published-artifact.mjs",
    );
    expect(step(publish, "Verify exact ClawHub registry artifact bytes").run).toContain(
      '--terminal-run-attempt "${GITHUB_RUN_ATTEMPT}"',
    );
    expect(step(publish, "Upload ClawHub bootstrap readback evidence").with?.name).toBe(
      "clawhub-bootstrap-readback-${{ github.run_id }}-${{ github.run_attempt }}",
    );
    expect(
      step(publish, "Reconfirm configure-only registry bytes before credentials").run,
    ).toContain("--mode configure-only-preflight");
  });

  it("uses one lockfile-only ClawHub CLI graph and absolute binary path", () => {
    expect(clawhubCliPackage.dependencies).toEqual({ clawhub: "0.23.1" });
    expect(clawhubCliLock.packages?.["node_modules/clawhub"]).toMatchObject({
      integrity:
        "sha512-YvUImhsVaM90BUAv3uP7lfABziwR5XL3ch2Owa+GvNxwQ2xzZFmZC0yVjAtQbvep+dDDS16nUGRwKx7jqnTOEA==",
      version: "0.23.1",
    });
    expect(materializerSource).toContain("npm ci");
    expect(materializerSource).toContain("--ignore-scripts");
    expect(materializerSource).toContain("--omit=dev");
    expect(materializerSource).toContain(
      "f44f670d70f13a8cde566a174cae5be682ad98456ec7a85aafd497f7d8c71816",
    );
    expect(materializerSource).toContain("lock_sha256=");
    expect(materializerSource).toContain("integrity=${clawhub_integrity}");
    expect(materializerSource).toContain("cli=${clawhub_cli}");
    expect(source).not.toContain("npm exec");
    expect(source).not.toContain("npm install");
    expect(source).not.toContain("CLAWHUB_CLI_PACKAGE");
    expect(source).toContain("OPENCLAW_CLAWHUB_CLI: ${{ steps.clawhub_cli.outputs.cli }}");
    expect(source).toContain('"${OPENCLAW_CLAWHUB_CLI}" package trusted-publisher set');
  });

  it("bounds every job and keeps secretless validation active in dry-run mode", () => {
    expect(job("resolve_bootstrap_plan")["timeout-minutes"]).toBe(30);
    expect(job("validate_release_publish_approval")["timeout-minutes"]).toBe(20);
    expect(job("validate_bootstrap_trusted_publisher_cli")["timeout-minutes"]).toBe(10);
    expect(job("validate_bootstrap_trusted_publisher_cli").if).not.toContain(
      "inputs.dry_run != true",
    );
    expect(job("validate_release_publish_approval").if).not.toContain("inputs.dry_run != true");
    expect(job("pack_bootstrap_plugins")["timeout-minutes"]).toBe(60);
  });
});
