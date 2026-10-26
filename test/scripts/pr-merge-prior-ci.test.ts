import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createMergeOutcomeFixtureHarness } from "./pr-merge-outcome.test-support.js";
import { ciWorkflowTree, createPriorCiCandidateFactory } from "./pr-merge-prior-ci.test-support.js";

const { describePosix, fixture } = createMergeOutcomeFixtureHarness();
const { candidate, preExistingCandidate } = createPriorCiCandidateFactory(fixture);

type Fixture = ReturnType<typeof fixture>;
function expectResult(
  f: Fixture,
  result: ReturnType<Fixture["verifyPriorCi"]>,
  message?: string | RegExp,
  mutations = 0,
) {
  if (message === undefined) {
    expect(result.status, result.output).toBe(0);
  } else if (typeof message === "string") {
    expect(result.status, result.output).not.toBe(0);
    expect(result.output).toContain(message);
  } else {
    expect(result.status, result.output).not.toBe(0);
    expect(result.output).toMatch(message);
  }
  expect(f.state().mutations).toBe(mutations);
}
function expectNoIntent(f: Fixture) {
  expect(
    f.git(["for-each-ref", "--format=%(refname)", "refs/openclaw/pr-merge-outcomes/123"]),
  ).toBe("");
}
function delegate(f: ReturnType<typeof preExistingCandidate>) {
  const state = f.state();
  state.repoAuthority.permissions = { admin: false, maintain: true, push: true };
  Object.assign(state.priorCi, { membership: "member", rulesetBypass: "always" });
  return state;
}

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
      const state = delegate(f);
      state.graphqlMergeProjection = { mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" };
      state.priorCi.revokeRulesetAfterRead = revoked;
      f.save(state);
      const result = f.adminPriorCi(f.path);
      if (revoked) {
        expectResult(f, result, "CI-only ruleset bypass");
        expect(f.state().priorCi.rulesetReads).toBe(2);
        expectNoIntent(f);
      } else {
        expectResult(f, result, undefined, 1);
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

  it.each([
    { kind: "check", state: "failure", required: true, padding: 0, admitted: false },
    { kind: "status", state: "pending", required: true, padding: 0, admitted: false },
    { kind: "check", state: "failure", required: true, padding: 100, admitted: false },
    { kind: "check", state: "failure", required: false, padding: 0, admitted: true },
    {
      kind: "check",
      state: "success",
      required: true,
      padding: 0,
      admitted: true,
      previousFailure: true,
    },
  ] as const)(
    "honors native $kind required=$required $state checks after $padding optional contexts",
    ({ kind, state: checkState, required, padding, admitted, ...options }) => {
      const f = preExistingCandidate();
      const state = f.state();
      state.restPolicy = "not-found";
      state.quotaAt = "checks";
      state.priorCi.nativeChecks = [
        { name: "Classic required check", kind, required, state: checkState, ...options },
      ];
      state.priorCi.nativeOptionalCount = padding;
      f.save(state);
      const result = f.adminPriorCi(f.path);
      expectResult(f, result, admitted ? undefined : /other required checks/, admitted ? 1 : 0);
      if (admitted) {
        expect(f.record().phase).toBe("complete");
      } else {
        expect(() => f.record()).toThrow();
      }
    },
  );

  it.each(["missing", "unrestricted-publisher"])(
    "requires the native marked publisher when its REST result is %s",
    (fault) => {
      const f = preExistingCandidate();
      const state = f.state();
      state.quotaAt = "checks";
      state.priorCi.nativeChecks = [
        { name: "Security Review", kind: "check", required: true, state: "success" },
      ];
      state.priorCi.missingCheck = "Security Review";
      if (fault === "missing") {
        state.priorCi.nativeMissingResult = true;
        state.restContexts = ["openclaw/ci-gate"];
      } else {
        state.restRequiredApp = null;
        state.priorCi.nativeResultApp = 999;
      }
      f.save(state);
      expectResult(f, f.adminPriorCi(f.path), /other required checks/);
      expect(() => f.record()).toThrow();
    },
  );

  it.each(["head", "commit", "total", "cursor"])(
    "refuses native required-check pagination with %s drift",
    (fault) => {
      const f = preExistingCandidate();
      const state = f.state();
      state.quotaAt = "checks";
      state.priorCi.nativeChecks = [
        { name: "Classic required check", kind: "check", required: true, state: "success" },
      ];
      state.priorCi.nativeOptionalCount = 100;
      state.priorCi.nativePageFault = fault;
      f.save(state);
      expectResult(
        f,
        f.adminPriorCi(f.path),
        /prepared head|current enforced reviews|inventory|pagination/,
      );
      expect(() => f.record()).toThrow();
    },
  );

  it("lands fork matrix cancellation while retaining independent UI failure attribution", () => {
    const f = mixedMatrixCandidate();
    const state = f.state();
    state.priorCi.omitPullRequests = true;
    state.priorCi.sourceRepository = { id: 123456, full_name: "contributor/repo" };
    f.save(state);
    const result = f.verifyPriorCi(f.path);
    expectResult(f, result);
    const proof = JSON.parse(result.stdout);
    expect(proof).toMatchObject({
      failures: [{ jobId: 601 }, { jobId: 606 }],
      cancellation: { causedBy: [601], members: [{ jobId: 601 }, { jobId: 604 }] },
      cancelledJobIds: [604],
      runAssociation: "exact-source-and-current-check",
    });
    const landed = f.adminPriorCi(f.path);
    expectResult(f, landed, undefined, 1);
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
    "unrelated failure as cause",
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
    const causes: Record<string, number[]> = {
      "empty causes": [],
      "duplicate cause": [601, 601],
      "unrelated failure as cause": [606],
    };
    cancellation.causedBy = causes[fault] ?? cancellation.causedBy;
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
    expectResult(f, result, /Prior-CI admin admission:/u);
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
  });

  it.each(["current", "older", "foreign"] as const)(
    "checks the %s publisher against main after the bound workflow changes",
    (publisher) => {
      const f = preExistingCandidate();
      const workflowPath = ".github/workflows/security-review.yml";
      const workflow = f.git(["show", `${f.base}:${workflowPath}`]);
      // Add an input to both checkouts so admission must use main's inventory too.
      const updated = workflow.replaceAll(
        "sparse-checkout: |",
        "sparse-checkout: |\n            /sibling.txt",
      );
      const blob = f.git(["hash-object", "-w", "--stdin"], updated + "\n");
      let tree = blob;
      for (const [directory, name, kind] of [
        [":.github/workflows", "security-review.yml", "100644 blob"],
        [":.github", "workflows", "040000 tree"],
        ["", ".github", "040000 tree"],
      ]) {
        const entries = f
          .git(["ls-tree", `${f.base}${directory}`])
          .split("\n")
          .filter((entry) => !entry.endsWith(`\t${name}`));
        tree = f.git(["mktree"], [...entries, `${kind} ${tree}\t${name}`, ""].join("\n"));
      }
      const main = f.commit(tree, [f.base]);
      f.git(["push", "-q", "origin", `${main}:refs/heads/main`]);
      const state = f.state();
      state.priorCi.security.sourceSha = publisher === "older" ? f.base : main;
      if (publisher === "foreign") {
        state.priorCi.security.fault = "untrusted-publisher-source";
      }
      f.save(state);

      const result = f.adminPriorCi(f.path);
      expectResult(
        f,
        result,
        publisher === "current"
          ? undefined
          : publisher === "older"
            ? "publisher source differs from the current owner"
            : "publisher source is not on protected main",
        publisher === "current" ? 1 : 0,
      );
      if (publisher === "current") {
        expect(f.record().priorCiAdmin.securityReview).toMatchObject({
          sourceSha: main,
          sources: expect.arrayContaining([
            { path: workflowPath, sha: blob },
            { path: "sibling.txt", sha: f.git(["rev-parse", `${main}:sibling.txt`]) },
          ]),
        });
      } else {
        expectNoIntent(f);
      }
    },
  );

  it.each([
    ["success", ""],
    ["pending", ""],
    ["head-only-enforcement", ""],
    ["wrong-ci-run", "successful exact-head security enforcement is required"],
    ["wrong-ci-attempt", "successful exact-head security enforcement is required"],
    ["duplicate-enforcement", "successful exact-head security enforcement is required"],
    ["automation-dispatch", "successful protected Security Review publisher is required"],
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
    ["malformed-workflow", "complete protected publisher source is required"],
    ["changed-workflow-bytes", "blob bytes mismatch"],
    ["untrusted-publisher-source", "publisher source is not on protected main"],
    ["missing-enforcement", "successful exact-head security enforcement is required"],
    ["incomplete-publisher", "incomplete Security Review job identities"],
    ["status-drift", "security publisher or current statuses changed"],
    ["revoked-role", "approval is no longer current"],
    ["other-required-check", "does not waive other required checks"],
  ])("validates %s security evidence without dispatch", (fault, message) => {
    const f = preExistingCandidate();
    const state = f.state();
    const accepted = ["success", "pending", "head-only-enforcement"].includes(fault!);
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
    expectResult(f, result, accepted ? undefined : message);
    if (accepted) {
      expect(JSON.parse(result.stdout).securityReview).toMatchObject({
        combinedStatusId: 801,
        runId: 901,
        runAttempt: 1,
        guardStatusIds: [802, 803],
      });
    }
  });

  it.each(["monitor", "matrix"])("rejects a cancelled failed step under %s attribution", (kind) => {
    const f = kind === "matrix" ? matrixCandidate() : preExistingCandidate();
    const state = f.state();
    state.priorCi.jobs![3]!.steps = [
      { number: 1, name: "Product assertion", status: "completed", conclusion: "failure" },
    ];
    f.save(state);
    const result = f.verifyPriorCi(f.path);
    expectResult(f, result, "cancelled jobs must not hide failed steps");
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
    expectResult(
      f,
      result,
      accepted ? undefined : "all cancelled jobs require explicit inspected fail-fast provenance",
    );
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
      expectResult(
        f,
        result,
        accepted ? undefined : threads ? "required review threads" : "current enforced reviews",
      );
    },
  );

  it.each(["cancelled"])(
    "lands an attributed %s attempt without claiming cancelled coverage passed",
    (conclusion) => {
      const f = preExistingCandidate();
      const state = f.state();
      state.priorCi.runConclusion = conclusion;
      f.save(state);
      const result = f.adminPriorCi(f.path);
      expectResult(f, result, undefined, 1);
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

  it.each<[string, string]>([
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
    const reviewChanges: Record<
      string,
      Partial<{ head: string; runId: number; runAttempt: number }>
    > = {
      "stale review head": { head: f.base },
      "different review run": { runId: 502 },
      "different review attempt": { runAttempt: 1 },
    };
    if (reviewChanges[fault] || fault === "green review claim") {
      const reviewPath = join(f.worktree, ".local/review.json");
      const review = JSON.parse(readFileSync(reviewPath, "utf8"));
      Object.assign(review.tests.preExistingCi, reviewChanges[fault]);
      if (fault === "green review claim") {
        review.tests.result = "pass";
      }
      writeFileSync(reviewPath, JSON.stringify(review));
    }
    f.save(state);
    writeFileSync(f.path, JSON.stringify(f.evidence));
    const result = f.adminPriorCi(f.path);
    expectResult(f, result, message);
    expectNoIntent(f);
  });

  it("lands one pinned REST squash and retains honest historical CI and scoped proof", () => {
    const f = candidate();
    const state = f.state();
    state.priorCi.workflowPath = ".github/workflows/ci.yml@refs/heads/topic";
    f.save(state);
    const result = f.adminPriorCi(f.path);
    expectResult(f, result, undefined, 1);
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
    const evidenceChanges: Record<string, Partial<typeof f.evidence>> = {
      head: { head: f.base },
      delta: { deltaSha256: "0".repeat(64) },
    };
    const ciChanges: Record<string, Partial<typeof state.priorCi>> = {
      "prior-run": { runHead: f.base },
      "wrong-branch": { branch: "unrelated" },
      review: { reviewDecision: "REVIEW_REQUIRED" },
      "null-review": { reviewDecision: null },
      threads: { requireThreads: true, resolved: false },
      security: { otherCheck: "Security Review" },
      "missing-security": { missingCheck: "Security Review" },
      authority: { membership: "member" },
      "changed-evidence": { mutateEvidence: true },
    };
    const stateChanges: Record<string, Partial<typeof state>> = {
      "failed-ci": { gates: "fail" },
      security: { restFailedContext: "Security Review" },
      "wrong-publisher": { restCheckApp: 999 },
    };
    Object.assign(f.evidence, evidenceChanges[fault]);
    Object.assign(state.priorCi, ciChanges[fault]);
    Object.assign(state, stateChanges[fault]);
    f.save(state);
    writeFileSync(f.path, JSON.stringify(f.evidence));
    const result = fault === "changed-evidence" ? f.adminPriorCi(f.path) : f.verifyPriorCi(f.path);
    expectResult(f, result, "Prior-CI admin admission:");
    expectNoIntent(f);
  });
});
