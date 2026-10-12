import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  evaluateWorkflowExpression,
  readCiWorkflow,
  type WorkflowStep,
} from "./ci-workflow.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("PR failure reporting", () => {
  it("keeps critical-path routing and adds default Blacksmith failure reporting", () => {
    const gate = readCiWorkflow().jobs["ci-gate"];
    const context = {
      eventName: "pull_request" as const,
      repository: "openclaw/openclaw",
      runAttempt: 1,
      runnerProfile: "blacksmith" as const,
      failureReportOutputs: { failure_job_id: "42" },
    };
    for (const runnerBackend of ["", "blacksmith"] as const) {
      expect(evaluateWorkflowExpression(gate["runs-on"], { ...context, runnerBackend })).toBe(
        "blacksmith-4vcpu-ubuntu-2404",
      );
    }
    for (const override of [
      { failureReportOutputs: {} },
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
          failureReportOutputs: {},
        }),
      ).toBe("blacksmith-4vcpu-ubuntu-2404");
    }
  });

  it("waits for every workload and uses read-only grants for canonical PRs including forks", () => {
    const workflow = readCiWorkflow();
    const report = workflow.jobs["pr-failure-report"];
    expect(report.needs).toEqual(
      workflow.jobs["ci-gate"].needs.filter((name: string) => name !== "pr-failure-report"),
    );
    expect(report.permissions).toEqual({
      contents: "read",
      actions: "read",
      "pull-requests": "read",
    });
    expect(
      Object.entries(workflow.jobs)
        .filter(
          ([, job]) =>
            (job as { permissions?: { actions?: string } }).permissions?.actions === "write",
        )
        .map(([name]) => name),
    ).toEqual([]);
    for (const [eventName, headRepository, runAttempt, preflightResult, admitted] of [
      ["pull_request", "openclaw/openclaw", 1, "success", true],
      ["pull_request", "contributor/openclaw", 1, "success", true],
      ["pull_request", "openclaw/openclaw", 2, "success", true],
      ["pull_request", "openclaw/openclaw", 1, "failure", true],
      ["push", "openclaw/openclaw", 1, "success", false],
      ["workflow_dispatch", "openclaw/openclaw", 1, "success", false],
    ] as const) {
      expect(
        evaluateWorkflowExpression(report.if, {
          eventName,
          headRepository,
          repository: "openclaw/openclaw",
          runAttempt,
          preflightResult,
          preflightOutputs: { run_checks_node_core_nondist: "false" },
        }),
      ).toBe(admitted);
    }
    for (const overrides of [
      { cancelled: true },
      { draft: true },
      { repository: "contributor/openclaw" },
    ]) {
      expect(
        evaluateWorkflowExpression(report.if, {
          eventName: "pull_request",
          repository: "openclaw/openclaw",
          runAttempt: 1,
          ...overrides,
        }),
      ).toBe(false);
    }
  });
  it("gates cancelled workflows and drafts", () => {
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
    expect(
      evaluateWorkflowExpression(gate.if, {
        eventName: "pull_request",
        repository: "openclaw/openclaw",
        runAttempt: 1,
        cancelled: true,
        failureReportResult: "failure",
      }),
    ).toBe(false);
  });

  it.each(["pull_request", "push", "workflow_dispatch"] as const)(
    "keeps canonical PR matrices complete and first-attempt diagnostic continuation (%s)",
    (eventName) => {
      const workflow = readCiWorkflow();
      const node = workflow.jobs["checks-node-core-test-nondist-shard"];
      const run = node.steps.find((step: WorkflowStep) => step.name === "Run Node test shard");
      for (const [repository, headRepository, runAttempt, nativeFailFast, continuation] of [
        ["openclaw/openclaw", "openclaw/openclaw", 1, false, "1"],
        ["openclaw/openclaw", "contributor/openclaw", 1, false, "1"],
        ["openclaw/openclaw", "openclaw/openclaw", 2, false, "0"],
        ["openclaw/openclaw", "contributor/openclaw", 2, false, "0"],
        ["openclaw/openclaw", "openclaw/openclaw", 3, false, "0"],
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
    "accepts only the completed report's supported test and static exceptions",
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
          preflightOutputs: { run_checks_node_core_nondist: "true" },
          failureReportResult: "success",
          failureReportOutputs: { known_main_red_attempt: receipt },
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

  it.skipIf(process.platform === "win32")(
    "keeps retry and non-Node reports informational without extending the known-main-red allowance",
    () => {
      const workflow = readCiWorkflow();
      const verify = workflow.jobs["ci-gate"].steps.find(
        (entry: WorkflowStep) => entry.name === "Verify selected CI lanes",
      );
      for (const [runAttempt, nodeSelected] of [
        [2, true],
        [1, false],
      ] as const) {
        for (const result of ["success", "failure", "skipped"] as const) {
          const context: Parameters<typeof evaluateWorkflowExpression>[1] = {
            eventName: "pull_request",
            repository: "openclaw/openclaw",
            runAttempt,
            preflightOutputs: { run_checks_node_core_nondist: String(nodeSelected) },
            failureReportResult: result,
            failureReportOutputs: { known_main_red_attempt: String(runAttempt) },
          };
          expect(evaluateWorkflowExpression(workflow.jobs["pr-failure-report"].if, context)).toBe(
            true,
          );
          expect(evaluateWorkflowExpression(verify.env.ALLOW_KNOWN_MAIN_RED, context)).toBe(false);
          const reportRow = verify.env.JOB_RESULTS.split("\n")
            .find((line: string) => line.startsWith("pr-failure-report="))
            .replace(/\$\{\{[\s\S]*?\}\}/gu, (expression: string) =>
              String(evaluateWorkflowExpression(expression, context)),
            );
          expect(reportRow).toBe("pr-failure-report=skipped|false");
          const run = spawnSync("/bin/bash", ["-c", verify.run], {
            encoding: "utf8",
            env: {
              ...process.env,
              JOB_RESULTS: `preflight=success|true\nsecurity-fast=success|true\n${reportRow}`,
            },
          });
          expect(run.status, run.stdout).toBe(0);
        }
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "publishes the classification table and machine-readable failures without changing the gate result",
    () => {
      const gate = readCiWorkflow().jobs["ci-gate"];
      const step = gate.steps.find(
        (entry: WorkflowStep) => entry.name === "Report PR failure classification",
      );
      const context: Parameters<typeof evaluateWorkflowExpression>[1] = {
        eventName: "pull_request",
        repository: "openclaw/openclaw",
        runAttempt: 2,
      };
      expect(evaluateWorkflowExpression(`\${{ ${step.if} }}`, context)).toBe(false);
      const summary = "| Job | Class |\n| --- | --- |\n| checks-node-example | pre-existing |\n";
      const failures = [
        {
          job: "checks-node-example",
          conclusion: "failure",
          class: "pre-existing",
          mainRunId: 90,
          mainJobId: 42,
          reason: "matching failure signature",
        },
      ];
      const summaryPath = path.join(tempDirs.make("pr-failure-gate-"), "summary.md");
      const outputs = {
        summary_json: JSON.stringify(summary),
        failures_json: JSON.stringify(failures),
      };
      expect(
        evaluateWorkflowExpression(`\${{ ${step.if} }}`, {
          ...context,
          failureReportOutputs: outputs,
        }),
      ).toBe(true);
      const result = spawnSync("/bin/bash", ["-c", step.run], {
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_STEP_SUMMARY: summaryPath,
          SUMMARY_JSON: outputs.summary_json,
          FAILURES_JSON: outputs.failures_json,
        },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(summaryPath, "utf8")).toBe(summary);
      expect(result.stdout).toContain(summary);
      expect(result.stdout).toContain(outputs.failures_json);
    },
  );
});
