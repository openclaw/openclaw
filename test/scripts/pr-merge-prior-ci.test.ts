import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
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

function preExistingCandidate() {
  const f = candidate();
  const state = f.state();
  state.gates = "fail";
  state.pr.mergeStateStatus = "BLOCKED";
  state.priorCi.runHead = f.head;
  state.priorCi.event = "pull_request";
  state.priorCi.runConclusion = "cancelled";
  const job = (id: number, name: string, conclusion: string) => ({
    id,
    name,
    conclusion,
    status: "completed",
    run_id: 501,
    head_sha: f.head,
  });
  state.priorCi.jobs = [
    job(601, "owner-tests", "failure"),
    {
      ...job(602, "openclaw/ci-gate", "failure"),
      check_run_url: "https://api.github.com/repos/fixture/repo/check-runs/1",
    },
    {
      ...job(603, "pr-fail-fast", "success"),
      steps: [
        {
          number: 2,
          name: "Cancel remaining PR work after a failure",
          status: "completed",
          conclusion: "success",
        },
      ],
    },
    job(604, "cancelled-sibling", "cancelled"),
    job(605, "security-fast", "success"),
  ];
  f.save(state);
  const artifact = join(f.root, "qualification.txt");
  writeFileSync(
    artifact,
    "Inspected checkout, unchanged sibling input, independent baseline failure, and fail-fast cancellation.\n",
  );
  const evidence = {
    ...f.evidence,
    changeKind: "pre-existing-failure",
    priorHead: f.base,
    testedMerge: f.commit(f.git(["rev-parse", `${f.head}^{tree}`]), [f.base, f.head]),
    deltaSha256: createHash("sha256")
      .update(f.git(["diff", "--raw", "--abbrev=40", "--no-renames", "-z", f.base, f.head, "--"]))
      .digest("hex"),
    artifacts: [
      {
        name: "qualification",
        path: artifact,
        sha256: createHash("sha256").update(readFileSync(artifact)).digest("hex"),
      },
    ],
    checkout: { reason: "Inspected the exact preflight checkout", evidence: ["qualification"] },
    failures: [
      {
        jobId: 601,
        reason: "The same independent failure predates the PR",
        cases: ["sibling assertion"],
        sourcePaths: ["sibling.txt"],
        evidence: ["qualification"],
      },
    ],
    aggregate: {
      jobId: 602,
      causedBy: [601],
      reason: "Aggregate reports the admitted root failure",
      evidence: ["qualification"],
    },
    cancellation: {
      jobId: 603,
      step: 2,
      jobIds: [604],
      causedBy: [601],
      reason: "Inspected fail-fast step cancelled the sibling",
      evidence: ["qualification"],
    },
  };
  writeFileSync(f.path, JSON.stringify(evidence));
  const reviewPath = join(f.worktree, ".local/review.json");
  const review = JSON.parse(readFileSync(reviewPath, "utf8"));
  review.tests.result = "fail";
  review.tests.preExistingCi = {
    head: f.head,
    runId: 501,
    runAttempt: 2,
    reason: "Independently qualified baseline failure; cancelled siblings remain unrun",
  };
  writeFileSync(reviewPath, JSON.stringify(review));
  return { ...f, evidence, artifact };
}

