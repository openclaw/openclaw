import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createMergeOutcomeFixtureHarness } from "./pr-merge-outcome.test-support.js";

const { describePosix, fixture } = createMergeOutcomeFixtureHarness();
function candidate() {
  const f = fixture(undefined, [["first change\n"], ["resolved conflict\n"]]);
  const state = f.state();
  const path = join(f.root, "admin.json");
  state.priorCi.enabled = true;
  state.priorCi.evidencePath = path;
  state.repoAuthority.owner = { login: "fixture", type: "Organization" };
  state.restPolicy = "rules";
  state.requiredCheckName = "openclaw/ci-gate";
  state.restContexts = ["openclaw/ci-gate", "Security Review"];
  state.gates = "pending";
  state.pr.mergeStateStatus = "BEHIND";
  f.save(state);
  writeFileSync(
    join(f.worktree, ".local/gates.env"),
    `GATES_MODE=github_pending\nHOSTED_GATES_TARGET_HEAD_SHA=${f.head}\n`,
  );
  const delta = f.git([
    "diff",
    "--raw",
    "--abbrev=40",
    "--no-renames",
    "-z",
    state.priorCi.head,
    f.head,
    "--",
  ]);
  // The fixture git helper trims output; this raw form terminates with NUL, so
  // no bytes belonging to the delta are removed.
  const evidence = {
    version: 1,
    changeKind: "conflict-resolution",
    repository: "fixture/repo",
    pr: 123,
    head: f.head,
    priorHead: state.priorCi.head,
    runId: 501,
    runAttempt: 2,
    deltaSha256: createHash("sha256").update(delta).digest("hex"),
    reason: "Explicit operator approval after resolving the source conflict",
    contracts: ["owner output"],
    checks: [
      { command: "owner test", result: "passed", evidence: "Observed resolved owner output" },
    ],
  };
  writeFileSync(path, JSON.stringify(evidence));
  return { ...f, path, evidence };
}

describePosix("explicit prior-CI admin landing", () => {
  it("lands one pinned REST squash and retains honest historical CI and scoped proof", () => {
    const f = candidate();
    const result = f.adminPriorCi(f.path);
    expect(result.status, result.output).toBe(0);
    expect(f.state().mutations).toBe(1);
    expect(f.state().restMergePayload).toMatchObject({ sha: f.head, merge_method: "squash" });
    expect(f.record()).toMatchObject({
      phase: "complete",
      route: "admin",
      head: f.head,
      priorCiAdmin: {
        priorHead: f.evidence.priorHead,
        runId: 501,
        runAttempt: 2,
        dispatchTransport: "rest",
      },
    });
    expect(f.state().comments[0]?.body).toContain("No current-head CI success is claimed");
  });

  it("accepts an exact CI workflow path with its GitHub run-attempt ref suffix", () => {
    const f = candidate();
    const state = f.state();
    state.priorCi.workflowPath = ".github/workflows/ci.yml@refs/heads/topic";
    f.save(state);
    const result = f.verifyPriorCi(f.path);
    expect(result.status, result.output).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ head: f.head, runId: 501, runAttempt: 2 });
  });

  it.each([
    "head",
    "delta",
    "prior-run",
    "wrong-branch",
    "review",
    "null-review",
    "threads",
    "failed-ci",
    "security",
    "missing-security",
    "wrong-publisher",
    "authority",
    "changed-evidence",
  ])("refuses %s before retaining a merge intent or dispatching", (fault) => {
    const f = candidate();
    const state = f.state();
    if (fault === "head") {
      f.evidence.head = f.base;
    }
    if (fault === "delta") {
      f.evidence.deltaSha256 = "0".repeat(64);
    }
    if (fault === "prior-run") {
      state.priorCi.runHead = f.base;
    }
    if (fault === "wrong-branch") {
      state.priorCi.branch = "unrelated";
    }
    if (fault === "review") {
      state.priorCi.reviewDecision = "REVIEW_REQUIRED";
    }
    if (fault === "null-review") {
      state.priorCi.reviewDecision = null;
    }
    if (fault === "threads") {
      state.priorCi.requireThreads = true;
      state.priorCi.resolved = false;
    }
    if (fault === "failed-ci") {
      state.gates = "fail";
    }
    if (fault === "security") {
      state.priorCi.otherCheck = "Security Review";
      state.restFailedContext = "Security Review";
    }
    if (fault === "missing-security") {
      state.priorCi.missingCheck = "Security Review";
    }
    if (fault === "wrong-publisher") {
      state.restCheckApp = 999;
    }
    if (fault === "authority") {
      state.priorCi.membership = "member";
    }
    if (fault === "changed-evidence") {
      state.priorCi.mutateEvidence = true;
    }
    f.save(state);
    writeFileSync(f.path, JSON.stringify(f.evidence));
    const result = fault === "changed-evidence" ? f.adminPriorCi(f.path) : f.verifyPriorCi(f.path);
    expect(result.status, result.output).not.toBe(0);
    expect(result.output).toContain("Prior-CI admin admission:");
    expect(f.state().mutations).toBe(0);
    expect(
      f.git(["for-each-ref", "--format=%(refname)", "refs/openclaw/pr-merge-outcomes/123"]),
    ).toBe("");
  });
});
