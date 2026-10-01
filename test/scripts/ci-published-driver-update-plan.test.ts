import { describe, expect, it } from "vitest";
import { shouldRunPublishedDriverUpdate } from "../../scripts/lib/ci-published-driver-update-plan.mts";
import { runCiManifestFixture } from "./ci-workflow-manifest.test-support.js";
import {
  evaluateWorkflowExpression,
  readCiWorkflow,
  readWorkflow,
  type WorkflowStep,
} from "./ci-workflow.test-support.js";

describe("published-driver update selection", () => {
  it.each([
    "src/infra/update-runner.ts",
    "src/cli/update-cli/update-command.ts",
    "src/state/openclaw-state-lease.ts",
    "src/state/openclaw-state-lease-identity.ts",
    "src/state/openclaw-state-db-open.ts",
    "src/infra/sqlite-file-identity.ts",
    "src/plugins/plugin-native-assignments.ts",
    "src/cli/startup-trace.ts",
    "src/gateway/server-startup-trace.ts",
    "scripts/update-gateway.sh",
    "scripts/lib/source-update-build.mts",
    "scripts/lib/update-compat-chunks.mts",
    "scripts/e2e/update-first-hop-compat-docker.sh",
    "scripts/e2e/lib/upgrade-survivor/assertions.mjs",
    "scripts/e2e/plugin-update-unchanged-docker.sh",
    "scripts/e2e/lib/plugin-update/consent-scenario.mjs",
    "scripts/e2e/parallels/npm-update-smoke.ts",
    "scripts/lib/release-upgrade-baseline.mjs",
    "scripts/lib/cross-os-release-checks/packaged-self-update.ts",
    "scripts/test-update-cli-startup-bench.mts",
    "scripts/doctor-config-upgrade-replay.mjs",
    "scripts/package-openclaw-for-docker.mts",
    "scripts/e2e/published-driver-update-docker.sh",
    "scripts/lib/ci-published-driver-update-plan.mts",
    ".github/workflows/ci-published-driver-update.yml",
    ".github/workflows/ci.yml",
    "src\\state\\openclaw-state-lease.ts",
  ])("requires the cross-version cell for %s", (file) => {
    expect(shouldRunPublishedDriverUpdate([file])).toBe(true);
  });

  it.each([
    "docs/install/updating.md",
    "src/agents/context-window-guard.ts",
    "src/state/openclaw-state-schema.ts",
    "src/plugins/plugin-manifest.ts",
    "scripts/format-docs.mts",
    "ui/src/app.ts",
  ])("omits unrelated owner %s", (file) => {
    expect(shouldRunPublishedDriverUpdate([file])).toBe(false);
  });

  it.each([{ paths: null }, { paths: [] }, { paths: [""] }])(
    "retains coverage for an unavailable diff $paths",
    ({ paths }) => {
      expect(shouldRunPublishedDriverUpdate(paths)).toBe(true);
    },
  );

  it.each([
    { eventName: "pull_request", file: "src/state/openclaw-state-lease.ts", selected: true },
    { eventName: "pull_request", file: "src/agents/context-window-guard.ts", selected: false },
    { eventName: "push", file: "src/agents/context-window-guard.ts", selected: true },
    { eventName: "workflow_dispatch", file: "src/agents/context-window-guard.ts", selected: true },
  ] as const)("connects $eventName $file to the required job", ({ eventName, file, selected }) => {
    const result = runCiManifestFixture({
      bundledPlanner: true,
      historicalCompatibility: false,
      eventName,
      changedPaths: [file],
    });
    expect(result.status, result.output).toBe(0);
    expect(result.outputs.run_published_driver_update).toBe(String(selected));
    const job = readCiWorkflow().jobs["published-driver-update"];
    const revision = "a".repeat(40);
    expect(
      evaluateWorkflowExpression(`\${{ ${job.if} }}`, {
        eventName,
        repository: "openclaw/openclaw",
        runAttempt: 1,
        sha: revision,
        preflightOutputs: { ...result.outputs, checkout_revision: revision },
      }),
    ).toBe(selected);
  });

  it("keeps candidate execution in the caller revision and cache scope", () => {
    const workflow = readWorkflow(".github/workflows/ci-published-driver-update.yml");
    const job = workflow.jobs.update;
    const checkout = job.steps.find((step: WorkflowStep) =>
      step.uses?.startsWith("actions/checkout@"),
    );
    const revision = "a".repeat(40);
    expect(
      evaluateWorkflowExpression(checkout.with.ref, {
        eventName: "workflow_dispatch",
        repository: "openclaw/openclaw",
        runAttempt: 1,
        sha: revision,
        targetRef: "b".repeat(40),
      }),
    ).toBe(revision);
    expect(workflow.on.workflow_call?.inputs).toBeUndefined();
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(checkout.with["persist-credentials"]).toBe(false);
    expect(
      job.steps.find((step: WorkflowStep) => step.uses === "./.github/actions/setup-node-env").with[
        "cache-mode"
      ],
    ).toBe("off");
  });

  it("records the omitted cell when a dispatch fallback selects a different revision", () => {
    const workflow = readCiWorkflow();
    const context = {
      eventName: "workflow_dispatch" as const,
      repository: "openclaw/openclaw",
      runAttempt: 1,
      sha: "a".repeat(40),
      preflightOutputs: {
        run_published_driver_update: "true",
        checkout_revision: "b".repeat(40),
      },
    };
    expect(
      evaluateWorkflowExpression(`\${{ ${workflow.jobs["published-driver-update"].if} }}`, context),
    ).toBe(false);
    const notice = workflow.jobs["ci-gate"].steps.find(
      (step: WorkflowStep) => step.name === "Record published-driver dispatch limitation",
    );
    expect(evaluateWorkflowExpression(`\${{ ${notice.if} }}`, context)).toBe(true);
    expect(notice.run).toContain("no published-driver cell proof for the selected revision");
  });

  it("omits the cell for frozen targets that predate its harness", () => {
    const result = runCiManifestFixture({
      bundledPlanner: true,
      historicalCompatibility: true,
      publishedDriverUpdateCapability: false,
      eventName: "workflow_dispatch",
    });
    expect(result.status, result.output).toBe(0);
    expect(result.outputs.run_published_driver_update).toBe("false");
  });
});
