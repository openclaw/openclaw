import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createMergeOutcomeFixtureHarness } from "./pr-merge-outcome.test-support.js";
import { validReview, writeReviewArtifacts } from "./pr-review-artifact-fixture.js";

const { fixture, outcomeRef, describePosix, scripts, nodeExecutable, gitEnv } =
  createMergeOutcomeFixtureHarness();

function configureCorrection(f: ReturnType<typeof fixture>) {
  const incoming = f.sourceCommits[0];
  if (!incoming) {
    throw new Error("Missing incoming fixture commit");
  }
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
  writeFileSync(
    join(f.worktree, ".local/prep-context.env"),
    `PR_NUMBER=123\nPR_HEAD_SHA_BEFORE=${incoming}\nPREP_BRANCH=pr-123-prep\nPREP_REVIEW_MODE=correction\nPREP_INCOMING_JSON_OID=${jsonOid}\n`,
  );
  execFileSync(
    nodeExecutable,
    [join(scripts, "pr-lib/correction-review.mjs"), "init", "123", incoming, candidate, jsonOid],
    { cwd: f.worktree, env: gitEnv },
  );
  const reviewPath = join(f.worktree, ".local/correction-review.json");
  const correction = JSON.parse(readFileSync(reviewPath, "utf8"));
  Object.assign(correction, validReview(candidate));
  correction.pr.number = 123;
  correction.recommendation = "READY FOR /prepare-pr";
  correction.issueValidation.status = "valid";
  correction.correction.resolvedFindings[0].resolution = "Corrected behavior reviewed.";
  writeFileSync(reviewPath, JSON.stringify(correction));
  writeFileSync(
    join(f.worktree, ".local/gates.env"),
    `PR_NUMBER=123\nGATES_MODE=full\nLAST_VERIFIED_HEAD_SHA=${candidate}\nFULL_GATES_HEAD_SHA=${candidate}\n`,
  );
  return f;
}

function correctionFixture() {
  return configureCorrection(fixture(undefined, [["incoming bug\n"], ["corrected\n"]]));
}

describePosix("correction authority through native merge admission", () => {
  it("merges an exactly reviewed and qualified correction while retaining original NEEDS WORK", () => {
    const f = correctionFixture();
    const result = f.run();
    expect(result.status, result.output).toBe(0);
    expect(f.state().mutations).toBe(1);
  });
  it.each(["correction-review.json", "prep-context.env", "gates.env", "prep.env", "pr-meta.env"])(
    "refuses changed %s after CI checks and before intent",
    (artifact) => {
      const f = correctionFixture();
      f.save({ ...f.state(), duringChecks: { artifact } });
      const result = f.run();
      expect(result.status, result.output).toBe(1);
      expect(f.state().mutations).toBe(0);
      expect(() => f.record()).toThrow();
    },
  );
  it("refuses correction approval changed during final remote review admission", () => {
    const f = correctionFixture();
    f.save({ ...f.state(), tamperCorrectionAtFinalReview: true });
    const result = f.run();
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain("Correction review authority changed");
    expect(f.state().mutations).toBe(0);
    expect(() => f.record()).toThrow();
  });

  it("accepts the verified GraphQL local/hosted correction pair", () => {
    const f = correctionFixture();
    const incoming = f.sourceCommits[0];
    if (!incoming) {
      throw new Error("Missing incoming fixture commit");
    }
    const hosted = f.commit(f.tree("corrected\n"), [incoming], "Hosted correction\n");
    f.git([
      "push",
      "-q",
      "--force",
      "origin",
      `${hosted}:refs/pull/123/head`,
      `${hosted}:refs/heads/topic`,
    ]);
    f.prepare(hosted, f.base, f.head);
    configureCorrection(f);
    const state = f.state();
    state.pr.headRefOid = hosted;
    state.issueComments[0]!.body = state.issueComments[0]!.body.replace(f.head, hosted);
    f.save(state);
    const result = f.run();
    expect(result.status, result.output).toBe(0);
    expect(f.record().localHead).toBe(f.head);
    expect(f.record().head).toBe(hosted);
  });

  it.each(["none", "incoming digest", "foreign review", "stale gates", "wrong replacement"])(
    "handles explicit correction replacement with %s",
    (fault) => {
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
      f.git([
        "push",
        "-q",
        "--force",
        "origin",
        `${replacement}:refs/pull/123/head`,
        `${replacement}:refs/heads/topic`,
      ]);
      f.prepare(replacement);
      configureCorrection(f);
      const state = f.state();
      state.mode = "success";
      state.pr.headRefOid = replacement;
      state.issueComments[0]!.body = state.issueComments[0]!.body.replace(f.head, replacement);
      f.save(state);
      if (fault === "incoming digest") {
        const path = join(f.worktree, ".local/review.json");
        writeFileSync(path, readFileSync(path, "utf8") + "\n");
      } else if (fault === "foreign review") {
        const path = join(f.worktree, ".local/correction-review.json");
        const review = JSON.parse(readFileSync(path, "utf8"));
        review.pr.headSha = f.head;
        writeFileSync(path, JSON.stringify(review));
      } else if (fault === "stale gates") {
        const path = join(f.worktree, ".local/gates.env");
        writeFileSync(path, readFileSync(path, "utf8").replaceAll(replacement, f.head));
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
    },
  );

  it.each(["LOCAL_PREP_HEAD_SHA", "PREP_HEAD_SHA"] as const)(
    "direct verify rejects changed receipt %s after checks",
    (receiptField) => {
      const f = correctionFixture();
      f.save({ ...f.state(), duringChecks: { receiptField } });
      const result = f.verify();
      expect(result.status, result.output).toBe(1);
      expect(result.output).toContain("Correction review authority changed");
      expect(f.state().mutations).toBe(0);
    },
  );

  it("direct merge-verify refuses missing correction approval", () => {
    const f = correctionFixture();
    rmSync(join(f.worktree, ".local/correction-review.json"));
    const result = f.verify();
    expect(result.status, result.output).toBe(1);
    expect(f.state().mutations).toBe(0);
  });
  it("reconciles an accepted correction merge without disposable review files", () => {
    const f = correctionFixture();
    f.save({ ...f.state(), mode: "applied-merged" });
    const result = f.run();
    expect(result.status, result.output).toBe(0);
    for (const name of ["correction-review.json", "review.json", "review.md"]) {
      const path = join(f.worktree, ".local", name);
      if (existsSync(path)) {
        rmSync(path);
      }
    }
    const again = f.run();
    expect(again.status, again.output).toBe(0);
    expect(f.state().mutations).toBe(1);
  });
});
