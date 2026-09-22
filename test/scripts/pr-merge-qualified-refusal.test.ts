import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createMergeOutcomeFixtureHarness } from "./pr-merge-outcome.test-support.js";
import {
  policyTimeoutCapture,
  policyTimeoutQualification,
} from "./pr-merge-policy-timeout.test-support.js";

const { fixture, outcomeRef, describePosix } = createMergeOutcomeFixtureHarness();

const historicalRefusals = {
  "0.6.10": {
    kind: "octopool-0.6.10-auto-refusal",
    version: "0.6.10",
    sourceRevision: "00c442d8084ad26eb5a5003f7372170e75a20c8a",
    parserSha256: "f6ff8cd7e59503f71f94fefd561b671193df11b3aac9ba0986a0dc3ba91ca32b",
  },
  "0.7.1": {
    kind: "octopool-0.7.1-missing-subject-refusal",
    version: "0.7.1",
    sourceRevision: "7ab9b348c99a7be4fdc82c75cb06ebce44e0007e",
    parserSha256: "b32cb960537f5ffa1336a7689674afba9b4a2485b05e449acd2684a251ff8970",
  },
} as const;

function qualifiedAutoRefusal(
  f: ReturnType<typeof fixture>,
  version: keyof typeof historicalRefusals | "policy-timeout" = "0.6.10",
) {
  f.save({
    ...f.state(),
    mode: "octopool-refusal",
    refusalCapture: version === "policy-timeout" ? policyTimeoutCapture : f.state().refusalCapture,
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
    ...(version === "policy-timeout"
      ? policyTimeoutQualification
      : {
          ...historicalRefusals[version],
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
  it.each([
    { version: "0.6.10", replaceHead: false },
    { version: "0.6.10", replaceHead: true },
    { version: "0.7.1", replaceHead: true },
    { version: "policy-timeout", replaceHead: true },
  ] as const)(
    "recovers a qualified $version pre-dispatch refusal with retained evidence (replacement=$replaceHead)",
    ({ version, replaceHead }) => {
      const f = fixture();
      const proof = qualifiedAutoRefusal(f, version);
      const replacement = replaceHead ? f.replacePreparedHead() : "";
      const preparedHead = replacement || f.head;
      writeFileSync(
        join(f.worktree, ".local/gates.env"),
        `PR_NUMBER=123\nGATES_MODE=github_pending\nHOSTED_GATES_TARGET_HEAD_SHA=${preparedHead}\n`,
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
      expect(f.git(["rev-parse", `${outcomeRef}:pre-dispatch-refusal/qualification.json`])).toBe(
        f.git(["hash-object", "--stdin"], JSON.stringify(proof.qualification)),
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
      const file = join(
        f.worktree,
        ".local",
        fault === "stale-prep-context" ? "prep-context.env" : "gates.env",
      );
      writeFileSync(file, readFileSync(file, "utf8").replace(f.head, f.base));
    }
    if (fault === "review-during-checks") {
      const review = JSON.parse(readFileSync(join(f.worktree, ".local/review.json"), "utf8"));
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
    const run = f.run(
      false,
      f.repo,
      "squash",
      proof.outcome,
      "",
      "",
      "",
      "",
      false,
      proof.directory,
    );
    expect(run.error, run.output).toBeUndefined();
    expect(run.status, run.output).toBe(1);
    expect(f.state()).toMatchObject({ mutations: 0, posts: 0 });
    expect(f.git(["rev-parse", outcomeRef])).toBe(proof.outcome);
    expect(f.captures()).toEqual(captures);
    if (changedReview) {
      expect(readFileSync(join(f.worktree, ".local/review.json"), "utf8")).toBe(changedReview);
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
