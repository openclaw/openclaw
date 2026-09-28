import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { runCiManifestFixture } from "./ci-workflow-manifest.test-support.js";
import {
  evaluateWorkflowExpression,
  readCiWorkflow,
  type WorkflowStep,
} from "./ci-workflow.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("PR failure cancellation", () => {
  it("keeps critical-path routing and adds default Blacksmith failure reporting", () => {
    const gate = readCiWorkflow().jobs["ci-gate"];
    const context = {
      eventName: "pull_request" as const,
      repository: "openclaw/openclaw",
      runAttempt: 1,
      runnerProfile: "blacksmith" as const,
      failFastOutputs: { failure_job_id: "42", failure_run_attempt: "1" },
    };
    for (const runnerBackend of ["", "blacksmith"] as const) {
      expect(evaluateWorkflowExpression(gate["runs-on"], { ...context, runnerBackend })).toBe(
        "blacksmith-4vcpu-ubuntu-2404",
      );
    }
    for (const override of [
      { failFastOutputs: {} },
      { runAttempt: 2 },
      { runnerProfile: "github" as const },
      { runnerBackend: "github" as const },
      { eventName: "push" as const },
      { eventName: "workflow_dispatch" as const },
      { headRepository: "contributor/openclaw" },
    ]) {
      expect(evaluateWorkflowExpression(gate["runs-on"], { ...context, ...override })).toBe(
        "ubuntu-24.04",
      );
    }
    for (const runnerBackend of ["hybrid", "runson"] as const) {
      expect(
        evaluateWorkflowExpression(gate["runs-on"], {
          ...context,
          runnerBackend,
          runnerProfile: "hybrid",
          failFastOutputs: {},
        }),
      ).toBe("blacksmith-4vcpu-ubuntu-2404");
    }
  });

  it.each(["blacksmith", "github", "hybrid"] as const)(
    "reconciles installed check selection with the full %s PR graph",
    (runnerProfile) => {
      const manifest = runCiManifestFixture({
        bundledPlanner: true,
        checkFamilyScope: true,
        historicalCompatibility: false,
        eventName: "pull_request",
        runnerProfile,
        runnerBackend: runnerProfile,
        changedPaths: ["src/agents/example.ts"],
        ciTypeGraphNames: ["core-test-agents-root"],
        changedPlannerSource: `
          export function createChangedNodeTestShards() {
            return [{ checkName: "checks-node-count-fixture", shardName: "count-fixture",
              configs: ["test/vitest/vitest.unit-fast.config.ts"], requiresDist: false,
              runner: "blacksmith-4vcpu-ubuntu-2404" }];
          }
          export function createChangedExtensionFallbackShards() { return []; }
        `,
      });
      expect(manifest.status, manifest.output).toBe(0);
      expect(manifest.outputs.run_check_plan).toBe("true");
      const workflow = readCiWorkflow();
      const context: Parameters<typeof evaluateWorkflowExpression>[1] = {
        eventName: "pull_request",
        repository: "openclaw/openclaw",
        runAttempt: 1,
        runnerBackend: runnerProfile,
        runnerProfile,
        preflightOutputs: manifest.outputs,
        additionalNeeds: {
          "check-plan": { outputs: manifest.checkPlanOutputs, result: "success" },
        },
      };
      const evaluate = (value: string) =>
        evaluateWorkflowExpression(value.startsWith("${{") ? value : `\${{ ${value} }}`, context);
      let admitted = 0;
      for (const [name, job] of Object.entries(workflow.jobs) as Array<
        [
          string,
          {
            if?: string;
            strategy?: { matrix: string | { include?: unknown[]; [key: string]: unknown } };
          },
        ]
      >) {
        if (["pr-fail-fast", "ci-gate"].includes(name) || (job.if && !evaluate(job.if))) {
          continue;
        }
        const matrix =
          typeof job.strategy?.matrix === "string"
            ? (evaluate(job.strategy.matrix) as { include?: unknown[]; [key: string]: unknown })
            : job.strategy?.matrix;
        admitted += matrix?.include
          ? matrix.include.length
          : matrix
            ? Object.values(matrix).reduce<number>(
                (total, values) =>
                  total *
                  (typeof values === "string"
                    ? (evaluate(values) as unknown[]).length
                    : (values as unknown[]).length),
                1,
              )
            : 1;
      }
      const early = Number(manifest.outputs.pr_check_job_count);
      const final = Number(manifest.checkPlanOutputs.check_job_count);
      expect(final).toBeLessThan(early);
      expect(Number(manifest.outputs.pr_job_count) - early + final).toBe(admitted);
      const monitor = workflow.jobs["pr-fail-fast"];
      expect(monitor.needs).toEqual(["preflight"]);
      const step = monitor.steps.find((candidate: WorkflowStep) => candidate.id === "monitor");
      expect(evaluate(step.env.OPENCLAW_CI_EXPECTED_JOBS)).toBe(manifest.outputs.pr_job_count);
      expect(evaluate(step.env.OPENCLAW_CI_PREFLIGHT_CHECK_JOBS)).toBe(String(early));
      expect(evaluate(step.env.OPENCLAW_CI_CHECK_PLAN_EXPECTED)).toBe("true");
    },
  );

  it("uses the existing monitor grants for canonical PR observation including forks", () => {
    const workflow = readCiWorkflow();
    expect(
      Object.entries(workflow.jobs)
        .filter(
          ([, job]) =>
            (job as { permissions?: { actions?: string } }).permissions?.actions === "write",
        )
        .map(([name]) => name),
    ).toEqual(["pr-fail-fast"]);
    for (const [eventName, headRepository, admitted] of [
      ["pull_request", "openclaw/openclaw", true],
      ["pull_request", "contributor/openclaw", true],
      ["push", "openclaw/openclaw", false],
      ["workflow_dispatch", "openclaw/openclaw", false],
    ] as const) {
      expect(
        evaluateWorkflowExpression(workflow.jobs["pr-fail-fast"].if, {
          eventName,
          headRepository,
          repository: "openclaw/openclaw",
          runAttempt: 1,
          preflightOutputs: { run_checks_node_core_nondist: "true" },
        }),
      ).toBe(admitted);
    }
  });
  it("does not admit the final gate for cancelled workflows or draft pull requests", () => {
    const gate = readCiWorkflow().jobs["ci-gate"];
    for (const eventName of ["pull_request", "push", "workflow_dispatch"] as const) {
      for (const cancelled of [true, false]) {
        for (const draft of [true, false]) {
          expect(
            evaluateWorkflowExpression(gate.if, {
              ciOnPush: "true",
              cancelled,
              draft,
              eventName,
              repository: "openclaw/openclaw",
              runAttempt: 1,
            }),
            JSON.stringify({ cancelled, draft, eventName }),
          ).toBe(!cancelled && (eventName !== "pull_request" || !draft));
        }
      }
    }
  });

  it.each(["pull_request", "push", "workflow_dispatch"] as const)(
    "keeps first-attempt continuation within the canonical monitor's scope (%s)",
    (eventName) => {
      const workflow = readCiWorkflow();
      const node = workflow.jobs["checks-node-core-test-nondist-shard"];
      const run = node.steps.find((step: WorkflowStep) => step.name === "Run Node test shard");
      for (const [repository, headRepository, runAttempt, nativeFailFast, continuation] of [
        ["openclaw/openclaw", "openclaw/openclaw", 1, false, "1"],
        ["openclaw/openclaw", "contributor/openclaw", 1, false, "1"],
        ["openclaw/openclaw", "openclaw/openclaw", 2, true, "0"],
        ["fork/openclaw", "fork/openclaw", 1, true, "0"],
        ["fork/openclaw", "contributor/openclaw", 1, true, "0"],
        ["fork/openclaw", "fork/openclaw", 2, true, "0"],
      ] as const) {
        const context = { eventName, repository, headRepository, runAttempt };
        expect(evaluateWorkflowExpression(node.strategy["fail-fast"], context)).toBe(
          eventName === "pull_request" && nativeFailFast,
        );
        expect(
          evaluateWorkflowExpression(run.env.OPENCLAW_NODE_TEST_PLAN_CONTINUE_ON_FAILURE, context),
        ).toBe(eventName === "pull_request" ? continuation : "0");
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "finishes selected compiler and lint groups only for ordinary diagnostic failures",
    () => {
      const workflow = readCiWorkflow();
      const central = workflow.jobs["check-shard"].steps.find(
        (step: WorkflowStep) => step.name === "Run check shard",
      );
      const hosted = workflow.jobs["check-test-types-hosted-core-shard"].steps.find(
        (step: WorkflowStep) => step.name === "Run hosted core test-types stripe",
      );
      const root = tempDirs.make("ci-type-groups-");
      const calls = path.join(root, "calls");
      mkdirSync(path.join(root, ".ci-harness/scripts"), { recursive: true });
      copyFileSync(
        new URL("../../scripts/ci-static-step.sh", import.meta.url),
        path.join(root, ".ci-harness/scripts/ci-static-step.sh"),
      );
      mkdirSync(path.join(root, "scripts"));
      writeFileSync(path.join(root, "scripts/run-oxlint-shards.mts"), "// --extension-stripe\n");
      writeFileSync(
        path.join(root, "node"),
        '#!/bin/bash\nprintf "%s\\n" "$*" >> "$CALLS_FILE"\nif [[ "$*" == *"${FAIL_MARKER:-first}"* ]]; then exit "$COMPILER_EXIT"; fi\n',
        { mode: 0o755 },
      );
      for (const [evidence, compilerExit, expectedCalls, groups] of [
        ["1", "2", 2, 2],
        ["0", "2", 1, 0],
        ["1", "1", 1, 0],
      ] as const) {
        writeFileSync(calls, "");
        const run = spawnSync("/bin/bash", ["-c", central.run], {
          cwd: root,
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${root}:${process.env.PATH}`,
            CALLS_FILE: calls,
            COMPILER_EXIT: compilerExit,
            OPENCLAW_CI_STATIC_EVIDENCE: evidence,
            NARROW_CHECK_PATHS_JSON: '["src/example.ts"]',
            TASK: "test-types",
            CI_CORE_TYPE_GRAPHS_JSON: '["first"]',
            CI_CORE_TYPE_CONCURRENCY: "1",
            CI_TYPE_GRAPHS_JSON: '["second"]',
          },
        });
        expect(run.status, run.stderr).toBe(Number(compilerExit));
        expect(readFileSync(calls, "utf8").trim().split("\n")).toHaveLength(expectedCalls);
        expect(run.stdout.includes('[ci-static:tsgo:step] {"version":1,"groups":2}')).toBe(
          groups === 2,
        );
      }
      const run = spawnSync("/bin/bash", ["-c", hosted.run], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${root}:${process.env.PATH}`,
          CALLS_FILE: calls,
          COMPILER_EXIT: "2",
          OPENCLAW_CI_STATIC_EVIDENCE: "1",
          CI_TYPE_GRAPHS_JSON: '["first"]',
        },
      });
      expect(run.status, run.stderr).toBe(2);
      expect(run.stdout).toContain('[ci-static:tsgo:step] {"version":1,"groups":1}');

      const lint = workflow.jobs["check-lint-hosted-core-shard"].steps.find(
        (step: WorkflowStep) => step.name === "Run hosted core lint stripe",
      );
      const lintScript = lint.run.replace(/\$\{\{[\s\S]*?\}\}/gu, (expression: string) =>
        String(
          evaluateWorkflowExpression(expression, {
            eventName: "pull_request",
            repository: "openclaw/openclaw",
            runAttempt: 1,
            runnerProfile: "github",
          }),
        ),
      );
      for (const [evidence, compilerExit, expectedCalls, groups] of [
        ["1", "1", 2, 2],
        ["0", "1", 1, 0],
        ["1", "2", 1, 0],
      ] as const) {
        writeFileSync(calls, "");
        const lintRun = spawnSync("/bin/bash", ["-c", lintScript], {
          cwd: root,
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${root}:${process.env.PATH}`,
            CALLS_FILE: calls,
            FAIL_MARKER: "--only=core",
            COMPILER_EXIT: compilerExit,
            OPENCLAW_CI_STATIC_EVIDENCE: evidence,
            CORE_STRIPE: "1",
            FROZEN_TARGET: "false",
            RUNNER_PROFILE: "github",
            RELEASE_GATE: "false",
          },
        });
        expect(lintRun.status, lintRun.stderr).toBe(Number(compilerExit));
        expect(readFileSync(calls, "utf8").trim().split("\n")).toHaveLength(expectedCalls);
        expect(lintRun.stdout.includes('[ci-static:oxlint:step] {"version":1,"groups":2}')).toBe(
          groups === 2,
        );
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "accepts only the completed monitor's supported test and static exceptions",
    () => {
      const verify = readCiWorkflow().jobs["ci-gate"].steps.find(
        (entry: WorkflowStep) => entry.name === "Verify selected CI lanes",
      );
      for (const [name, result, receipt, attempt, exit] of [
        ["checks-node-core-test-nondist-shard", "failure", "1", 1, 0],
        ["checks-node-core-test-nondist-shard", "failure", "", 1, 1],
        ["checks-node-core-test-nondist-shard", "failure", "1", 2, 1],
        ["checks-node-core-test-nondist-shard", "cancelled", "1", 1, 1],
        ["check-shard", "failure", "1", 1, 0],
        ["check-test-types-hosted-core-shard", "failure", "1", 1, 0],
        ["check-test-types-hosted-core-shard", "failure", "", 1, 1],
        ["check-lint-hosted-core-shard", "failure", "1", 1, 0],
        ["check-lint-hosted-extension-shard", "failure", "1", 1, 0],
        ["check-lint-hosted-core-shard", "failure", "", 1, 1],
        ["check-additional-shard", "failure", "1", 1, 1],
      ] as const) {
        const allowed = evaluateWorkflowExpression(verify.env.ALLOW_KNOWN_MAIN_RED, {
          eventName: "pull_request",
          repository: "openclaw/openclaw",
          runAttempt: attempt,
          failFastResult: "success",
          failFastOutputs: { known_main_red_attempt: receipt },
        });
        const run = spawnSync("/bin/bash", ["-c", verify.run], {
          encoding: "utf8",
          env: {
            ...process.env,
            ALLOW_KNOWN_MAIN_RED: String(allowed),
            JOB_RESULTS: `${name}=${result}|true`,
          },
        });
        expect(run.status, run.stdout).toBe(exit);
      }
    },
  );

  it("keeps an uncertain cancellation red even if cause outputs are unavailable", () => {
    expect(
      evaluateWorkflowExpression(readCiWorkflow().jobs["ci-gate"].if, {
        eventName: "pull_request",
        repository: "openclaw/openclaw",
        runAttempt: 1,
        cancelled: true,
        failFastResult: "failure",
      }),
    ).toBe(true);
  });

  it.skipIf(process.platform === "win32")(
    "does not reuse a previous attempt's failure cause or monitor result",
    () => {
      const workflow = readCiWorkflow();
      const gate = workflow.jobs["ci-gate"];
      const context = {
        eventName: "pull_request" as const,
        repository: "openclaw/openclaw",
        runAttempt: 2,
        failFastOutputs: { failure_job_id: "42", failure_run_attempt: "1" },
        failFastResult: "failure",
        preflightOutputs: { run_checks_node_core_nondist: "true" },
      };
      expect(evaluateWorkflowExpression(workflow.jobs["pr-fail-fast"].if, context)).toBe(false);
      expect(evaluateWorkflowExpression(gate.if, { ...context, cancelled: true })).toBe(false);
      const report = gate.steps.find(
        (entry: WorkflowStep) => entry.name === "Report originating PR failure",
      );
      expect(evaluateWorkflowExpression(`\${{ ${report.if} }}`, context)).toBe(false);
      const verify = gate.steps.find(
        (entry: WorkflowStep) => entry.name === "Verify selected CI lanes",
      );
      const monitorRow = verify.env.JOB_RESULTS.split("\n")
        .find((line: string) => line.startsWith("pr-fail-fast="))
        .replace(/\$\{\{[\s\S]*?\}\}/gu, (expression: string) =>
          String(evaluateWorkflowExpression(expression, context)),
        );
      expect(monitorRow).toBe("pr-fail-fast=skipped|false");
      for (const [result, exit] of [
        ["success", 0],
        ["failure", 1],
        ["cancelled", 1],
      ] as const) {
        const run = spawnSync("/bin/bash", ["-c", verify.run], {
          encoding: "utf8",
          env: {
            ...process.env,
            JOB_RESULTS: `preflight=success|true\nsecurity-fast=success|true\nchecks-node-core-test-nondist-shard=${result}|true\n${monitorRow}`,
          },
        });
        expect(run.status, run.stdout).toBe(exit);
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "reports the originating failure after cancelling other jobs",
    () => {
      const workflow = readCiWorkflow();
      const gate = workflow.jobs["ci-gate"];
      expect(
        evaluateWorkflowExpression(gate.if, {
          eventName: "pull_request",
          repository: "openclaw/openclaw",
          runAttempt: 1,
          cancelled: true,
          failFastOutputs: { failure_job_id: "42", failure_run_attempt: "1" },
        }),
      ).toBe(true);
      const summary = path.join(tempDirs.make("pr-cancel-gate-"), "summary.md");
      const step = gate.steps.find(
        (entry: WorkflowStep) => entry.name === "Report originating PR failure",
      );
      expect(
        evaluateWorkflowExpression(`\${{ ${step.if} }}`, {
          eventName: "pull_request",
          repository: "openclaw/openclaw",
          runAttempt: 1,
          cancelled: true,
          failFastOutputs: { failure_job_id: "42", failure_run_attempt: "1" },
        }),
      ).toBe(true);
      const result = spawnSync("/bin/bash", ["-c", step.run], {
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_STEP_SUMMARY: summary,
          GITHUB_SERVER_URL: "https://github.com",
          GITHUB_REPOSITORY: "openclaw/openclaw",
          GITHUB_RUN_ID: "100",
          FAILURE_JOB_ID: "42",
          FAILURE_JOB_NAME: "checks-node-example",
        },
      });
      expect(result.status, result.stderr).toBe(1);
      expect(readFileSync(summary, "utf8")).toContain("checks-node-example");
      expect(readFileSync(summary, "utf8")).toContain("/actions/runs/100/job/42");
    },
  );
});
