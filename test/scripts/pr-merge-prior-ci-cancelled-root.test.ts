import { writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { createMergeOutcomeFixtureHarness } from "./pr-merge-outcome.test-support.js";
import { createPriorCiCandidateFactory } from "./pr-merge-prior-ci.test-support.js";

const { describePosix, fixture } = createMergeOutcomeFixtureHarness();
const { preExistingCandidate } = createPriorCiCandidateFactory(fixture);
const workflowJob = "checks-node-core-test-nondist-shard";
const workflow = `jobs:
  ${workflowJob}:
    name: \${{ matrix.check_name || 'checks-node-core-test-nondist-shard' }}
    needs: [preflight]
    strategy:
      matrix: \${{ fromJson(needs.preflight.outputs.checks_node_core_nondist_matrix) }}
    steps:
      - name: Run Node test shard
        shell: bash
        run: |
          set -euo pipefail
          runner="scripts/ci-run-node-test-shard.mts"
          if [[ ! -f "$runner" ]]; then
            runner=".ci-workflow/\${runner}"
            [[ -f "$runner" ]]
          fi
          time -p node --import tsx "$runner"
`;

function cancelledRootCandidate(source = workflow) {
  const f = preExistingCandidate(source);
  const state = f.state();
  const check = state.priorCi.deadline.check;
  check.head_sha = f.head;
  check.completed_at = "2026-09-20T00:05:30Z";
  Object.assign(state.priorCi.jobs![0]!, {
    conclusion: "cancelled",
    check_run_url: "https://api.github.com/repos/fixture/repo/check-runs/601",
    started_at: check.started_at,
    completed_at: check.completed_at,
    steps: [
      { number: 1, name: "Set up job", status: "completed", conclusion: "success" },
      {
        number: 18,
        name: "Run Node test shard",
        status: "completed",
        conclusion: "failure",
        started_at: "2026-09-20T00:00:50Z",
        completed_at: "2026-09-20T00:05:26Z",
      },
      { number: 19, name: "Complete job", status: "completed", conclusion: "success" },
    ],
  });
  f.save(state);
  const evidence = {
    ...f.evidence,
    failures: f.evidence.failures.map((entry) => ({
      ...entry,
      failedStep: { number: 18, workflowJob },
    })),
  };
  writeFileSync(f.path, JSON.stringify(evidence));
  return { ...f, evidence };
}

const workflowVariants: Record<string, string> = {
  "different runner": workflow.replace('time -p node --import tsx "$runner"', "exit 1"),
  "ignored job failures": workflow.replace("    needs:", "    continue-on-error: true\n    needs:"),
  "ignored test failures": workflow.replace(
    "        shell:",
    "        continue-on-error: true\n        shell:",
  ),
  "unbound matrix": workflow.replace("checks_node_core_nondist_matrix", "another_matrix"),
};

describePosix("attributed test failure in a cancelled job", () => {
  it("retains a cancelled Node test root separately from unrun collateral", () => {
    const f = cancelledRootCandidate();
    const result = f.adminPriorCi(f.path);
    expect(result.status, result.output).toBe(0);
    expect(f.state().mutations).toBe(1);
    expect(f.record().priorCiAdmin.failures).toMatchObject([
      {
        jobId: 601,
        failedStep: { checkRunId: 601, conclusion: "cancelled", number: 18, workflowJob },
      },
    ]);
    expect(f.record().priorCiAdmin.failures[0].deadline).toBeUndefined();
    expect(f.record().priorCiAdmin.cancelledJobIds).toEqual([604]);
  });

  it.each([
    ...Object.keys(workflowVariants),
    "missing binding",
    "wrong workflow owner",
    "wrong step number",
    "missing steps",
    "duplicate step number",
    "duplicate test step",
    "incomplete step",
    "cleanup failure",
    "cancelled test without deadline",
    "missing cleanup",
    "missing step timestamp",
    "step outside job",
    "foreign check",
    "foreign publisher",
    "foreign suite",
    "stale check head",
    "changed conclusion",
    "changed timestamp",
    "missing independent proof",
    "changed source input",
  ])("refuses %s before dispatch", (fault) => {
    const f = cancelledRootCandidate(workflowVariants[fault]);
    const state = f.state();
    const job = state.priorCi.jobs![0]!;
    const check = state.priorCi.deadline.check;
    const evidence = f.evidence;
    const entry = evidence.failures[0]!;
    if (fault === "missing binding") {
      const { failedStep: _failedStep, ...unbound } = entry;
      writeFileSync(f.path, JSON.stringify({ ...evidence, failures: [unbound] }));
    } else {
      if (fault === "wrong workflow owner") {
        entry.failedStep.workflowJob = "security-fast";
      }
      if (fault === "wrong step number") {
        entry.failedStep.number = 1;
      }
      if (fault === "missing independent proof") {
        entry.evidence = [];
      }
      if (fault === "changed source input") {
        entry.sourcePaths = ["owner.txt"];
      }
      writeFileSync(f.path, JSON.stringify(evidence));
    }
    if (fault === "missing steps") {
      job.steps = undefined;
    }
    if (fault === "duplicate step number") {
      job.steps![2]!.number = 18;
    }
    if (fault === "duplicate test step") {
      job.steps![0]!.name = "Run Node test shard";
    }
    if (fault === "incomplete step") {
      job.steps![0]!.status = "in_progress";
    }
    if (fault === "cleanup failure") {
      job.steps!.splice(2, 0, {
        number: 20,
        name: fault,
        status: "completed",
        conclusion: "failure",
      });
    }
    if (fault === "cancelled test without deadline") {
      job.steps![1]!.conclusion = "cancelled";
    }
    if (fault === "missing cleanup") {
      job.steps!.pop();
    }
    if (fault === "missing step timestamp") {
      delete job.steps![1]!.started_at;
    }
    if (fault === "step outside job") {
      job.steps![1]!.completed_at = "2026-09-20T02:00:00Z";
    }
    if (fault === "foreign check") {
      check.id = 999;
    }
    if (fault === "foreign publisher") {
      check.app.id = 999;
    }
    if (fault === "foreign suite") {
      check.check_suite.id = 999;
    }
    if (fault === "stale check head") {
      check.head_sha = f.base;
    }
    if (fault === "changed conclusion") {
      check.conclusion = "success";
    }
    if (fault === "changed timestamp") {
      check.completed_at = "2026-09-20T02:00:00Z";
    }
    f.save(state);
    const result = f.verifyPriorCi(f.path);
    expect(result.status, result.output).not.toBe(0);
    expect(result.output).toContain(
      workflowVariants[fault] ? "canonical Node shard workflow owner" : "Prior-CI admin admission:",
    );
    expect(f.state().mutations).toBe(0);
  });
});
