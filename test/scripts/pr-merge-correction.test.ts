import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import {
  expectExit,
  pendingGates,
  readLocal,
  writeLocal,
} from "./pr-merge-assertions.test-support.js";
import { createMergeOutcomeFixtureHarness } from "./pr-merge-outcome.test-support.js";
import { validReview, writeReviewArtifacts } from "./pr-review-artifact-fixture.js";

const { fixture, outcomeRef, describePosix, scripts, nodeExecutable, gitEnv } =
  createMergeOutcomeFixtureHarness();

type Fixture = ReturnType<typeof fixture>;
const localPath = (f: Fixture, name: string) => join(f.worktree, ".local", name);
function changeReviewHead(f: Fixture, head: string) {
  const review = JSON.parse(readLocal(f, "correction-review.json"));
  review.pr.headSha = head;
  writeLocal(f, "correction-review.json", JSON.stringify(review));
}
function publish(f: Fixture, head: string) {
  const refs = [`${head}:refs/pull/123/head`, `${head}:refs/heads/topic`];
  f.git(["push", "-q", "--force", "origin", ...refs]);
}

const incomingHead = (f: Fixture) => expectDefined(f.sourceCommits[0], "incoming fixture commit");
function configureCorrection(f: Fixture) {
  const incoming = incomingHead(f);
  const candidate = f.git(["rev-parse", "HEAD"], undefined, f.worktree);
  const review = validReview(incoming);
  review.pr.number = 123;
  review.issueValidation.status = "valid";
  review.findings.push({
    id: "I1",
    severity: "IMPORTANT",
    title: "Wrong behavior",
    area: "owner.txt",
    fix: "Correct behavior",
  });
  writeReviewArtifacts(f.worktree, review, {
    headSha: incoming,
    prNumber: 123,
    files: ["owner.txt"],
  });
  const jsonOid = f.git(
    ["hash-object", "--no-filters", ".local/review.json"],
    undefined,
    f.worktree,
  );
  writeLocal(
    f,
    "prep-context.env",
    `PR_NUMBER=123\nPR_HEAD=topic\nPR_HEAD_SHA_BEFORE=${incoming}\nPREP_BRANCH=pr-123-prep\nPREP_REVIEW_MODE=correction\nPREP_INCOMING_JSON_OID=${jsonOid}\n`,
  );
  execFileSync(
    nodeExecutable,
    [join(scripts, "pr-lib/correction-review.mjs"), "init", "123", incoming, candidate, jsonOid],
    { cwd: f.worktree, env: gitEnv },
  );
  writeLocal(
    f,
    "prep.env",
    readLocal(f, "prep.env") + `PR_HEAD=topic\nPR_HEAD_SHA_BEFORE=${incoming}\n`,
  );
  const correction = JSON.parse(readLocal(f, "correction-review.json"));
  Object.assign(correction, validReview(candidate));
  correction.pr.number = 123;
  correction.recommendation = "READY FOR /prepare-pr";
  correction.issueValidation.status = "valid";
  correction.correction.resolvedFindings[0].resolution = "Corrected behavior reviewed.";
  writeLocal(f, "correction-review.json", JSON.stringify(correction));
  writeLocal(
    f,
    "gates.env",
    `PR_NUMBER=123\nGATES_MODE=full\nLAST_VERIFIED_HEAD_SHA=${candidate}\nFULL_GATES_HEAD_SHA=${candidate}\n`,
  );
  return f;
}

function correctionFixture() {
  return configureCorrection(fixture(undefined, [["incoming bug\n"], ["corrected\n"]]));
}

