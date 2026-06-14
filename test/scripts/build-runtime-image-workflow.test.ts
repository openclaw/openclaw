import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const WORKFLOW_PATH = ".github/workflows/build-runtime-image.yml";
const DOCKERFILE_PATH = "Dockerfile.multitenant";
const ROLLOUT_SCRIPT_PATH = "scripts/runtime-rollout.mjs";
const REMOVED_PASSWORD_ENV = ["API", "PASSWORD"].join("_");
const REMOVED_PASSWORD_SECRET = ["ROCKIELAB", REMOVED_PASSWORD_ENV].join("_");

type WorkflowStep = {
  env?: Record<string, string>;
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, string>;
};

type WorkflowJob = {
  env?: Record<string, string>;
  permissions?: Record<string, string>;
  steps?: WorkflowStep[];
};

type Workflow = {
  concurrency?: Record<string, unknown>;
  jobs?: Record<string, WorkflowJob>;
  on?: {
    workflow_dispatch?: {
      inputs?: Record<string, unknown>;
    };
  };
};

function readWorkflow(): Workflow {
  return parse(readFileSync(WORKFLOW_PATH, "utf8")) as Workflow;
}

function rolloutJob(): WorkflowJob {
  const job = readWorkflow().jobs?.["rollout-dev"];
  expect(job, "expected rollout-dev job").toBeDefined();
  return job!;
}

function workflowStep(job: WorkflowJob, stepName: string): WorkflowStep {
  const step = job.steps?.find((candidate) => candidate.name === stepName);
  expect(step, `expected workflow step ${stepName}`).toBeDefined();
  return step!;
}

