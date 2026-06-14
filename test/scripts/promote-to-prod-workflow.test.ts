import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const WORKFLOW_PATH = ".github/workflows/promote-to-prod.yml";

describe("promote-to-prod workflow", () => {
  it("gates prod promotion and keeps dry-run read-only", () => {
    const text = readFileSync(WORKFLOW_PATH, "utf8");
    const workflow = parse(text) as any;
    const job = workflow.jobs.promote;

    expect(workflow.on.workflow_dispatch.inputs).toMatchObject({
      image_sha: expect.any(Object),
      platform_skills_sha: expect.any(Object),
      dry_run: expect.any(Object),
    });
    expect(job.environment).toBe("production");
    expect(job.env).toMatchObject({
      API_URL: "${{ secrets.ROCKIELAB_PROD_API_URL || secrets.ROCKIELAB_API_URL }}",
      ADMIN_TOKEN: "${{ secrets.ROCKIELAB_PROD_ADMIN_TOKEN || secrets.ROCKIELAB_ADMIN_TOKEN }}",
      IMAGE_SHA: "${{ inputs.image_sha }}",
      ROLLOUT_ENV: "prod",
    });
    expect(text).toContain("Verify prod catalog availability for dry-run");
    expect(text).toContain("dry_run=true");
    expect(text).toContain(
      "Dry-run: verified prod catalog availability/current/proposed SHA without rsync",
    );
    expect(text).toContain("if: ${{ !inputs.dry_run }}");
    expect(text).toContain("sync-skills-to-hetzner.yml");
    expect(text).toContain("node scripts/runtime-rollout.mjs");
  });

  it("verifies the promoted image exists and matches the requested skills SHA before prod actions", () => {
    const text = readFileSync(WORKFLOW_PATH, "utf8");
    const workflow = parse(text) as any;
    const steps = workflow.jobs.promote.steps;
    const imageVerifyIndex = steps.findIndex(
      (step: any) =>
        step.name === "Verify promoted image exists and is bound to platform-skills SHA",
    );
    const dryRunIndex = steps.findIndex((step: any) => step.name === "Prod dry-run is read-only");
    const healthIndex = steps.findIndex(
      (step: any) => step.name === "Preflight prod API environment before catalog actions",
    );
    const dryRunCatalogIndex = steps.findIndex(
      (step: any) => step.name === "Verify prod catalog availability for dry-run",
    );
    const syncIndex = steps.findIndex(
      (step: any) => step.name === "Sync prod catalog for real promotion",
    );
    const rolloutIndex = steps.findIndex(
      (step: any) => step.name === "Verify and promote prod tenants",
    );

    expect(imageVerifyIndex).toBeGreaterThan(-1);
    expect(imageVerifyIndex).toBeLessThan(dryRunIndex);
    expect(imageVerifyIndex).toBeLessThan(healthIndex);
    expect(healthIndex).toBeLessThan(dryRunCatalogIndex);
    expect(healthIndex).toBeLessThan(syncIndex);
    expect(imageVerifyIndex).toBeLessThan(syncIndex);
    expect(imageVerifyIndex).toBeLessThan(rolloutIndex);
    expect(syncIndex).toBeLessThan(rolloutIndex);

    const run = steps[imageVerifyIndex].run;
    expect(run).toContain('docker pull --platform linux/amd64 "$IMAGE_TAG"');
    expect(run).toContain('docker image inspect "$IMAGE_TAG"');
    expect(run).toContain("rockielab.platform_skills_sha");
    expect(run).toContain('[ "$bound_sha" != "$PLATFORM_SKILLS_SHA" ]');
    expect(run).toContain("exit 1");

    const healthRun = steps[healthIndex].run;
    expect(healthRun).toContain("${API_URL%/}/health");
    expect(healthRun).toContain("X-Rockielab-Env");
    expect(healthRun).toContain("expected prod");
  });

  it("tracks exact catalog verification and sync workflow runs by request id", () => {
    const workflow = parse(readFileSync(WORKFLOW_PATH, "utf8")) as any;
    const steps = workflow.jobs.promote.steps;
    const dryRunCatalog = steps.find(
      (step: any) => step.name === "Verify prod catalog availability for dry-run",
    );
    const realSync = steps.find(
      (step: any) => step.name === "Sync prod catalog for real promotion",
    );

    expect(dryRunCatalog.run).toContain(
      'request_id="promote-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-prod-dry-run"',
    );
    expect(dryRunCatalog.run).toContain("displayTitle == env.EXPECTED_TITLE");
    expect(dryRunCatalog.run).toContain(".databaseId as $candidate_run_id");
    expect(dryRunCatalog.run).toContain("index($candidate_run_id)");
    expect(dryRunCatalog.run).not.toContain("index(.databaseId)");
    expect(dryRunCatalog.run).toContain('grep -Fx "$expected_title"');
    expect(dryRunCatalog.run).toContain("dry_run=true");

    expect(realSync.run).toContain(
      'request_id="promote-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-prod"',
    );
    expect(realSync.run).toContain("displayTitle == env.EXPECTED_TITLE");
    expect(realSync.run).toContain(".databaseId as $candidate_run_id");
    expect(realSync.run).toContain("index($candidate_run_id)");
    expect(realSync.run).not.toContain("index(.databaseId)");
    expect(realSync.run).toContain('grep -Fx "$expected_title"');
    expect(realSync.run).toContain("dry_run=false");
  });
});