describePosix("correction authority through native merge admission", () => {
  it.each([
    "correction-review.json",
    "prep-context.env",
    "gates.env",
    "final-review",
    "LOCAL_PREP_HEAD_SHA",
    "PREP_HEAD_SHA",
    "missing",
  ] as const)("refuses changed correction authority: %s", (fault) => {
    const f = correctionFixture();
    const receipt = fault === "LOCAL_PREP_HEAD_SHA" || fault === "PREP_HEAD_SHA";
    const direct = receipt || fault === "missing";
    if (receipt) {
      f.save({ ...f.state(), duringChecks: { receiptField: fault } });
    } else if (fault === "missing") {
      rmSync(localPath(f, "correction-review.json"));
    } else if (fault === "final-review") {
      f.save({ ...f.state(), tamperCorrectionAtFinalReview: true });
    } else {
      f.save({ ...f.state(), duringChecks: { artifact: fault } });
    }
    const result = direct ? f.verify() : f.run();
    expect(result.status, result.output).toBe(1);
    if (receipt || fault === "final-review") {
      expect(result.output).toContain("Correction review authority changed");
    }
    expect(f.state().mutations).toBe(0);
    if (!direct) {
      expect(() => f.record()).toThrow();
    }
  });

  it.each(["full", "github_pending"])(
    "accepts the verified GraphQL local/hosted correction pair with %s gates",
    (mode) => {
      const f = correctionFixture();
      const incoming = incomingHead(f);
      const hosted = f.commit(f.tree("corrected\n"), [incoming], "Hosted correction\n");
      publish(f, hosted);
      f.prepare(hosted, f.base, f.head);
      configureCorrection(f);
      const state = f.state();
      state.pr.headRefOid = hosted;
      if (mode === "github_pending") {
        pendingGates(f, hosted);
        state.requiredCheckName = "openclaw/ci-gate";
        state.gates = "pending";
      }
      f.save(state);
      const result = f.run(mode === "github_pending");
      expect(result.status, result.output).toBe(0);
      expect(f.state().mutations).toBe(1);
      expect(f.record()).toMatchObject({ localHead: f.head, head: hosted });
    },
  );

  it.each([
    "missing-auto",
    "missing-gate",
    "failed-check",
    "stale-gates",
    "stale-review",
    "final-review",
  ])("refuses deferred correction merge with %s", (fault) => {
    const f = correctionFixture();
    pendingGates(f, fault === "stale-gates" ? f.base : f.head);
    const state = f.state();
    state.requiredCheckName = fault === "missing-gate" ? "CI" : "openclaw/ci-gate";
    state.gates = fault === "failed-check" ? "fail" : "pending";
    if (fault === "final-review") {
      state.tamperCorrectionAtFinalReview = true;
    }
    f.save(state);
    if (fault === "stale-review") {
      changeReviewHead(f, f.base);
    }
    const result = f.run(fault !== "missing-auto");
    expect(result.status, result.output).toBe(1);
    expect(f.state().mutations).toBe(0);
    expect(() => f.record()).toThrow();
  });

  it.each([
    "none",
    "incoming digest",
    "foreign review",
    "stale gates",
    "pending gates",
    "wrong replacement",
  ])("handles explicit correction replacement with %s", (fault) => {
    const f = correctionFixture();
    f.save({ ...f.state(), mode: "unapplied" });
    expect(f.run().status).toBe(1);
    f.recover();
    const previous = f.git(["rev-parse", outcomeRef]);
    const replacement = f.commit(
      f.tree("replacement correction\n"),
      [f.head],
      "Reviewed replacement\n",
    );
    f.git(["-C", f.worktree, "checkout", "-B", "pr-123-prep", replacement]);
    publish(f, replacement);
    f.prepare(replacement);
    configureCorrection(f);
    f.save({ ...f.state(), mode: "success", pr: { ...f.state().pr, headRefOid: replacement } });
    if (fault === "incoming digest") {
      writeLocal(f, "review.json", readLocal(f, "review.json") + "\n");
    } else if (fault === "foreign review") {
      changeReviewHead(f, f.head);
    } else if (fault === "pending gates") {
      pendingGates(f, replacement);
    } else if (fault === "stale gates") {
      writeLocal(f, "gates.env", readLocal(f, "gates.env").replaceAll(replacement, f.head));
    }
    const result = f.run(
      false,
      f.repo,
      "squash",
      previous,
      fault === "wrong replacement" ? f.head : replacement,
    );
    expect(result.status, result.output).toBe(fault === "none" ? 0 : 1);
    expect(f.state().mutations).toBe(fault === "none" ? 2 : 1);
    if (fault !== "none") {
      expect(f.git(["rev-parse", outcomeRef])).toBe(previous);
    }
  });

  it("reconciles an accepted correction merge without disposable review files", () => {
    const f = correctionFixture();
    f.save({ ...f.state(), mode: "applied-merged" });
    expectExit(f.run());
    for (const name of ["correction-review.json", "review.json", "review.md"]) {
      rmSync(localPath(f, name), { force: true });
    }
    expectExit(f.run());
    expect(f.state().mutations).toBe(1);
  });
});
