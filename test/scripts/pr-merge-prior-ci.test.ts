import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createMergeOutcomeFixtureHarness } from "./pr-merge-outcome.test-support.js";
import { ciWorkflowTree, createPriorCiCandidateFactory } from "./pr-merge-prior-ci.test-support.js";

const { describePosix, fixture } = createMergeOutcomeFixtureHarness();
const { candidate, preExistingCandidate } = createPriorCiCandidateFactory(fixture);

const matrixWorkflow = [
  "jobs:",
  "  checks-node-core-test-nondist-shard:",
  "    name: ${{ matrix.check_name || 'checks-node-core-test-nondist-shard' }}",
  "    needs: [preflight]",
  "    strategy:",
  "      fail-fast: ${{ github.event_name == 'pull_request' }}",
  "      matrix: ${{ fromJson(needs.preflight.outputs.checks_node_core_nondist_matrix) }}",
  "",
].join("\n");

function matrixCandidate(workflow = matrixWorkflow) {
  const f = preExistingCandidate(workflow);
  const state = f.state();
  state.priorCi.jobs![0]!.name = "checks-node-fixture-failed";
  state.priorCi.jobs![2]!.conclusion = "skipped";
  state.priorCi.jobs![2]!.steps = [];
  state.priorCi.jobs![3]!.name = "checks-node-fixture-cancelled";
  f.save(state);
  const evidence = {
    ...f.evidence,
    cancellation: {
      kind: "matrix-fail-fast",
      workflowJob: "checks-node-core-test-nondist-shard",
      jobIds: [604],
      causedBy: [601],
      reason: "Inspected platform cancellation and preflight membership of these exact matrix rows",
      evidence: ["qualification"],
      members: [601, 604].map((jobId) => ({
        jobId,
        name: state.priorCi.jobs!.find((job) => job.id === jobId)!.name,
      })),
    },
  };
  writeFileSync(f.path, JSON.stringify(evidence));
  return { ...f, evidence };
}

function mixedMatrixCandidate(workflow = matrixWorkflow) {
  const f = matrixCandidate(workflow);
  const state = f.state();
  state.priorCi.jobs!.push({
    ...state.priorCi.jobs![0]!,
    id: 606,
    name: "checks-ui-e2e-real-gateway",
  });
  f.save(state);
  f.evidence.failures.push({ ...f.evidence.failures[0]!, jobId: 606 });
  f.evidence.aggregate.causedBy.push(606);
  writeFileSync(f.path, JSON.stringify(f.evidence));
  return f;
}

