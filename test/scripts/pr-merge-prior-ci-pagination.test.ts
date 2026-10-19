import { expect, it } from "vitest";
import { createMergeOutcomeFixtureHarness } from "./pr-merge-outcome.test-support.js";
import { createPriorCiCandidateFactory } from "./pr-merge-prior-ci.test-support.js";

const { describePosix, fixture } = createMergeOutcomeFixtureHarness();
const { preExistingCandidate } = createPriorCiCandidateFactory(fixture);

describePosix("prior-CI attempt pagination", () => {
  it.each([
    ["complete", undefined],
    ["truncated", "prior CI job evidence is incomplete"],
    ["duplicate", "all current-attempt jobs must have complete, matching terminal identities"],
    ["inconsistent-total", "prior CI job evidence is incomplete"],
    ["nonterminal", "all current-attempt jobs must have complete, matching terminal identities"],
  ] as const)("accounts for a 205-job attempt: %s", (fault, message) => {
    const f = preExistingCandidate();
    const state = f.state();
    // The required gate, security job, and attributed failure arrive on page 11.
    state.priorCi.jobs = [
      ...Array.from({ length: 200 }, (_, index) => ({
        id: 1000 + index,
        name: `passing-job-${index}`,
        status: "completed",
        conclusion: "success",
        run_id: 501,
        head_sha: f.head,
      })),
      ...state.priorCi.jobs!,
    ];
    state.priorCi.jobPageFault = fault;
    if (fault === "nonterminal") {
      state.priorCi.jobs[200]!.status = "in_progress";
    }
    f.save(state);

    const result = f.verifyPriorCi(f.path);
    if (message === undefined) {
      expect(result.status, result.output).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        failures: [{ jobId: 601 }],
        cancelledJobIds: [604],
        gateCheckRunId: 1,
      });
    } else {
      expect(result.status, result.output).not.toBe(0);
      expect(result.output).toContain(message);
    }
    expect(f.state().mutations).toBe(0);
    expect(
      f.git(["for-each-ref", "--format=%(refname)", "refs/openclaw/pr-merge-outcomes/123"]),
    ).toBe("");
  });
});
