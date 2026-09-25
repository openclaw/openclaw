import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCiCheckPlan, type CiCheckPlanInput } from "../../scripts/ci-check-plan.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  evaluateWorkflowExpression,
  readCiWorkflow,
  readWorkflowOutputs,
  runWorkflowShellScript,
  type WorkflowStep,
} from "./ci-workflow.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

vi.mock("../../scripts/run-tsgo-core-test-shards.mts", () => ({
  createChangedCiTypeCheckPlan: async () => ({
    mode: "targeted",
    graphs: [
      {
        name: "core-test-agents-root",
        config: "test/tsconfig/tsconfig.core.test.agents-root.json",
      },
      { name: "scripts", config: "tsconfig.scripts.json" },
    ],
  }),
}));

const checkJobs = [
  "check-shard",
  "check-lint-hosted-core-shard",
  "check-lint-hosted-extension-shard",
  "check-test-types-hosted-core-shard",
];

function admittedCheckRows(context: Parameters<typeof evaluateWorkflowExpression>[1]) {
  const workflow = readCiWorkflow();
  return checkJobs.flatMap((name) => {
    const job = workflow.jobs[name];
    return evaluateWorkflowExpression(job.if, context)
      ? evaluateWorkflowExpression(job.strategy.matrix, context).include
      : [];
  });
}

function materializePlan(runnerProfile: string, rows: number) {
  const input: CiCheckPlanInput = {
    changedPaths: ["docs/ci.md"],
    changedCoreTestPaths: null,
    runnerProfile,
    checkMatrix: {
      include: Array.from({ length: rows }, (_, index) => ({
        check_name: `check-guards-${index}`,
        task: "guards",
        runner: "blacksmith-4vcpu-ubuntu-2404",
      })),
    },
    coreTypeMatrix: { include: [] },
    // A null lint plan retains templates even when their runner profile disables them.
    lintCoreMatrix: { include: rows ? [{ stripe: 1 }, { stripe: 2 }] : [] },
    lintExtensionMatrix: { include: rows ? [{ stripe: 1 }, { stripe: 2 }, { stripe: 3 }] : [] },
  };
  const output = join(tempDirs.make("ci-check-count-"), "output");
  const workflow = readCiWorkflow();
  const planner = workflow.jobs["check-plan"];
  const step = planner.steps.find((candidate: WorkflowStep) => candidate.id === "plan");
  const context: Parameters<typeof evaluateWorkflowExpression>[1] = {
    eventName: "pull_request",
    repository: "openclaw/openclaw",
    runAttempt: 1,
    preflightOutputs: { check_plan_input_json: JSON.stringify(input) },
  };
  const run = runWorkflowShellScript(step.run, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      GITHUB_OUTPUT: output,
      OPENCLAW_CI_CHECK_PLAN_INPUT_JSON: evaluateWorkflowExpression(
        step.env.OPENCLAW_CI_CHECK_PLAN_INPUT_JSON,
        context,
      ),
    },
  });
  return { run, workflow, planner, outputs: existsSync(output) ? readWorkflowOutputs(output) : {} };
}

describe("CI check-plan completion count", () => {
  it.each(["blacksmith", "github", "hybrid"] as const)(
    "publishes the admitted workflow expansion for %s, including an empty plan",
    (runnerProfile) => {
      for (const rows of [1, 0]) {
        const { run, planner, outputs } = materializePlan(runnerProfile, rows);
        expect(run.status, run.stderr).toBe(0);
        const context: Parameters<typeof evaluateWorkflowExpression>[1] = {
          eventName: "pull_request",
          repository: "openclaw/openclaw",
          runAttempt: 1,
          runnerProfile,
          preflightOutputs: { run_check_plan: "true", narrow_check_paths_json: "[]" },
          additionalNeeds: { "check-plan": { outputs, result: "success" } },
          steps: { plan: { outputs } },
        };
        const admittedRows = admittedCheckRows(context);
        expect(outputs.check_job_count).toBe(String(admittedRows.length));
        const marker: WorkflowStep = planner.steps.at(-1);
        const admission = marker.if ?? "success()";
        const condition = admission.startsWith("${{") ? admission : `\${{ ${admission} }}`;
        for (const terminal of [{}, { failed: true }, { cancelled: true }]) {
          expect(evaluateWorkflowExpression(condition, { ...context, ...terminal })).toBe(
            !terminal.failed && !terminal.cancelled,
          );
        }
        const continueOnError: unknown = marker["continue-on-error"];
        expect(
          typeof continueOnError === "string"
            ? evaluateWorkflowExpression(continueOnError, context)
            : (continueOnError ?? false),
        ).toBe(false);
        const name = marker.name?.replace(/\$\{\{[\s\S]*?\}\}/gu, (expression) =>
          String(evaluateWorkflowExpression(expression, context)),
        );
        expect(name).toBe(`CI check job count v1: ${admittedRows.length}`);
        expect(runWorkflowShellScript(marker.run!, { cwd: process.cwd() }).status).toBe(0);
      }
    },
  );

  it.each(["blacksmith", "github", "hybrid"] as const)(
    "counts the actual compiler placement for %s",
    async (runnerProfile) => {
      const plan = await createCiCheckPlan({
        changedPaths: ["src/shared.ts"],
        changedCoreTestPaths: null,
        runnerProfile,
        checkMatrix: {
          include: [{ check_name: "check-test-types", task: "test-types", runner: "unused" }],
        },
        coreTypeMatrix: { include: [1, 2, 3, 4, 5].map((stripe) => ({ stripe })) },
        lintCoreMatrix: { include: [] },
        lintExtensionMatrix: { include: [] },
      });
      const outputs = Object.fromEntries(
        Object.entries(plan).map(([name, value]) => [
          name,
          typeof value === "string" ? value : JSON.stringify(value),
        ]),
      );
      expect(outputs.check_job_count).toBe(
        String(
          admittedCheckRows({
            eventName: "pull_request",
            repository: "openclaw/openclaw",
            runAttempt: 1,
            runnerProfile,
            preflightOutputs: { run_check_plan: "true", narrow_check_paths_json: "[]" },
            additionalNeeds: { "check-plan": { outputs, result: "success" } },
          }).length,
        ),
      );
    },
  );

  it("refuses a count outside the observer's existing job inventory bound", () => {
    const { run, outputs } = materializePlan("blacksmith", 401);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("400-job");
    expect(outputs).toEqual({});
  });
});
