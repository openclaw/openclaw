import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createMergeOutcomeFixtureHarness } from "./pr-merge-outcome.test-support.js";

const { fixture, outcomeRef, describePosix } = createMergeOutcomeFixtureHarness();

function qualifiedAutoRefusal(f: ReturnType<typeof fixture>, diagnostic = false) {
  const diagnosticCapture =
    "octopool: merge_diagnostics attempt_utc=2026-09-21T12:00:00Z elapsed_ms=1 child_started=false outcome=preparation_failed headers=unavailable\nerror: string rewrite protection blocked unsafe input\n";
  f.save({
    ...f.state(),
    mode: "octopool-refusal",
    refusalCapture: diagnostic ? diagnosticCapture : f.state().refusalCapture,
    pr: { ...f.state().pr, mergeStateStatus: "BEHIND" },
  });
  const refused = f.run(true);
  expect(refused.status, refused.output).toBe(1);
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
    ...(diagnostic
      ? { kind: "octopool-merge-diagnostics", producer: "octopool", diagnosticsEnabled: true }
      : {
          kind: "octopool-0.6.10-auto-refusal",
          version: "0.6.10",
          sourceRevision: "00c442d8084ad26eb5a5003f7372170e75a20c8a",
          parserSha256: "f6ff8cd7e59503f71f94fefd561b671193df11b3aac9ba0986a0dc3ba91ca32b",
          args: [
            "pr",
            "merge",
            "123",
            "--repo",
            "https://github.com/fixture/repo",
            "--squash",
            "--auto",
            "--match-head-commit",
            f.head,
            "--body-file",
            ".local/merge-body.fixture",
          ],
        }),
  };
  writeFileSync(join(directory, "qualification.json"), JSON.stringify(qualification));
  f.recover();
  f.save({ ...f.state(), mode: "success", pr: { ...f.state().pr, mergeStateStatus: "CLEAN" } });
  return { outcome, directory, capture, qualification };
}

describePosix("qualified pre-dispatch merge recovery", () => {
  it("recovers a qualified pre-dispatch refusal with retained evidence", () => {
    const f = fixture();
    const proof = qualifiedAutoRefusal(f);
    const replacement = f.replacePreparedHead();
    writeFileSync(
      join(f.worktree, ".local/gates.env"),
      `PR_NUMBER=123\nGATES_MODE=github_pending\nHOSTED_GATES_TARGET_HEAD_SHA=${replacement}\n`,
    );
    f.save({ ...f.state(), requiredCheckName: "openclaw/ci-gate" });
    const run = f.run(
      false,
      f.repo,
      "squash",
      proof.outcome,
      replacement,
      "",
      "",
      "",
      false,
      proof.directory,
    );
    expect(run.status, run.output).toBe(0);
    expect(f.state().mutations).toBe(1);
    expect(f.record()).toMatchObject({
      phase: "complete",
      head: replacement,
      route: "immediate",
      recovery: {
        outcome: proof.outcome,
        replacementHead: replacement,
        preDispatchRefusal: { kind: proof.qualification.kind, capture: proof.capture },
      },
    });
    f.git(["merge-base", "--is-ancestor", proof.outcome, outcomeRef]);
    expect(f.git(["rev-parse", `${outcomeRef}:pre-dispatch-refusal/${proof.capture}`])).toBe(
      proof.qualification.capture,
    );
    expect(f.run().status).toBe(0);
    expect(f.state().mutations).toBe(1);
    const replay = f.run(
      false,
      f.repo,
      "squash",
      proof.outcome,
      replacement,
      "",
      "",
      "",
      false,
      proof.directory,
    );
    expect(replay.status, replay.output).toBe(1);
    expect(f.state().mutations).toBe(1);
  });

  it("preserves a pre-dispatch outcome across incomplete checks and ineligible admission", () => {
    const f = fixture();
    const proof = qualifiedAutoRefusal(f);
    const replacement = f.replacePreparedHead();
    writeFileSync(
      join(f.worktree, ".local/gates.env"),
      `PR_NUMBER=123\nGATES_MODE=github_pending\nHOSTED_GATES_TARGET_HEAD_SHA=${replacement}\n`,
    );
    const ready = f.state();
    for (const fault of ["pending", "failed", "existing-auto", "behind"]) {
      const next = { ...ready, pr: { ...ready.pr }, requiredCheckName: "openclaw/ci-gate" };
      if (fault === "pending") {
        next.gates = "pending";
      }
      if (fault === "failed") {
        next.gates = "fail";
      }
      if (fault === "existing-auto") {
        next.pr.autoMergeRequest = { mergeMethod: "SQUASH" };
      }
      if (fault === "behind") {
        next.pr.mergeStateStatus = "BEHIND";
      }
      f.save(next);
      const run = f.run(
        false,
        f.repo,
        "squash",
        proof.outcome,
        replacement,
        "",
        "",
        "",
        false,
        proof.directory,
      );
      expect(run.status, `${fault}: ${run.output}`).toBe(1);
      expect(f.state().mutations).toBe(0);
      expect(f.git(["rev-parse", outcomeRef])).toBe(proof.outcome);
      expect(existsSync(f.worktree)).toBe(true);
      f.recover();
    }
  });
});
