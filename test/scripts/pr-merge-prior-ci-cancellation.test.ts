import { expect, it } from "vitest";
import { verifyPriorCiCancellation } from "../../scripts/pr-lib/merge-prior-ci-cancellation.mjs";

const attemptAwareFailFast =
  "${{ github.event_name == 'pull_request' && (github.run_attempt != 1 || github.repository != 'openclaw/openclaw') }}";

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
  ["same repository rerun", 2, "openclaw/openclaw", true],
  ["later same repository rerun", 3, "openclaw/openclaw", true],
  ["other repository first attempt", 1, "example/openclaw", true],
  ["same repository first attempt", 1, "openclaw/openclaw", false],
  ["case-insensitive repository", 1, "OpenClaw/OpenClaw", false],
  ["missing attempt", undefined, "example/openclaw", false],
  ["string attempt", "2", "example/openclaw", false],
  ["zero attempt", 0, "example/openclaw", false],
  ["fractional attempt", 1.5, "example/openclaw", false],
  ["missing repository", 2, undefined, false],
  ["empty repository", 2, "", false],
  ["malformed repository", 2, "openclaw", false],
  ["non-string repository", 2, 123, false],
] as const)(
  "qualifies the attempt-aware matrix contract: %s",
  (_name, attempt, repository, accepted) => {
    const invoke = () =>
      qualify({
        event: "pull_request",
        run_attempt: attempt,
        repository: { full_name: repository },
        head_repository: { full_name: "contributor/fork" },
      });
    if (accepted) {
      expect(invoke()).toMatchObject({ cancelledJobIds: [2] });
    } else {
      expect(invoke).toThrow(
        "the tested workflow must enable the existing PR matrix fail-fast contract",
      );
    }
  },
);

it.each([undefined, "push", "workflow_dispatch"])("refuses non-PR run context: %s", (event) => {
  expect(() =>
    qualify({ event, run_attempt: 2, repository: { full_name: "openclaw/openclaw" } }),
  ).toThrow("matrix cancellation requires the existing PR Node matrix owner");
});

it("refuses arbitrary expressions even when their run context would enable cancellation", () => {
  expect(() =>
    qualify(
      { event: "pull_request", run_attempt: 2, repository: { full_name: "openclaw/openclaw" } },
      "${{ github.run_attempt > 1 }}",
    ),
  ).toThrow("the tested workflow must enable the existing PR matrix fail-fast contract");
});

it.each([true, "${{ github.event_name == 'pull_request' }}"])(
  "preserves the legacy fail-fast contract without new context: %s",
  (expression) => {
    expect(qualify({ event: "pull_request" }, expression)).toMatchObject({ cancelledJobIds: [2] });
  },
);
