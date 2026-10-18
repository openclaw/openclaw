import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createMergeOutcomeFixtureHarness } from "./pr-merge-outcome.test-support.js";
import { createPriorCiCandidateFactory } from "./pr-merge-prior-ci.test-support.js";

const { fixture, outcomeRef, describePosix } = createMergeOutcomeFixtureHarness();
const { preExistingCandidate } = createPriorCiCandidateFactory(fixture);

function largeCandidate() {
  const f = preExistingCandidate();
  // A real verifier proof exceeded 646 KB. Keep every byte, well beyond Linux's
  // 128 KiB per-argument limit, without creating thousands of fixture files.
  f.evidence.reason = "Inspected baseline evidence\n".repeat(24_000);
  writeFileSync(f.path, JSON.stringify(f.evidence));
  return f;
}

describePosix("complete prior-CI proof transport", () => {
  it("retains a large verified proof through rejected dispatch, recovery and completion", () => {
    const f = largeCandidate();
    const verified = f.verifyPriorCi(f.path);
    expect(verified.status, verified.output).toBe(0);
    expect(Buffer.byteLength(verified.stdout)).toBeGreaterThan(646_315);
    const proof = JSON.parse(verified.stdout);
    const refusal = readFileSync(
      new URL("../fixtures/pr-admin-base-modified-405.txt", import.meta.url),
      "utf8",
    );
    f.save({ ...f.state(), restMergeRefusal: refusal });
    const rejected = f.adminPriorCi(f.path);
    expect(rejected.status, rejected.output).toBe(1);
    expect(f.record()).toMatchObject({ phase: "intent", accepted: false });
    expect(f.record().priorCiAdmin).toEqual(proof);
    const outcome = f.git(["rev-parse", outcomeRef]);
    const original = f.record();
    const capture = `merge-output.${original.attempt}.log`;
    expect(readFileSync(join(f.worktree, ".local", capture), "utf8")).toBe(refusal);
    expect(f.recover()).toBe(false);

    f.save({ ...f.state(), restMergeRefusal: "" });
    const recovered = f.adminPriorCi(f.path, true, outcome);
    expect(recovered.status, recovered.output).toBe(0);
    expect(f.record()).toMatchObject({ phase: "complete", accepted: true });
    expect(f.record().priorCiAdmin).toEqual(proof);
    expect(JSON.parse(f.git(["show", `${outcome}:outcome.json`]))).toEqual(original);
    expect(f.git(["rev-parse", `${outcomeRef}:${capture}`])).toBe(
      f.git(["hash-object", "--stdin"], refusal),
    );
    expect(f.state()).toMatchObject({ mutations: 2, posts: 1 });
  });

  it.each(["review attribution", "evidence mutation", "security"])(
    "rejects %s without retaining an intent or dispatching with a large proof",
    (fault) => {
      const f = largeCandidate();
      const state = f.state();
      if (fault === "review attribution") {
        const path = join(f.worktree, ".local/review.json");
        const review = JSON.parse(readFileSync(path, "utf8"));
        review.tests.preExistingCi.runId++;
        writeFileSync(path, JSON.stringify(review));
      } else if (fault === "evidence mutation") {
        state.priorCi.mutateEvidence = true;
      } else {
        state.priorCi.otherCheck = "Security Review";
      }
      f.save(state);
      const result = f.adminPriorCi(f.path);
      expect(result.status, result.output).toBe(1);
      expect(result.output).toContain(
        fault === "review attribution"
          ? "matching failed-run attribution"
          : fault === "evidence mutation"
            ? "operator evidence changed"
            : "fail\tSecurity Review\tFAILURE",
      );
      expect(result.output).not.toContain("Argument list too long");
      expect(f.state()).toMatchObject({ mutations: 0, posts: 0 });
      expect(f.git(["for-each-ref", "--format=%(refname)", outcomeRef])).toBe("");
    },
  );
});