describePosix("explicit prior-CI admin landing", () => {
  it.each(["failure", "cancelled"])(
    "lands an attributed %s attempt without claiming cancelled coverage passed",
    (conclusion) => {
      const f = preExistingCandidate();
      const state = f.state();
      state.priorCi.runConclusion = conclusion;
      f.save(state);
      const result = f.adminPriorCi(f.path);
      expect(result.status, result.output).toBe(0);
      expect(f.state().mutations).toBe(1);
      expect(f.record()).toMatchObject({
        phase: "complete",
        route: "admin",
        head: f.head,
        priorCiAdmin: {
          changeKind: "pre-existing-failure",
          testedMerge: f.evidence.testedMerge,
          gateCheckRunId: 1,
          cancelledJobIds: [604],
        },
      });
      expect(f.state().comments[0]?.body).toContain("Cancelled jobs remain unrun coverage");
      expect(f.state().comments[0]?.body).not.toContain("Prior successful CI");
    },
  );

  it("requires the explicit operator confirmation even with valid baseline evidence", () => {
    const f = preExistingCandidate();
    const result = f.adminPriorCi(f.path, false);
    expect(result.status, result.output).not.toBe(0);
    expect(result.status).toBe(2);
    expect(f.state().mutations).toBe(0);
  });

  it("keeps ordinary merge admission closed for an attributed failing review", () => {
    const f = preExistingCandidate();
    const result = f.run();
    expect(result.status, result.output).not.toBe(0);
    expect(result.output).toContain("requires explicit confirmed admin admission");
    expect(f.state().mutations).toBe(0);
  });

  it("qualifies a fork run without PR associations only through exact source and current-check identity", () => {
    const f = preExistingCandidate();
    const state = f.state();
    state.priorCi.omitPullRequests = true;
    state.priorCi.sourceRepository = { id: 123456, full_name: "contributor/repo" };
    f.save(state);
    const result = f.verifyPriorCi(f.path);
    expect(result.status, result.output).toBe(0);
    expect(JSON.parse(result.stdout).runAssociation).toBe("exact-source-and-current-check");
  });

  it.each(["missing", "duplicate"])(
    "requires one successful security job when it is %s",
    (kind) => {
      const f = preExistingCandidate();
      const state = f.state();
      const security = state.priorCi.jobs!.find((job) => job.name === "security-fast")!;
      state.priorCi.jobs = state.priorCi.jobs!.filter((job) => job !== security);
      if (kind === "duplicate") {
        state.priorCi.jobs.push(security, { ...security, id: 606 });
      }
      f.save(state);
      const result = f.verifyPriorCi(f.path);
      expect(result.status, result.output).not.toBe(0);
      expect(result.output).toContain("security-fast must pass independently");
    },
  );

  it.each([
    ["changed source", "failed input changed"],
    ["wrong merge parents", "ordered parents"],
    ["missing failed job", "every failed job"],
    ["unattributed case", "observed cases"],
    ["missing cancellation", "all cancelled jobs"],
    ["unproven cancellation", "all cancelled jobs"],
    ["wrong aggregate", "failed CI aggregate"],
    ["changed artifact", "retained failure evidence changed"],
    ["new attempt", "newer or running CI attempt"],
    ["different current check", "currently effective CI gate"],
    ["security failure", "security-fast must pass"],
    ["stale review head", "Invalid pre-existing CI attribution"],
    ["different review run", "matching failed-run attribution"],
    ["different review attempt", "matching failed-run attribution"],
    ["green review claim", "keep tests.result=fail"],
    ["foreign fork run", "expected conclusion and belong"],
  ])("refuses %s without a merge intent", (fault, message) => {
    const f = preExistingCandidate();
    const state = f.state();
    if (fault === "changed source") {
      f.evidence.failures[0]!.sourcePaths = ["owner.txt"];
    }
    if (fault === "wrong merge parents") {
      f.evidence.testedMerge = f.commit(f.tree("resolved conflict\n"), [f.head, f.base]);
    }
    if (fault === "missing failed job") {
      f.evidence.failures = [];
    }
    if (fault === "unattributed case") {
      f.evidence.failures[0]!.cases = [];
    }
    if (fault === "missing cancellation") {
      f.evidence.cancellation.jobIds = [];
    }
    if (fault === "unproven cancellation") {
      f.evidence.cancellation.step = 3;
    }
    if (fault === "wrong aggregate") {
      f.evidence.aggregate.causedBy = [604];
    }
    if (fault === "changed artifact") {
      writeFileSync(f.artifact, "changed qualification\n");
    }
    if (fault === "new attempt") {
      state.priorCi.latestAttempt = 3;
    }
    if (fault === "different current check") {
      state.priorCi.jobs![1]!.check_run_url =
        "https://api.github.com/repos/fixture/repo/check-runs/2";
    }
    if (fault === "security failure") {
      state.priorCi.jobs![4]!.conclusion = "failure";
    }
    if (fault === "foreign fork run") {
      state.priorCi.omitPullRequests = true;
      state.priorCi.runRepository = { id: 654321, full_name: "unrelated/repo" };
    }
    if (
      [
        "stale review head",
        "different review run",
        "different review attempt",
        "green review claim",
      ].includes(fault)
    ) {
      const reviewPath = join(f.worktree, ".local/review.json");
      const review = JSON.parse(readFileSync(reviewPath, "utf8"));
      if (fault === "stale review head") {
        review.tests.preExistingCi.head = f.base;
      }
      if (fault === "different review run") {
        review.tests.preExistingCi.runId = 502;
      }
      if (fault === "different review attempt") {
        review.tests.preExistingCi.runAttempt = 1;
      }
      if (fault === "green review claim") {
        review.tests.result = "pass";
      }
      writeFileSync(reviewPath, JSON.stringify(review));
    }
    f.save(state);
    writeFileSync(f.path, JSON.stringify(f.evidence));
    const result = f.adminPriorCi(f.path);
    expect(result.status, result.output).not.toBe(0);
    expect(result.output).toContain(message);
    expect(f.state().mutations).toBe(0);
    expect(
      f.git(["for-each-ref", "--format=%(refname)", "refs/openclaw/pr-merge-outcomes/123"]),
    ).toBe("");
  });

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
