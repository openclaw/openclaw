import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  configureMerge,
  expectCapturedFiles,
  expectExit,
  expectRetained,
  pendingGates,
  readLocal,
  writeLocal,
} from "./pr-merge-assertions.test-support.js";
import { createMergeOutcomeFixtureHarness } from "./pr-merge-outcome.test-support.js";
import {
  policyTimeoutCapture,
  policyTimeoutQualification,
} from "./pr-merge-policy-timeout.test-support.js";

const { fixture, outcomeRef, describePosix } = createMergeOutcomeFixtureHarness();

function qualifiedAutoRefusal(
  f: ReturnType<typeof fixture>,
  version: "0.6.10" | "policy-timeout" = "0.6.10",
) {
  configureMerge(f, {
    mode: "octopool-refusal",
    refusalCapture: version === "policy-timeout" ? policyTimeoutCapture : f.state().refusalCapture,
    pr: { mergeStateStatus: "BEHIND" },
  });
  expectExit(f.run(true), 1);
  expect(f.state().mutations).toBe(0);
  const outcome = f.git(["rev-parse", outcomeRef]);
  const [capture, contents] = f.captures()[0]!;
  const directory = join(f.repo, "qualified-refusal");
  mkdirSync(directory);
  writeFileSync(join(directory, capture), contents);
  const qualification = {
    outcome,
    capture: f.git(["hash-object", "--stdin"], contents),
    inspected: true,
    ...(version === "policy-timeout"
      ? policyTimeoutQualification
      : {
          kind: "octopool-0.6.10-auto-refusal",
          version,
          sourceRevision: "00c442d8084ad26eb5a5003f7372170e75a20c8a",
          parserSha256: "f6ff8cd7e59503f71f94fefd561b671193df11b3aac9ba0986a0dc3ba91ca32b",
          args: `pr merge 123 --repo https://github.com/fixture/repo --squash --auto --match-head-commit ${f.head} --body-file .local/merge-body.fixture`.split(
            " ",
          ),
        }),
  };
  writeFileSync(join(directory, "qualification.json"), JSON.stringify(qualification));
  f.recover();
  configureMerge(f, { mode: "success", pr: { mergeStateStatus: "CLEAN" } });
  return {
    outcome,
    capture,
    qualification,
    runRecovery: (replacement = "") =>
      f.run(false, f.repo, "squash", outcome, replacement, "", "", "", false, directory),
  };
}

describePosix("qualified pre-dispatch merge recovery", () => {
  it.each([
    { version: "0.6.10", replaceHead: false },
    { version: "policy-timeout", replaceHead: true },
  ] as const)(
    "recovers a qualified $version pre-dispatch refusal with retained evidence (replacement=$replaceHead)",
    ({ version, replaceHead }) => {
      const f = fixture();
      const proof = qualifiedAutoRefusal(f, version);
      const replacement = replaceHead ? f.replacePreparedHead() : "";
      const preparedHead = replacement || f.head;
      pendingGates(f, preparedHead);
      configureMerge(f, { requiredCheckName: "openclaw/ci-gate" });
      expectExit(proof.runRecovery(replacement));
      expect(f.state().mutations).toBe(1);
      expect(f.record()).toMatchObject({
        phase: "complete",
        head: preparedHead,
        route: "immediate",
        recovery: {
          outcome: proof.outcome,
          ...(replacement ? { replacementHead: replacement } : {}),
          preDispatchRefusal: { kind: proof.qualification.kind, capture: proof.capture },
        },
      });
      if (!replacement) {
        expect(f.record().recovery).not.toHaveProperty("replacementHead");
      }
      f.git(["merge-base", "--is-ancestor", proof.outcome, outcomeRef]);
      expect(f.git(["rev-parse", `${outcomeRef}:pre-dispatch-refusal/${proof.capture}`])).toBe(
        proof.qualification.capture,
      );
      expectCapturedFiles(
        f,
        [["pre-dispatch-refusal/qualification.json", JSON.stringify(proof.qualification)]],
        outcomeRef,
      );
      expect(f.run().status).toBe(0);
      expect(f.state().mutations).toBe(1);
      expectExit(proof.runRecovery(replacement), 1);
      expect(f.state().mutations).toBe(1);
    },
  );

  it.each([
    "stale-prep-context",
    "stale-gate-head",
    "review-during-checks",
    "prepared-head-during-checks",
  ])("same-head qualified refusal recovery rejects invalidated local evidence: %s", (fault) => {
    const f = fixture();
    const proof = qualifiedAutoRefusal(f);
    const captures = f.captures();
    const next = f.state();
    let changedReview = "";
    let movedHead = "";
    if (fault === "stale-prep-context" || fault === "stale-gate-head") {
      const file = fault === "stale-prep-context" ? "prep-context.env" : "gates.env";
      writeLocal(f, file, readLocal(f, file).replace(f.head, f.base));
    }
    if (fault === "review-during-checks") {
      const review = JSON.parse(readLocal(f, "review.json"));
      changedReview = `${JSON.stringify({ ...review, recommendation: "NEEDS WORK" })}\n`;
      next.duringChecks = { artifact: "review.json", artifactContents: changedReview };
    }
    if (fault === "prepared-head-during-checks") {
      movedHead = f.commit(
        f.git(["rev-parse", `${f.head}^{tree}`]),
        [f.head],
        "Local preparation advanced during admission\n",
      );
      next.duringChecks = { preparedHead: movedHead };
    }
    f.save(next);
    const run = proof.runRecovery();
    expect(run.error, run.output).toBeUndefined();
    expectExit(run, 1);
    expect(f.state()).toMatchObject({ mutations: 0, posts: 0 });
    expectRetained(f, proof.outcome, captures);
    if (changedReview) {
      expect(readLocal(f, "review.json")).toBe(changedReview);
    }
    if (movedHead) {
      expect(f.git(["rev-parse", "refs/heads/pr-123-prep"])).toBe(movedHead);
      expect(f.state().pr.headRefOid).toBe(f.head);
    }
  });

  it("preserves a pre-dispatch outcome across incomplete checks and ineligible admission", () => {
    const f = fixture();
    const proof = qualifiedAutoRefusal(f, "policy-timeout");
    const replacement = f.replacePreparedHead();
    pendingGates(f, replacement);
    const ready = f.state();
    const faults: Array<Parameters<typeof configureMerge>[1]> = [
      { gates: "pending" },
      { gates: "fail" },
      { pr: { autoMergeRequest: { mergeMethod: "SQUASH" } } },
      { pr: { mergeStateStatus: "BEHIND" } },
    ];
    for (const fault of faults) {
      f.save(ready);
      configureMerge(f, { requiredCheckName: "openclaw/ci-gate", ...fault });
      const run = proof.runRecovery(replacement);
      expect(run.status, `${JSON.stringify(fault)}: ${run.output}`).toBe(1);
      expect(f.state().mutations).toBe(0);
      expect(f.git(["rev-parse", outcomeRef])).toBe(proof.outcome);
      expect(existsSync(f.worktree)).toBe(true);
      f.recover();
    }
  });
});
