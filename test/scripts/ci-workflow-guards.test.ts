import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

function readCiWorkflow() {
  return parse(readFileSync(".github/workflows/ci.yml", "utf8"));
}

describe("ci workflow guards", () => {
  it("kills timed manual checkout fetches after the grace period", () => {
    const workflowPaths = [
      ".github/workflows/ci.yml",
      ".github/workflows/ci-check-testbox.yml",
      ".github/workflows/ci-build-artifacts-testbox.yml",
    ];

    for (const workflowPath of workflowPaths) {
      const workflow = readFileSync(workflowPath, "utf8");
      const fetchTimeouts = workflow.match(/timeout --signal=TERM[^\n]* 30s git -C "\$workdir"/g);

      expect(fetchTimeouts?.length, workflowPath).toBeGreaterThan(0);
      expect(fetchTimeouts, workflowPath).toEqual(
        fetchTimeouts?.map(() => 'timeout --signal=TERM --kill-after=10s 30s git -C "$workdir"'),
      );
    }
  });

  it("runs dependency policy guards in PR CI preflight", () => {
    const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
    const preflightGuards = workflow.slice(
      workflow.indexOf("guards)"),
      workflow.indexOf("prod-types)"),
    );

    expect(workflow).toContain("check-guards");
    expect(preflightGuards).toContain("pnpm deps:shrinkwrap:check");
    expect(preflightGuards).toContain("pnpm deps:patches:check");
  });

  it("does not rebuild Control UI after build:ci-artifacts", () => {
    const workflow = readCiWorkflow();
    const buildArtifactSteps = workflow.jobs["build-artifacts"].steps;
    const buildDistStep = buildArtifactSteps.find((step) => step.name === "Build dist");

    expect(buildDistStep.run).toBe("pnpm build:ci-artifacts");
    expect(buildArtifactSteps.map((step) => step.name)).not.toContain("Build Control UI");
    expect(buildArtifactSteps.some((step) => step.run === "pnpm ui:build")).toBe(false);
  });

  it("uploads a CI timing summary after the run lanes finish", () => {
    const workflow = readCiWorkflow();
    const timingJob = workflow.jobs["ci-timings-summary"];

    expect(timingJob.permissions).toMatchObject({ actions: "read", contents: "read" });
    expect(timingJob.needs).toEqual([
      "preflight",
      "security-fast",
      "pnpm-store-warmup",
      "build-artifacts",
      "checks-fast-core",
      "checks-fast-plugin-contracts-shard",
      "checks-fast-channel-contracts-shard",
      "checks-node-compat",
      "checks-node-core-test-nondist-shard",
      "check-shard",
      "check-additional-shard",
      "check-docs",
      "skills-python",
      "checks-windows",
      "macos-node",
      "macos-swift",
      "android",
    ]);
    expect(timingJob.if).toContain("always()");
    expect(timingJob.if).toContain("!cancelled()");

    const checkoutStep = timingJob.steps.find(
      (step) => step.name === "Checkout timing summary helper",
    );
    expect(checkoutStep.uses).toBe("actions/checkout@v6");
    expect(checkoutStep.with.ref).toBe(
      "${{ github.event_name == 'pull_request' && github.event.pull_request.base.sha || needs.preflight.outputs.checkout_revision || github.sha }}",
    );
    expect(checkoutStep.with["persist-credentials"]).toBe(false);

    const writeStep = timingJob.steps.find((step) => step.name === "Write CI timing summary");
    expect(writeStep.env).toMatchObject({ GH_TOKEN: "${{ github.token }}" });
    expect(writeStep.run).toContain(
      'node scripts/ci-run-timings.mjs "$GITHUB_RUN_ID" --limit 25 > ci-timings-summary.txt',
    );
    expect(writeStep.run).toContain('cat ci-timings-summary.txt >> "$GITHUB_STEP_SUMMARY"');

    const uploadStep = timingJob.steps.find((step) => step.name === "Upload CI timing summary");
    expect(uploadStep.uses).toBe("actions/upload-artifact@v7");
    expect(uploadStep.with).toMatchObject({
      name: "ci-timings-summary",
      path: "ci-timings-summary.txt",
      "retention-days": 14,
    });
  });

  it("keeps push docs validation ClawHub-backed", () => {
    const workflow = readFileSync(".github/workflows/docs.yml", "utf8");

    expect(workflow).toContain("repository: openclaw/clawhub");
    expect(workflow).toContain("path: clawhub-source");
    expect(workflow).toContain(
      "OPENCLAW_DOCS_SYNC_CLAWHUB_REPO: ${{ github.workspace }}/clawhub-source",
    );
  });
});
