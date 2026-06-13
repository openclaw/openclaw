import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const WORKFLOW_PATH = ".github/workflows/build-runtime-image.yml";
const DOCKERFILE_PATH = "Dockerfile.multitenant";
const ROLLOUT_SCRIPT_PATH = "scripts/runtime-rollout.mjs";
const REMOVED_PASSWORD_ENV = ["API", "PASSWORD"].join("_");
const REMOVED_PASSWORD_SECRET = ["ROCKIELAB", REMOVED_PASSWORD_ENV].join("_");

type WorkflowStep = {
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
  const job = readWorkflow().jobs?.["rollout-tenants"];
  expect(job, "expected rollout-tenants job").toBeDefined();
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
  });

  it("exposes event-safe manual rollout inputs", () => {
    const workflow = readWorkflow();
    expect(workflow.on?.workflow_dispatch?.inputs).toMatchObject({
      rollout_tenant_id: expect.any(Object),
      rollout_canary_count: expect.any(Object),
      rollout_canary_wait_sec: expect.any(Object),
      rollout_wave_delay_sec: expect.any(Object),
      rollout_wave_size: expect.any(Object),
    });

    const job = rolloutJob();
    expect(job.env).toMatchObject({
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

    const rollout = workflowStep(rolloutJob(), "Roll every tenant to the new image SHA");
    const run = rollout.run ?? "";

    expect(run).toContain("node scripts/runtime-rollout.mjs");
    expect(run).toContain("rollout duration");
    expect(run).toContain("rollout exit code");
  });

  it("writes and uploads a rollout summary artifact with retry metadata", () => {
    const job = rolloutJob();
    expect(job.env).toMatchObject({
      FLY_API_TOKEN: "${{ secrets.FLY_API_TOKEN }}",
      GHCR_PULL_USERNAME: "${{ secrets.GHCR_PULL_USERNAME }}",
      GHCR_PULL_TOKEN: "${{ secrets.GHCR_PULL_TOKEN }}",
      IMAGE_TAG: "ghcr.io/rockielab/rockielab-runtime-multitenant:${{ github.sha }}",
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
      name: "runtime-rollout-summary-${{ github.sha }}",
      path: "${{ env.ROLLOUT_ARTIFACT_DIR }}",
      "if-no-files-found": "ignore",
    });
  });

  it("does not mention or require the removed password secret", () => {
    const workflow = readFileSync(WORKFLOW_PATH, "utf8");

    expect(workflow).not.toContain(REMOVED_PASSWORD_SECRET);
    expect(workflow).not.toContain(REMOVED_PASSWORD_ENV);
    expect(workflow).toContain("ROCKIELAB_ADMIN_TOKEN: sent as X-Admin-Token");
    expect(workflow).toContain(
      "FLY_API_TOKEN: used to enumerate tenant Fly apps for per-tenant fallback",
    );
    expect(workflow).toContain(
      "GHCR_PULL_TOKEN: optional preflight token for private runtime image pulls",
    );
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
