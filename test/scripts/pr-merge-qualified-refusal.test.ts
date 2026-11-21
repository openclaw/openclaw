import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  configureMerge,
  expectCapturedFiles,
  expectExit,
  pendingGates,
} from "./pr-merge-assertions.test-support.js";
import { createMergeOutcomeFixtureHarness } from "./pr-merge-outcome.test-support.js";
import {
  policyTimeoutCapture,
  policyTimeoutQualification,
} from "./pr-merge-policy-timeout.test-support.js";

const { fixture, outcomeRef, describePosix } = createMergeOutcomeFixtureHarness();

function qualifiedAutoRefusal(f: ReturnType<typeof fixture>) {
  configureMerge(f, {
    mode: "octopool-refusal",
    refusalCapture: policyTimeoutCapture,
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
    ...policyTimeoutQualification,
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
  it.each([false, true])(
    "recovers a qualified pre-dispatch refusal with retained evidence (replacement=%s)",
    (replaceHead) => {
      const f = fixture();
      const proof = qualifiedAutoRefusal(f);
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

  it("preserves a pre-dispatch outcome when immediate admission is ineligible", () => {
    const f = fixture();
    const proof = qualifiedAutoRefusal(f);
    const replacement = f.replacePreparedHead();
    pendingGates(f, replacement);
    const ready = f.state();
    const faults: Array<Parameters<typeof configureMerge>[1]> = [
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
