import { writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
  expectExit,
  expectPriorCiRefusal,
  completedStep,
} from "./pr-merge-assertions.test-support.js";
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
  const job = state.priorCi.jobs![0]!;
  Object.assign(job, {
    conclusion: "cancelled",
    check_run_url: "https://api.github.com/repos/fixture/repo/check-runs/601",
    started_at: check.started_at,
    completed_at: check.completed_at,
    steps: [
      completedStep(1, "Set up job", "success"),
      completedStep(
        18,
        "Run Node test shard",
        "failure",
        "2026-09-20T00:00:50Z",
        "2026-09-20T00:05:26Z",
      ),
      completedStep(19, "Complete job", "success"),
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
  return { ...f, evidence, live: state, job, check, entry: evidence.failures[0]! };
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
    expectExit(f.adminPriorCi(f.path), 0);
    expect(f.state().mutations).toBe(1);
    expect(f.record()).toMatchObject({
      priorCiAdmin: {
        failures: [
          {
            jobId: 601,
            failedStep: { checkRunId: 601, conclusion: "cancelled", number: 18, workflowJob },
          },
        ],
        cancelledJobIds: [604],
      },
    });
    expect(f.record().priorCiAdmin.failures[0].deadline).toBeUndefined();
  });

  it("rechecks the live cancelled root after a main advance", () => {
    const f = cancelledRootCandidate();
    const state = f.state();
    state.graphqlMergeProjection = { mergeStateStatus: "UNKNOWN" };
    state.restObservations = [
      {},
      {},
      {},
      { advanceMain: true },
      {
        priorCi: {
          deadline: {
            ...state.priorCi.deadline,
            check: { ...state.priorCi.deadline.check, conclusion: "success" },
          },
        },
      },
    ];
    f.save(state);

    const result = f.adminPriorCi(f.path);

    expect(result.status, result.output).not.toBe(0);
    expect(result.output).toContain("Requalifying admin admission");
    expect(result.output).toContain("matching live GitHub Actions check-run");
    expect(f.state().mainAdvances).toHaveLength(1);
    expect(f.git(["cat-file", "-t", f.state().mainAdvances[0]!])).toBe("commit");
    expect(f.state()).toMatchObject({ mutations: 0, posts: 0 });
    expect(f.captures()).toEqual([]);
    expect(() => f.record()).toThrow();
  });

  const faults: Record<string, (f: ReturnType<typeof cancelledRootCandidate>) => unknown> = {
    ...Object.fromEntries(Object.keys(workflowVariants).map((name) => [name, () => {}])),
    "missing binding": ({ entry }) => Reflect.deleteProperty(entry, "failedStep"),
    "wrong workflow owner": ({ entry }) => (entry.failedStep.workflowJob = "security-fast"),
    "wrong step number": ({ entry }) => (entry.failedStep.number = 1),
    "missing independent proof": ({ entry }) => (entry.evidence = []),
    "changed source input": ({ entry }) => (entry.sourcePaths = ["owner.txt"]),
    "missing steps": ({ job }) => (job.steps = undefined),
    "duplicate step number": ({ job }) => (job.steps![2]!.number = 18),
    "duplicate test step": ({ job }) => (job.steps![0]!.name = "Run Node test shard"),
    "incomplete step": ({ job }) => (job.steps![0]!.status = "in_progress"),
    "cleanup failure": ({ job }) =>
      job.steps!.splice(2, 0, completedStep(20, "cleanup failure", "failure")),
    "cancelled test without deadline": ({ job }) => (job.steps![1]!.conclusion = "cancelled"),
    "missing cleanup": ({ job }) => job.steps!.pop(),
    "missing step timestamp": ({ job }) => delete job.steps![1]!.started_at,
    "step outside job": ({ job }) => (job.steps![1]!.completed_at = "2026-09-20T02:00:00Z"),
    "foreign check": ({ check }) => (check.id = 999),
    "foreign publisher": ({ check }) => (check.app.id = 999),
    "foreign suite": ({ check }) => (check.check_suite.id = 999),
    "stale check head": (f) => (f.check.head_sha = f.base),
    "changed conclusion": ({ check }) => (check.conclusion = "success"),
    "changed timestamp": ({ check }) => (check.completed_at = "2026-09-20T02:00:00Z"),
  };
  it.each(Object.entries(faults))("refuses %s before dispatch", (fault, mutate) => {
    const f = cancelledRootCandidate(workflowVariants[fault]);
    mutate(f);
    writeFileSync(f.path, JSON.stringify(f.evidence));
    f.save(f.live);
    expectPriorCiRefusal(
      f,
      workflowVariants[fault] ? "canonical Node shard workflow owner" : "Prior-CI admin admission:",
    );
  });
});
