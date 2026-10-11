import { expect, it } from "vitest";
import { verifyPriorCiCancellation } from "../../scripts/pr-lib/merge-prior-ci-cancellation.mjs";

const attemptAwareFailFast =
  "${{ github.event_name == 'pull_request' && (github.run_attempt != 1 || github.repository != 'openclaw/openclaw') }}";

const repositoryScopedFailFast =
  "${{ github.event_name == 'pull_request' && github.repository != 'openclaw/openclaw' }}";

function qualify(run: Record<string, unknown>, failFast: string | boolean = attemptAwareFailFast) {
  const failed = { id: 1, name: "failed", conclusion: "failure", steps: [] };
  const cancelled = { id: 2, name: "cancelled", conclusion: "cancelled", steps: [] };
  const workflow = {
    jobs: {
      "checks-node-core-test-nondist-shard": {
        name: "${{ matrix.check_name || 'checks-node-core-test-nondist-shard' }}",
        needs: ["preflight"],
        strategy: {
          "fail-fast": failFast,
          matrix: "${{ fromJson(needs.preflight.outputs.checks_node_core_nondist_matrix) }}",
        },
      },
    },
  };
  return verifyPriorCiCancellation({
    run,
    evidence: {
      priorHead: "baseline",
      testedMerge: "merge",
      cancellation: {
        kind: "matrix-fail-fast",
        workflowJob: "checks-node-core-test-nondist-shard",
        jobIds: [2],
        causedBy: [1],
        members: [failed, cancelled].map(({ id, name }) => ({ jobId: id, name })),
      },
    },
    jobs: [failed, cancelled],
    failed: [failed],
    gate: undefined,
    causedByRoots: () => true,
    references: () => true,
    git: ([command]: string[]) =>
      Buffer.from(command === "rev-parse" ? "a".repeat(40) : JSON.stringify(workflow)),
    requireEvidence: (condition: unknown, message: string) => {
      if (!condition) {
        throw new Error(message);
      }
    },
  });
}

it.each([
  ["historical canonical rerun", attemptAwareFailFast, 2, "openclaw/openclaw", true],
  ["scoped canonical rerun", repositoryScopedFailFast, 2, "OpenClaw/OpenClaw", false],
  ["historical canonical first attempt", attemptAwareFailFast, 1, "OpenClaw/OpenClaw", false],
  ["historical fork first attempt", attemptAwareFailFast, 1, "example/openclaw", true],
  ["scoped fork first attempt", repositoryScopedFailFast, 1, "example/openclaw", true],
  ["missing attempt", attemptAwareFailFast, undefined, "example/openclaw", false],
  ["zero attempt", attemptAwareFailFast, 0, "example/openclaw", false],
  ["missing repository", attemptAwareFailFast, 2, undefined, false],
  ["malformed repository", attemptAwareFailFast, 2, "openclaw", false],
  ["arbitrary expression", "${{ github.run_attempt > 1 }}", 2, "openclaw/openclaw", false],
] as const)("qualifies %s", (_name, expression, attempt, repository, accepted) => {
  const invoke = () =>
    qualify(
      {
        event: "pull_request",
        run_attempt: attempt,
        repository: { full_name: repository },
        head_repository: { full_name: "contributor/fork" },
      },
      expression,
    );
  if (accepted) {
    expect(invoke()).toMatchObject({ cancelledJobIds: [2] });
  } else {
    expect(invoke).toThrow(
      "the tested workflow must enable the existing PR matrix fail-fast contract",
    );
  }
});

it("refuses non-PR matrix cancellation", () => {
  expect(() =>
    qualify({
      event: "push",
      run_attempt: 2,
      repository: { full_name: "example/openclaw" },
    }),
  ).toThrow("matrix cancellation requires the existing PR Node matrix owner");
});

it.each([true, "${{ github.event_name == 'pull_request' }}"])(
  "preserves the legacy fail-fast contract without new context: %s",
  (expression) => {
    expect(qualify({ event: "pull_request" }, expression)).toMatchObject({ cancelledJobIds: [2] });
  },
);