describePosix("explicit prior-CI admin landing", () => {
  it.each([false, true])(
    "revalidates delegated CI bypass before dispatch (revoked=%s)",
    (revoked) => {
      const f = preExistingCandidate();
      const state = f.state();
      state.repoAuthority.permissions = { admin: false, maintain: true, push: true };
      state.priorCi.membership = "member";
      state.graphqlMergeProjection = { mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" };
      state.priorCi.rulesetBypass = "always";
      state.priorCi.revokeRulesetAfterRead = revoked;
      f.save(state);
      const result = f.adminPriorCi(f.path);
      if (revoked) {
        expect(result.status, result.output).not.toBe(0);
        expect(result.output).toContain("CI-only ruleset bypass");
        expect(f.state().priorCi.rulesetReads).toBe(2);
        expect(f.state().mutations).toBe(0);
        expect(
          f.git(["for-each-ref", "--format=%(refname)", "refs/openclaw/pr-merge-outcomes/123"]),
        ).toBe("");
      } else {
        expect(result.status, result.output).toBe(0);
        expect(f.state().mutations).toBe(1);
        expect(f.record().transport).toBe("rest");
        expect(f.record().priorCiAdmin.delegation).toEqual({
          kind: "ci-ruleset-bypass",
          repositoryId: 1103012935,
          actor: state.operator,
          rulesets: [{ id: 41, mode: "always" }],
        });
        expect(f.state().comments[0]?.body).toContain("No current-head CI success is claimed");
      }
    },
  );

  it("refuses a generic protection 404 without treating hidden GraphQL rules as absent", () => {
    const f = preExistingCandidate();
    f.save({ ...f.state(), restPolicy: "not-found" });
    const result = f.verifyPriorCi(f.path);
    expect(result.status, result.output).not.toBe(0);
    expect(result.output).toContain("classic branch-protection policy is unavailable");
    expect(f.state().calls.some((call) => call.includes("graphql"))).toBe(false);
    expect(f.state().mutations).toBe(0);
    expect(() => f.record()).toThrow();
  });

  it.each(["review", "security", "new attempt"])("delegation cannot waive %s", (fault) => {
    const f = preExistingCandidate();
    const state = f.state();
    state.repoAuthority.permissions = { admin: false, maintain: true, push: true };
    state.priorCi.membership = "member";
    state.priorCi.rulesetBypass = "always";
    if (fault === "review") {
      state.priorCi.reviewDecision = "REVIEW_REQUIRED";
    }
    if (fault === "security") {
      state.priorCi.security.fault = "failed-guard";
    }
    if (fault === "new attempt") {
      state.priorCi.latestAttempt++;
    }
    f.save(state);
    const result = f.verifyPriorCi(f.path);
    expect(result.status, result.output).not.toBe(0);
    expect(result.output).toMatch(/current enforced reviews|security-sensitive|newer or running/);
    expect(f.state().mutations).toBe(0);
    expect(() => f.record()).toThrow();
  });

  it("lands fork matrix cancellation while retaining independent UI failure attribution", () => {
    const f = mixedMatrixCandidate();
    const state = f.state();
    state.priorCi.omitPullRequests = true;
    state.priorCi.sourceRepository = { id: 123456, full_name: "contributor/repo" };
    f.save(state);
    const result = f.verifyPriorCi(f.path);
    expect(result.status, result.output).toBe(0);
    const proof = JSON.parse(result.stdout);
    expect(f.state().mutations).toBe(0);
    expect(proof.failures.map((entry: { jobId: number }) => entry.jobId)).toEqual([601, 606]);
    expect(proof.cancellation.causedBy).toEqual([601]);
    expect(proof.cancellation.members.map((entry: { jobId: number }) => entry.jobId)).toEqual([
      601, 604,
    ]);
    expect(proof.cancelledJobIds).toEqual([604]);
    expect(proof.runAssociation).toBe("exact-source-and-current-check");
    const landed = f.adminPriorCi(f.path);
    expect(landed.status, landed.output).toBe(0);
    expect(f.state().mutations).toBe(1);
    expect(f.record().priorCiAdmin.cancellation).toMatchObject({
      kind: "matrix-fail-fast",
      workflowJob: "checks-node-core-test-nondist-shard",
      workflowBlob: f.git(["rev-parse", `${f.base}:.github/workflows/ci.yml`]),
      jobIds: [604],
    });
  });

  it.each([
    "empty causes",
    "duplicate cause",
    "unknown cause",
    "nonfailed cause",
    "cancelled cause",
    "unrelated failure as cause",
    "extra unrelated member",
    "missing causal member",
    "aggregate omits unrelated failure",
    "missing cancellation qualification",
    "disabled",
    "continue-on-error",
    "changed workflow",
    "foreign member",
    "missing member",
    "wrong owner",
    "dispatch",
  ])("refuses mixed matrix %s without dispatch", (fault) => {
    const workflow =
      fault === "disabled"
        ? matrixWorkflow.replace("${{ github.event_name == 'pull_request' }}", "false")
        : fault === "continue-on-error"
          ? matrixWorkflow.replace("    needs:", "    continue-on-error: true\n    needs:")
          : matrixWorkflow;
    const f = mixedMatrixCandidate(workflow);
    const cancellation = f.evidence.cancellation;
    if (fault === "empty causes") {
      cancellation.causedBy = [];
    }
    if (fault === "duplicate cause") {
      cancellation.causedBy = [601, 601];
    }
    if (fault === "unknown cause") {
      cancellation.causedBy = [999];
    }
    if (fault === "nonfailed cause") {
      cancellation.causedBy = [605];
    }
    if (fault === "cancelled cause") {
      cancellation.causedBy = [604];
    }
    if (fault === "unrelated failure as cause") {
      cancellation.causedBy = [606];
    }
    if (fault === "extra unrelated member") {
      cancellation.members.push({ jobId: 606, name: "checks-ui-e2e-real-gateway" });
    }
    if (fault === "missing causal member") {
      cancellation.members.shift();
    }
    if (fault === "aggregate omits unrelated failure") {
      f.evidence.aggregate.causedBy = [601];
    }
    if (fault === "missing cancellation qualification") {
      cancellation.evidence = [];
    }
    if (fault === "changed workflow") {
      f.evidence.testedMerge = f.commit(
        ciWorkflowTree(f, f.evidence.testedMerge, matrixWorkflow + "# changed by PR\n"),
        [f.base, f.head],
      );
    }
    if (fault === "foreign member") {
      f.evidence.cancellation.members[1]!.name = "another matrix row";
    }
    if (fault === "missing member") {
      f.evidence.cancellation.members.pop();
    }
    if (fault === "wrong owner") {
      f.evidence.cancellation.workflowJob = "unrelated-job";
    }
    if (fault === "dispatch") {
      const state = f.state();
      state.priorCi.event = "workflow_dispatch";
      f.save(state);
    }
    writeFileSync(f.path, JSON.stringify(f.evidence));
    const result = f.verifyPriorCi(f.path);
    expect(result.status, result.output).not.toBe(0);
    expect(result.output).toMatch(/Prior-CI admin admission:/u);
    if (
      [
        "disabled",
        "continue-on-error",
        "changed workflow",
        "foreign member",
        "missing member",
        "wrong owner",
        "dispatch",
      ].includes(fault)
    ) {
      expect(result.output).toMatch(
        fault === "changed workflow" ? /tested merge tree/u : /matrix|workflow/u,
      );
    }
    expect(f.state().mutations).toBe(0);
  });

  it.each([
    ["success", ""],
    ["pending", ""],
    ["automation-dispatch", ""],
    ["human-dispatch", "successful protected Security Review publisher is required"],
    ["missing-job", "security-fast must pass independently"],
    ["duplicate-job", "security-fast must pass independently"],
    ["missing-status", "current combined CI/security status is required"],
    ["missing-guard", "unsuccessful openclaw/security-sensitive-review"],
    ["failed-guard", "unsuccessful openclaw/security-sensitive-review"],
    ["foreign-publisher", "unsuccessful openclaw/ci-gate"],
    ["stale-status", "unsuccessful openclaw/ci-gate"],
    ["foreign-workflow", "successful protected Security Review publisher is required"],
    ["new-publisher-attempt", "publisher attempt identity changed"],
    ["changed-publisher-source", "publisher source differs from the current owner"],
    ["untrusted-publisher-source", "publisher source is not on protected main"],
    ["missing-enforcement", "successful exact-head security enforcement is required"],
    ["incomplete-publisher", "incomplete Security Review job identities"],
    ["status-drift", "security publisher or current statuses changed"],
    ["revoked-role", "approval is no longer current"],
    ["other-required-check", "does not waive other required checks"],
  ])("validates %s security evidence without dispatch", (fault, message) => {
    const f = preExistingCandidate();
    const state = f.state();
    const accepted = ["success", "pending", "automation-dispatch"].includes(fault!);
    if (fault === "success" || fault === "pending") {
      state.priorCi.security.combinedState = fault;
    } else {
      state.priorCi.security.fault = fault!;
    }
    if (fault === "missing-job" || fault === "duplicate-job") {
      const security = state.priorCi.jobs!.find((job) => job.name === "security-fast")!;
      state.priorCi.jobs = state.priorCi.jobs!.filter((job) => job !== security);
      if (fault === "duplicate-job") {
        state.priorCi.jobs.push(security, { ...security, id: 606 });
      }
    }
    if (fault === "revoked-role") {
      state.priorCi.security.approval = true;
      state.priorCi.security.role = "write";
    }
    if (fault === "other-required-check") {
      state.restFailedContext = "Security Review";
    }
    f.save(state);
    const result = f.verifyPriorCi(f.path);
    if (accepted) {
      expect(result.status, result.output).toBe(0);
      expect(JSON.parse(result.stdout).securityReview).toMatchObject({
        combinedStatusId: 801,
        runId: 901,
        runAttempt: 1,
        guardStatusIds: [802, 803],
      });
    } else {
      expect(result.status, result.output).not.toBe(0);
      expect(result.output).toContain(message);
    }
    expect(f.state().mutations).toBe(0);
  });

  it.each(["monitor", "matrix"])("rejects a cancelled failed step under %s attribution", (kind) => {
    const f = kind === "matrix" ? matrixCandidate() : preExistingCandidate();
    const state = f.state();
    state.priorCi.jobs![3]!.steps = [
      { number: 1, name: "Product assertion", status: "completed", conclusion: "failure" },
    ];
    f.save(state);
    const result = f.verifyPriorCi(f.path);
    expect(result.status, result.output).not.toBe(0);
    expect(result.output).toContain("cancelled jobs must not hide failed steps");
  });

  it.each([
    ["Classify PR failures and cancel eligible same-repository work", true],
    ["Unrelated successful step", false],
  ] as const)("recognizes only owned fail-fast steps: %s", (name, accepted) => {
    const f = preExistingCandidate();
    const state = f.state();
    state.priorCi.jobs![2]!.steps![0]!.name = name;
    f.save(state);
    const result = f.verifyPriorCi(f.path);
    if (accepted) {
      expect(result.status, result.output).toBe(0);
    } else {
      expect(result.status, result.output).not.toBe(0);
      expect(result.output).toContain(
        "all cancelled jobs require explicit inspected fail-fast provenance",
      );
    }
    expect(f.state().mutations).toBe(0);
  });

  it.each([
    ["no applicable owner", null, 0, false, false, true],
    ["required code owner", "REVIEW_REQUIRED", 0, false, false, false],
    ["requested changes", "CHANGES_REQUESTED", 0, false, false, false],
    ["required approval", null, 1, false, false, false],
    ["last-push approval", null, 0, true, false, false],
    ["unresolved thread", null, 0, false, true, false],
    ["missing decision", undefined, 0, false, false, false],
  ] as const)(
    "honors applicable reviews under a code-owner rule: %s",
    (_name, decision, count, lastPush, threads, accepted) => {
      const f = preExistingCandidate();
      const state = f.state();
      Object.assign(state.priorCi, {
        reviewDecision: decision,
        reviewCount: count,
        requireCodeOwners: true,
        requireLastPush: lastPush,
        requireThreads: threads,
        resolved: !threads,
      });
      f.save(state);
      const result = f.verifyPriorCi(f.path);
      if (accepted) {
        expect(result.status, result.output).toBe(0);
      } else {
        expect(result.status, result.output).not.toBe(0);
        expect(result.output).toContain(
          threads ? "required review threads" : "current enforced reviews",
        );
      }
      expect(f.state().mutations).toBe(0);
    },
  );

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

  it.each(["unconfirmed", "ordinary"])(
    "keeps %s admission closed for attributed failures",
    (route) => {
      const f = preExistingCandidate();
      const result = route === "unconfirmed" ? f.adminPriorCi(f.path, false) : f.run();
      expect(result.status, result.output).not.toBe(0);
      if (route === "unconfirmed") {
        expect(result.status).toBe(2);
      } else {
        expect(result.output).toContain("requires explicit confirmed admin admission");
      }
      expect(f.state().mutations).toBe(0);
    },
  );

  it.each([
    ["changed source", "failed input changed"],
    ["wrong merge parents", "ordered parents"],
    ["forged merge tree", "tested merge tree"],
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
    if (fault === "forged merge tree") {
      f.evidence.testedMerge = f.commit(f.git(["rev-parse", `${f.base}^{tree}`]), [f.base, f.head]);
      f.evidence.failures[0]!.sourcePaths = ["owner.txt"];
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
    const state = f.state();
    state.priorCi.workflowPath = ".github/workflows/ci.yml@refs/heads/topic";
    f.save(state);
    const result = f.adminPriorCi(f.path);
    expect(result.status, result.output).toBe(0);
    expect(f.state().mutations).toBe(1);
    expect(f.state().restMergePayload).toMatchObject({ sha: f.head, merge_method: "squash" });
    expect(f.record()).toMatchObject({
      phase: "complete",
      route: "admin",
      head: f.head,
      priorCiAdmin: {
        head: f.head,
        priorHead: f.evidence.priorHead,
        runId: 501,
        runAttempt: 2,
        dispatchTransport: "rest",
      },
    });
    expect(f.state().comments[0]?.body).toContain("No current-head CI success is claimed");
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