describe("build-runtime-image rollout workflow", () => {
  it("keeps broker-only edits out of the expensive OpenClaw/UI build copy", () => {
    const dockerfile = readFileSync(DOCKERFILE_PATH, "utf8");

    expect(dockerfile).toContain("# syntax=docker/dockerfile:1.19");
    expect(dockerfile).toContain("COPY --exclude=apps/broker --exclude=apps/broker/** . .");
    expect(dockerfile).toContain("COPY apps/broker/go.mod apps/broker/go.sum ./");
    expect(dockerfile).toContain("COPY apps/broker/ ./");
  });

  it("cancels superseded image builds and avoids unnecessary QEMU setup", () => {
    const workflow = readWorkflow();
    expect(workflow.concurrency).toMatchObject({
      group: "build-runtime-image",
      "cancel-in-progress": true,
    });

    const text = readFileSync(WORKFLOW_PATH, "utf8");
    expect(text).not.toContain("docker/setup-qemu-action");
    expect(text).toContain("Start setup timer");
    expect(text).toContain("Start build timer");
    expect(text).toContain("setup duration");
    expect(text).toContain("build+push duration");
    expect(text).toContain("queue metadata");
    expect(text).toContain("registry.fly.io/rockielab-runtime-multitenant");
  });

  it("exposes event-safe manual rollout inputs", () => {
    const workflow = readWorkflow();
    expect(workflow.on?.workflow_dispatch?.inputs).toMatchObject({
      rollout_tenant_id: expect.any(Object),
      skills_ref: expect.any(Object),
      rollout_target: expect.objectContaining({ default: "full-fleet" }),
      rollout_canary_count: expect.any(Object),
      rollout_canary_wait_sec: expect.any(Object),
      rollout_wave_delay_sec: expect.any(Object),
      rollout_wave_size: expect.any(Object),
    });

    const job = rolloutJob();
    expect(job.env).toMatchObject({
      ROLLOUT_ENV: "dev",
      ROLLOUT_TENANT_ID:
        "${{ github.event_name == 'workflow_dispatch' && inputs.rollout_tenant_id || '' }}",
      ROLLOUT_CANARY_COUNT:
        "${{ github.event_name == 'workflow_dispatch' && inputs.rollout_canary_count || '' }}",
      ROLLOUT_CANARY_WAIT_SEC:
        "${{ github.event_name == 'workflow_dispatch' && inputs.rollout_canary_wait_sec || '' }}",
      ROLLOUT_WAVE_DELAY_SEC:
        "${{ github.event_name == 'workflow_dispatch' && inputs.rollout_wave_delay_sec || '' }}",
      ROLLOUT_WAVE_SIZE:
        "${{ github.event_name == 'workflow_dispatch' && inputs.rollout_wave_size || '' }}",
    });
  });

  it("delegates rollout to the tested runtime rollout script", () => {
    const job = rolloutJob();
    expect(job.permissions).toMatchObject({
      actions: "read",
      contents: "read",
    });

    const checkout = workflowStep(job, "Checkout rollout script");
    expect(checkout.if).toBe("steps.preflight.outputs.skipped == 'false'");

    const rollout = workflowStep(rolloutJob(), "Roll dev tenants to the new image SHA");
    const run = rollout.run ?? "";

    expect(run).toContain("node scripts/runtime-rollout.mjs");
    expect(run).toContain("rollout duration");
    expect(run).toContain("rollout exit code");
  });

  it("bounds runtime image platform proof commands with timeout errors", () => {
    const step = workflowStep(
      readWorkflow().jobs?.build ?? {},
      "Record runtime image platform proof",
    );
    const run = step.run ?? "";

    for (const expected of [
      "run_with_timeout()",
      'timeout --kill-after=15s "${seconds}s" "$@"',
      'echo "::error::${label} timed out after ${seconds}s" >&2',
      'echo "::error::${label} failed with exit code ${status}" >&2',
      "trap 'status=$?; trap - ERR;",
      '{ echo "::group::runtime image platform proof (partial)"; cat "$proof_file"; echo "::endgroup::"; } >&2',
      'run_with_timeout "docker rm runtime image proof container" 30 docker rm -f "$container_id" >/dev/null 2>&1 || true',
      'docker_server="$(run_with_timeout "docker version" 30 docker version --format \'{{.Server.Version}}\')"',
      'buildx_version="$(run_with_timeout "docker buildx version" 30 docker buildx version)"',
      'run_with_timeout "docker buildx imagetools inspect" 120 docker buildx imagetools inspect "$RUNTIME_IMAGE_REF"',
      'container_id="$(run_with_timeout "docker create runtime image" 120 docker create --platform "$TARGET_PLATFORM" "$RUNTIME_IMAGE_REF")"',
      'run_with_timeout "docker cp broker binary" 60 docker cp "$container_id:/usr/local/bin/broker" "$proof_dir/broker"',
      'run_with_timeout "file broker binary" 30 file "$proof_dir/broker"',
      'run_with_timeout "shasum broker binary" 30 shasum -a 256 "$proof_dir/broker"',
    ]) {
      expect(run).toContain(expected);
    }
    expect(run).not.toContain('echo "docker_server=$(docker version');
    expect(run).not.toContain('echo "buildx_version=$(docker buildx version)"');

    const upload = workflowStep(
      readWorkflow().jobs?.build ?? {},
      "Upload runtime image platform proof",
    );
    expect(upload.if).toBe("always()");
    expect(upload.uses).toBe("actions/upload-artifact@v4");
    expect(upload.with).toMatchObject({
      name: "runtime-image-platform-proof",
      path: ".artifacts/runtime-image-platform/broker-platform-proof.txt",
      "if-no-files-found": "ignore",
    });
  });

  it("writes and uploads a rollout summary artifact with retry metadata", () => {
    const job = rolloutJob();
    expect(job.env).toMatchObject({
      FLY_API_TOKEN: "${{ secrets.FLY_API_TOKEN }}",
      GHCR_PULL_USERNAME: "${{ secrets.GHCR_PULL_USERNAME }}",
      GHCR_PULL_TOKEN: "${{ secrets.GHCR_PULL_TOKEN }}",
      IMAGE_TAG: "${{ needs.build.outputs.image_ref }}",
      ROLLOUT_ARTIFACT_DIR: ".artifacts/runtime-rollout",
      ROLLOUT_MAX_ATTEMPTS: "5",
      ROLLOUT_FALLBACK_AFTER_TRANSIENTS: "2",
    });
    expect(job.env).not.toHaveProperty(REMOVED_PASSWORD_ENV);

    const run = readFileSync(ROLLOUT_SCRIPT_PATH, "utf8");
    expect(run).toContain("rollout-summary.md");
    expect(run).toContain("preflightGhcrImagePull");
    expect(run).toContain("rollout-summary.json");
    expect(run).toContain("attempts.jsonl");
    expect(run).toContain("response_codes");
    expect(run).toContain("retry_count");
    expect(run).toContain("final_result");
    expect(run).toContain("duration_ms");
    expect(run).toContain("scoped_rollout");
    expect(run).toContain("image_sha");
    expect(run).toContain("buckets");
    expect(run).toContain("updated");
    expect(run).toContain("skipped");
    expect(run).toContain("failed");
    expect(run).toContain("total");

    const upload = workflowStep(job, "Upload rollout summary artifact");
    expect(upload.if).toBe("always()");
    expect(upload.uses).toBe("actions/upload-artifact@v4");
    expect(upload.with).toMatchObject({
      name: "runtime-rollout-dev-summary-${{ github.sha }}",
      path: "${{ env.ROLLOUT_ARTIFACT_DIR }}",
      "if-no-files-found": "ignore",
    });
  });

  it("does not mention or require the removed password secret", () => {
    const workflow = readFileSync(WORKFLOW_PATH, "utf8");

    expect(workflow).not.toContain(REMOVED_PASSWORD_SECRET);
    expect(workflow).not.toContain(REMOVED_PASSWORD_ENV);
    expect(workflow).toContain("ROCKIELAB_DEV_ADMIN_TOKEN: sent as X-Admin-Token");
    expect(workflow).toContain(
      "FLY_API_TOKEN: used to enumerate tenant Fly apps for per-tenant fallback",
    );
    expect(workflow).toContain(
      "GHCR_PULL_TOKEN: optional preflight token for private runtime image pulls",
    );
  });

  it("uses dispatched or manual platform-skills refs and removes stale dispatch-deploy", () => {
    const workflow = readWorkflow();
    expect(workflow.jobs).not.toHaveProperty("dispatch-deploy");

    const checkout = workflowStep(
      workflow.jobs?.build ?? {},
      "Checkout platform-skills (vendored at build time)",
    );
    expect(checkout.with?.ref).toContain("github.event.client_payload.sha");
    expect(checkout.with?.ref).toContain("inputs.skills_ref");

    const buildPush = workflowStep(workflow.jobs?.build ?? {}, "Build and push");
    expect(buildPush.with?.labels).toContain("rockielab.platform_skills_sha");
    expect(workflow.jobs?.["rollout-prod"]).toMatchObject({
      environment: "production",
    });
  });

  it("syncs the dev catalog before manual dev rollout and fails activated missing dev secrets", () => {
    const job = rolloutJob();
    expect(job.env).toMatchObject({
      DEPLOY_SPLIT_ACTIVATED: "${{ vars.DEPLOY_SPLIT_ACTIVATED }}",
    });

    const preflight = workflowStep(job, "Preflight — required secrets present");
    expect(preflight.run).toContain('[ "$DEPLOY_SPLIT_ACTIVATED" = "true" ]');
    expect(preflight.run).toContain("Activated dev rollout requires fixed dev secrets");
    expect(preflight.run).toContain("exit 1");

    const sync = workflowStep(job, "Sync dev catalog to bound platform-skills SHA");
    expect(sync.if).toBe(
      "${{ steps.preflight.outputs.skipped == 'false' && github.event_name == 'workflow_dispatch' }}",
    );
    expect(sync.env).toMatchObject({
      GH_TOKEN: "${{ secrets.PLATFORM_CONTEXT_DISPATCH_TOKEN }}",
      SKILLS_SHA: "${{ needs.build.outputs.platform_skills_sha }}",
    });
    expect(sync.run).toContain("target_env=dev");
    expect(sync.run).toContain('skills_sha="$SKILLS_SHA"');
    expect(sync.run).toContain("dry_run=false");
    expect(sync.run).toContain('request_id="runtime-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-dev"');
    expect(sync.run).toContain("displayTitle == env.EXPECTED_TITLE");
    expect(sync.run).toContain('grep -Fx "$expected_title"');
    expect(sync.run).toContain("gh run watch");

    const checkoutIndex = job.steps!.findIndex((step) => step.name === "Checkout rollout script");
    const syncIndex = job.steps!.findIndex(
      (step) => step.name === "Sync dev catalog to bound platform-skills SHA",
    );
    expect(syncIndex).toBeGreaterThan(-1);
    expect(syncIndex).toBeLessThan(checkoutIndex);
  });

  it("does not let scoped manual rollout inputs trigger prod full-fleet", () => {
    const prod = readWorkflow().jobs?.["rollout-prod"];
    expect(prod?.if).toContain("inputs.skills_ref == ''");
    expect(prod?.if).toContain("inputs.rollout_target == 'full-fleet'");
    expect(prod?.if).toContain("inputs.rollout_tenant_id == ''");
    expect(prod?.if).toContain("inputs.rollout_canary_count == ''");
    expect(prod?.if).toContain("inputs.rollout_canary_wait_sec == ''");
    expect(prod?.if).toContain("inputs.rollout_wave_delay_sec == ''");
    expect(prod?.if).toContain("inputs.rollout_wave_size == ''");
  });

  it("preflights prod API health before prod catalog mutation and verifies exact sync run", () => {
    const prod = readWorkflow().jobs?.["rollout-prod"];
    expect(prod, "expected rollout-prod job").toBeDefined();
    const healthIndex = prod!.steps!.findIndex(
      (step) => step.name === "Preflight prod API environment before catalog sync",
    );
    const syncIndex = prod!.steps!.findIndex(
      (step) => step.name === "Sync prod catalog to bound platform-skills SHA",
    );
    const rolloutIndex = prod!.steps!.findIndex(
      (step) => step.name === "Roll prod tenants to the new image SHA",
    );

    expect(healthIndex).toBeGreaterThan(-1);
    expect(syncIndex).toBeGreaterThan(healthIndex);
    expect(rolloutIndex).toBeGreaterThan(syncIndex);

    const health = prod!.steps![healthIndex].run ?? "";
    expect(health).toContain("${API_URL%/}/health");
    expect(health).toContain("X-Rockielab-Env");
    expect(health).toContain("expected prod");

    const sync = prod!.steps![syncIndex].run ?? "";
    expect(sync).toContain('request_id="runtime-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-prod"');
    expect(sync).toContain("displayTitle == env.EXPECTED_TITLE");
    expect(sync).toContain('grep -Fx "$expected_title"');
    expect(sync).toContain("dry_run=false");
  });

  it("pushes a Fly registry image for tenant rollout without making GHCR public", () => {
    const workflow = readWorkflow();
    const build = workflow.jobs?.build;
    expect(build, "expected build job").toBeDefined();
    expect(build!.env).toMatchObject({
      GHCR_IMAGE: "ghcr.io/rockielab/rockielab-runtime-multitenant",
      FLY_IMAGE: "registry.fly.io/rockielab-runtime-multitenant",
      FLY_API_TOKEN: "${{ secrets.FLY_API_TOKEN }}",
    });

    const flyPreflight = workflowStep(build!, "Preflight — require FLY_API_TOKEN");
    expect(flyPreflight.if).toBe("env.FLY_API_TOKEN == ''");

    const flyLogin = workflowStep(build!, "Log in to Fly registry");
    expect(flyLogin.uses).toBe("docker/login-action@v3");
    expect(flyLogin.with).toMatchObject({
      registry: "registry.fly.io",
      username: "x",
      password: "${{ secrets.FLY_API_TOKEN }}",
    });

    const buildPush = workflowStep(build!, "Build and push");
    expect(buildPush.with?.tags).toContain("${{ env.GHCR_IMAGE }}:${{ github.sha }}");
    expect(buildPush.with?.tags).toContain("${{ env.FLY_IMAGE }}:${{ github.sha }}");

    const record = workflowStep(build!, "Record pushed image ref");
    expect(record.run).toContain('image_ref="${{ env.FLY_IMAGE }}:${{ github.sha }}"');
  });

  it("falls back after Cloudflare 524s through per-tenant admin rollout", () => {
    const run = readFileSync(ROLLOUT_SCRIPT_PATH, "utf8");

    expect(run).toContain("response_body");
    expect(run).toContain("succeeded-via-per-tenant-fallback");
    expect(run).toContain("superseded-by-newer-build");
    expect(run).toContain("fly-app-list-plus-admin-tenant-rollout");
    expect(run).toContain("adminTenantFallbackUrl");
    expect(run).toContain("confirm=true");
    expect(run).toContain("async=false");
  });
});
