import { existsSync } from "node:fs";
import { expect, it } from "vitest";
import { resolveVitestNodeArgs } from "../../scripts/lib/vitest-process-env.mts";
import {
  expectRetained,
  expectRecovery,
  retainIntent,
  configuredFixture,
  expectExit,
  configureMerge,
  expectCapturedFiles,
  observeMerged,
  expectGraphqlSquash,
  readLocal,
  writeLocal,
} from "./pr-merge-assertions.test-support.js";
import { createMergeOutcomeFixtureHarness } from "./pr-merge-outcome.test-support.js";

const { fixture, outcomeRef, describePosix, unknownProjection } =
  createMergeOutcomeFixtureHarness();

describePosix("native merge with exhausted GraphQL quota", () => {
  function restFixture(
    changes: Parameters<typeof configureMerge>[1] = {},
    ...args: Parameters<typeof fixture>
  ) {
    const f = fixture(...args);
    configureMerge(f, { restPolicy: "supported", ...changes });
    return f;
  }

  const evidenceCase = (state: Parameters<typeof configureMerge>[1], admitted = false) => ({
    state,
    admitted,
  });

  function expectAdmission(f: ReturnType<typeof fixture>, admitted = true) {
    expectExit(f.run(), admitted ? 0 : 1);
    expect(f.state().mutations).toBe(admitted ? 1 : 0);
    if (admitted) {
      expect(f.record()).toMatchObject({ phase: "complete", transport: "rest", head: f.head });
    } else {
      expect(() => f.record()).toThrow();
    }
  }

  it.each([false, true])(
    "reconciles async UUID without replay (commit omitted=%s)",
    (omitCommit) => {
      const f = restFixture({
        asyncMergeStatus: "pending",
        restMergeCommit: omitCommit ? "missing" : "",
      });
      const submitted = expectExit(f.run(), 0);
      expect(submitted.output).toContain("ASYNC MERGE PENDING");
      expect(f.record()).toMatchObject({
        phase: "intent",
        accepted: true,
        asyncMerge: {
          uuid: "630b9d5e-3f2a-4f7e-8b0c-2d5f9a8c1e42",
          status: "pending",
        },
      });
      expect(f.state().asyncPolls).toBe(1);
      const { calls } = f.state();
      const asyncCalls = calls.filter((call) =>
        call.some((arg) => arg.startsWith("repos/fixture/repo/pulls/123/merge-async")),
      );
      expect(asyncCalls).toHaveLength(2);
      for (const call of asyncCalls) {
        expect(call.slice(1, 4)).toEqual(["api", "-H", "X-Octopool-Require: merge-async-v1"]);
      }
      expect(f.state().posts).toBe(0);
      expect(existsSync(f.worktree)).toBe(true);

      expectExit(f.run(), 0);
      expect(f.state().asyncPolls).toBe(2);
      const landed = f.advance("after\n", "stable\n");
      observeMerged(f, landed, { asyncMergeStatus: "merged" });
      expectExit(f.run(), 0);
      expect(f.record()).toMatchObject({
        phase: "merged",
        landed,
        asyncMerge: { status: "merged", sha: landed },
      });
      expect(f.state()).toMatchObject({ mutations: 1, posts: 0 });
      expect(f.state().graphqlMergePayloads).toEqual([]);
      expect(f.state().observationReads > 0).toBe(omitCommit);
    },
  );

  function asyncReceipt(changes: Parameters<typeof configureMerge>[1], headChanged = false) {
    const f = restFixture({ asyncMergeStatus: "pending" });
    expectExit(f.run());
    const landed = f.advance("after\n", "stable\n");
    observeMerged(f, landed, {
      asyncMergeStatus: "merged",
      ...changes,
      ...(headChanged ? { observations: [{ pr: { headRefOid: f.base } }] } : {}),
    });
    return { f, landed };
  }

  it.each(["null", "empty", "malformed", "unavailable", "head-changed"])(
    "retains accepted intent on invalid %s receipt",
    (fault) => {
      const malformed = ["null", "empty", "malformed"].includes(fault);
      const { f } = asyncReceipt(
        {
          restMergeCommit: malformed ? fault : "missing",
          unavailable: fault === "unavailable",
        },
        fault === "head-changed",
      );
      const run = expectExit(f.run(), 1);
      expect(f.record()).toMatchObject({ phase: "intent", accepted: true });
      expect(f.state()).toMatchObject({ mutations: 1, posts: 0 });
      expect(existsSync(f.worktree)).toBe(true);
      if (malformed) {
        expect(run.output).toContain("merged PR has no valid merge commit");
        expect(f.state().observationReads).toBe(0);
      }
    },
  );

  it.each(["failed", "enqueued", "expired", "unknown"])(
    "prevents replay and cleanup on async %s",
    (asyncMergeStatus) => {
      const f = restFixture({ asyncMergeStatus });
      expectExit(f.run(), 1);
      expect(f.record()).toMatchObject({ phase: "intent", accepted: true });
      expect(f.state().posts).toBe(0);
      expect(existsSync(f.worktree)).toBe(true);
      f.recover();
      expect(f.run().status).toBe(1);
      expect(f.state().mutations).toBe(1);
      if (asyncMergeStatus !== "failed") {
        f.recover();
        const previous = f.git(["rev-parse", outcomeRef]);
        expect(f.run(false, f.repo, "squash", previous).status).toBe(1);
        expect(f.git(["rev-parse", outcomeRef])).toBe(previous);
        expect(f.state().mutations).toBe(1);
      }
    },
  );

  it("retains async captures on authorized recovery", () => {
    const f = restFixture({ mode: "unapplied" });
    const { previous } = retainIntent(f, 1);
    f.recover();
    // Recovery starts with GraphQL; exhausted quota selects REST before dispatch.
    configureMerge(f, { mode: "success", asyncMergeStatus: "pending", quotaAt: "checks" });

    expectRecovery(f, previous);
    expect(f.record()).toMatchObject({ accepted: true, asyncMerge: { status: "pending" } });
    expect(f.captures()).toHaveLength(2);
    expectCapturedFiles(f, f.captures(), outcomeRef);
    expect(f.run().status).toBe(0);
    expect(f.state()).toMatchObject({ mutations: 2, graphqlMergePayloads: [] });
  });

  it("retains ancestry on authoritative async failure recovery", () => {
    const f = restFixture({ asyncMergeStatus: "failed" });
    const { previous, previousRecord: original } = retainIntent(f, 1);
    expect(original).toMatchObject({ accepted: true, asyncMerge: { status: "failed", sha: null } });
    expect(f.recover()).toBe(false);

    expectRecovery(f, previous);
    expect(f.state().asyncPolls).toBe(2);
    expect(f.state().mutations).toBe(2);
    expect(f.record()).toMatchObject({
      phase: expect.stringMatching(/^(commented|complete)$/u),
      head: f.head,
      method: "squash",
      recovery: {
        outcome: previous,
        attempt: original.attempt,
        asyncFailure: original.asyncMerge,
      },
    });
    expect(JSON.parse(f.git(["show", `${previous}:outcome.json`]))).toEqual(original);
    expect(f.git(["merge-base", "--is-ancestor", previous, outcomeRef])).toBe("");
    expect(f.run().status).toBe(0);
    expect(f.state().mutations).toBe(2);
  });

  it.each(["pending", "enqueued", "expired", "unknown", "sha", "head", "closed", "checks"])(
    "retains intent on async-failure recovery %s drift",
    (fault) => {
      const f = restFixture({ asyncMergeStatus: "failed" });
      const { previous } = retainIntent(f, 1);
      expect(f.recover()).toBe(false);
      configureMerge(f, {
        asyncMergeStatus: ["pending", "enqueued", "expired", "unknown"].includes(fault)
          ? fault
          : "failed",
        asyncMergeFault: fault === "sha" ? "sha" : "",
        gates: fault === "checks" ? "fail" : "pass",
        pr: {
          ...(fault === "head" ? { headRefOid: f.base } : {}),
          ...(fault === "closed" ? { state: "CLOSED" } : {}),
        },
      });

      expectRecovery(f, previous, "", 1);
      if (!["head", "closed", "checks"].includes(fault)) {
        expect(f.state().asyncPolls).toBe(2);
      }
      expect(f.state().mutations).toBe(1);
      expect(f.git(["rev-parse", outcomeRef])).toBe(previous);
    },
  );

  it.each(["uuid", "head", "conflict"])(
    "rejects fallback on uncertain async %s",
    (asyncMergeFault) => {
      const f = restFixture({ asyncMergeStatus: "pending", asyncMergeFault });
      const run = expectExit(f.run(), 1);
      expect(run.output).not.toContain("use GraphQL");
      expect(f.state()).toMatchObject({ mutations: 1, posts: 0 });
      f.recover();
      expect(f.run().status).toBe(1);
      expect(f.state().mutations).toBe(1);
    },
  );

  it("still verifies the PR tree after the async result expires", () => {
    const { f, landed } = asyncReceipt({ asyncMergeStatus: "expired" });
    expectExit(f.run(), 0);
    expect(f.record()).toMatchObject({ phase: "merged", landed });
    expect(f.state().mutations).toBe(1);
  });

  it("rejects an async commit that differs from the authoritative PR receipt", () => {
    const { f } = asyncReceipt({ asyncMergeFault: "sha" });
    const run = expectExit(f.run(), 1);
    expect(run.output).toContain("async merge commit differs");
    expect(f.record().phase).toBe("intent");
    expect(f.state().posts).toBe(0);
  });

  const refusal = (
    name: string,
    state: Parameters<typeof configureMerge>[1],
    message: string,
    absent = true,
  ) => ({ name, state, message, absent });
  it.each([
    refusal("stack", { stack: { number: 7 } }, "stacked PRs require review", false),
    ...[
      { fault: "wrong-ref", afterReads: 0 },
      { fault: "wrong-type", afterReads: 1 },
      { fault: "missing-object", afterReads: 0 },
      { fault: "invalid-sha", afterReads: 1 },
    ].map(({ fault, afterReads }) =>
      refusal(
        "main " + fault,
        {
          quotaAt: "checks",
          restMainFault: fault,
          restMainFaultAfterReads: afterReads,
        },
        "REST merge fallback: main is unavailable",
      ),
    ),
    ...[
      "duplicate",
      "head",
      "app",
      "suite",
      "partial",
      "changed-total",
      "removed-suite",
      "duplicate-suite",
    ].map((restBulkFault) =>
      refusal(
        "bulk " + restBulkFault,
        {
          quotaAt: "checks",
          restUnseenSuite: "labeler",
          restUnseenSuiteCount: 173,
          restBulkFault,
        },
        "REST merge fallback:",
      ),
    ),
  ])("rejects $name evidence before dispatch", ({ state, message, absent }) => {
    const f = restFixture(state);
    const run = expectExit(f.run(), 1);
    expect(run.output).toContain(message);
    expect(f.state().mutations).toBe(0);
    if (absent) {
      expect(() => f.record()).toThrow();
    }
  });

  it("uses pinned REST without GraphQL for a blocked pooled viewer", () => {
    const f = restFixture({ pooledMergeBlocked: true });

    expectExit(f.run(), 0);
    expect(f.record()).toMatchObject({ phase: "complete", transport: "rest", head: f.head });
    expect(f.state()).toMatchObject({
      mutations: 1,
      restMergePayload: { sha: f.head, merge_method: "squash" },
    });
    expect(f.state().restMergePayload).not.toHaveProperty("commit_title");
    expect(f.state().nodeArgs).toEqual(resolveVitestNodeArgs());
    const { calls } = f.state();
    expect(calls.filter((call) => call.includes("PUT"))).toHaveLength(1);
    expect(
      calls.some((call) => call.includes("graphql") || (call[1] === "pr" && call[2] !== "view")),
    ).toBe(false);
  });

  it.each([
    { restReadFailure: "core", restReadFailuresRemaining: 1 },
    ...[unknownProjection, { mergeable: "UNKNOWN" }, { mergeStateStatus: "UNKNOWN" }].map((pr) => ({
      pr,
      observations: [{ pr: { mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" } }],
    })),
  ])(
    "settles REST read failure or UNKNOWN projection %j via one pinned GraphQL merge",
    (changes) => {
      const f = restFixture(changes);

      expectExit(f.run(), 0);
      expect(f.record()).toMatchObject({ phase: "complete", head: f.head });
      expect(f.record()).not.toHaveProperty("transport");
      expect(f.state()).toMatchObject({ restMergePayload: null, mutations: 1 });
      expectGraphqlSquash(f, f.state().mergeBody);
      expect(f.state().calls.some((call) => call[1] === "pr" && call[2] === "merge")).toBe(false);
    },
  );

  it.each(["head-changed", "unavailable"])(
    "refuses UNKNOWN REST admission when GraphQL is %s",
    (fault) => {
      const f = restFixture();
      configureMerge(f, {
        pr: { ...unknownProjection },
        quotaAt: fault === "unavailable" ? "observe" : "",
        observations: [
          { pr: { mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", headRefOid: f.base } },
        ],
      });

      const run = f.run();

      expect(run.status, run.output).not.toBe(0);
      expect(f.state()).toMatchObject({ mutations: 0, posts: 0 });
      expect(() => f.record()).toThrow();
      expect(f.captures()).toEqual([]);
    },
  );

  it.each(["identity", "policy"])(
    "prevents dispatch after final REST %s drift",
    (restDispatchChange) => {
      const f = restFixture({ restDispatchChange });

      const run = expectExit(f.run(), 1);
      expect(f.state().restDispatchChange).toBe("");
      expect(f.state()).toMatchObject({ mutations: 0, posts: 0 });
      expect(f.record()).toMatchObject({
        phase: "intent",
        accepted: false,
        transport: "rest",
        head: f.head,
      });
      expect(f.captures()).toHaveLength(1);
      expect(run.output).toContain(
        restDispatchChange === "identity"
          ? "immediate squash requires the prepared open, non-draft, clean PR head"
          : "PR or policy changed before merge dispatch",
      );
    },
  );

  it.each(["core", "secondary", "access"])(
    "prevents dispatch after unhandled REST %s failure",
    (failure) => {
      const f = restFixture({
        restReadFailure: failure,
        restReadFailuresRemaining: 1,
        quotaAt: "checks",
      });

      const run = f.run();

      expect(run.status, run.output).not.toBe(0);
      expect(f.state().mutations).toBe(0);
      expect(() => f.record()).toThrow();
      const { calls } = f.state();
      const fallbackChecks = calls.filter((call) => call[1] === "pr" && call[2] === "checks");
      expect(fallbackChecks).toHaveLength(failure === "core" ? 1 : 0);
      if (failure === "core") {
        expect(run.output).toContain("Neither GitHub transport");
      }
    },
  );

  it.each(["preview", "observe"])(
    "preserves human credit on REST fallback during %s",
    (quotaAt) => {
      const f = restFixture(
        {},
        "Repair\n\nCo-authored-by: Source <source@example.com>\nCo-authored-by: Codex <codex@openai.com>",
        undefined,
        false,
        { name: "Contributor", email: "contributor@example.com" },
      );
      configureMerge(f, { quotaAt, restReadFailure: "core", restReadFailuresRemaining: 1 });

      expectExit(f.run(), 0);
      expect(f.record()).toMatchObject({ phase: "complete", transport: "rest", head: f.head });
      expect(f.state().restMergePayload).toMatchObject({ sha: f.head, merge_method: "squash" });
      expect(f.state().mergeBody).toContain(
        "Co-authored-by: Contributor <contributor@example.com>",
      );
      expect(f.state().mergeBody).toContain("Co-authored-by: Source <source@example.com>");
      expect(f.state().mergeBody).not.toContain("codex@openai.com");
      expect(f.state()).toMatchObject({ mutations: 1, posts: 1 });
      expect(f.state().calls.some((call) => call[1] === "pr" && call[2] === "merge")).toBe(false);
      expect(f.git(["show", `${f.record().landed}:owner.txt`])).toBe("after");
      expect(existsSync(f.worktree)).toBe(false);
    },
  );

  it.each(["none", "head", "lifecycle", "main"])(
    "settles UNKNOWN via REST without hiding %s drift",
    (drift) => {
      const f = restFixture();
      configureMerge(f, {
        quotaAt: "observe",
        quotaAfterObservations: 1,
        restReadFailure: "core",
        restReadFailuresRemaining: 1,
        observations: [{ pr: unknownProjection }],
        restObservation: {
          pr: {
            mergeable: "MERGEABLE",
            mergeStateStatus: "CLEAN",
            ...(drift === "head" ? { headRefOid: f.base } : {}),
            ...(drift === "lifecycle" ? { state: "CLOSED" } : {}),
          },
          advanceMain: drift === "main",
        },
      });

      expectExit(f.run(), ["none", "main"].includes(drift) ? 0 : 1);
      expect(f.state()).toMatchObject({
        observationReads: 1,
        mutations: ["none", "main"].includes(drift) ? 1 : 0,
      });
      if (["none", "main"].includes(drift)) {
        expect(f.record()).toMatchObject({ phase: "complete", transport: "rest", head: f.head });
      } else {
        expect(() => f.record()).toThrow();
      }
    },
  );

  it.each(["before-evidence", "during-evidence"] as const)(
    "lands REST squash across %s main advance",
    (boundary) => {
      const f = restFixture();
      const main = f.commit(f.tree("before\n", "advanced\n"), [f.base]);
      configureMerge(f, {
        quotaAt: "checks",
        restMainAdvance: { boundary, observed: false, main },
      });

      expectExit(f.run(), 0);
      expect(f.record()).toMatchObject({
        phase: "complete",
        transport: "rest",
        head: f.head,
        main: f.base,
      });
      expect(f.state().restMainAdvance).toBeNull();
      expect(f.state()).toMatchObject({ mutations: 1, posts: 1 });
      expect(f.git(["show", `${f.record().landed}:owner.txt`])).toBe("after");
      expect(f.git(["show", `${f.record().landed}:sibling.txt`])).toBe("advanced");
    },
  );
  it.each([false, true])("retains prepared body across fallback (round trip=%s)", (roundTrip) => {
    const credit = "Co-authored-by: Contributor <contributor@example.com>";
    const f = restFixture({}, `Repair\n\n${credit}`);
    configureMerge(f, {
      quotaAt: "observe",
      restReadFailure: "core",
      ...(roundTrip
        ? { quotaFailuresRemaining: 1, restReadFailureAtMainReads: [1, 6] }
        : { quotaAfterObservations: 1, restReadFailuresRemaining: 1 }),
    });
    expectExit(f.run(), 0);
    expect(f.record()).toMatchObject({ phase: "complete", head: f.head });
    expect(f.state()).toMatchObject({ mergeBody: `Fixture body\n\n${credit}\n`, mutations: 1 });
    if (roundTrip) {
      expect(f.record()).not.toHaveProperty("transport");
      expect(f.state()).toMatchObject({ restReadFailureAtMainReads: [], restMergePayload: null });
    } else {
      expect(f.record()).toMatchObject({ transport: "rest" });
      expect(f.state()).toMatchObject({
        observationReads: 1,
        restMergePayload: { sha: f.head, merge_method: "squash" },
      });
    }
  });

  it.each(
    ["checks", "observe"].flatMap((quotaAt) =>
      ["merge", "rebase", "auto", "admin"].map((route) => ({ quotaAt, route })),
    ),
  )("rejects $route routing when GraphQL depletes during $quotaAt", ({ route, quotaAt }) => {
    const f = restFixture();
    const observationsBeforeFinal = quotaAt === "checks" ? 0 : route === "auto" ? 1 : 2;
    configureMerge(f, {
      quotaAt,
      quotaAfterObservations: observationsBeforeFinal,
      admin: route === "admin",
      gates: route === "admin" ? "fail" : "pass",
      ...(quotaAt === "observe" ? { restObservation: { gates: "pass" } } : {}),
    });
    if (route === "admin") {
      writeLocal(
        f,
        "gates.env",
        readLocal(f, "gates.env").replace("GATES_MODE=full", "GATES_MODE=remote_crabbox_aws"),
      );
    }

    expectExit(
      f.run(route === "auto", f.repo, route === "merge" || route === "rebase" ? route : "squash"),
      1,
    );
    if (quotaAt === "observe") {
      expect(f.state().observationReads).toBe(observationsBeforeFinal);
    }
    expect(f.state().mutations).toBe(0);
    expect(() => f.record()).toThrow();
  });

  it.each(["missing", "classic", "queue", "unsupported", "no-admin"])(
    "rejects %s policy before REST intent",
    (restPolicy) => {
      const f = restFixture();
      const state = f.state();
      if (restPolicy === "no-admin") {
        state.repoAuthority.permissions = { admin: false };
      }
      f.save({ ...state, quotaAt: "checks", restPolicy });

      const run = f.run();

      expect(run.status, run.output).not.toBe(0);
      expect(run.output).toContain(
        restPolicy === "missing" ? "REST merge fallback" : "Neither GitHub transport",
      );
      expect(
        f.state().calls.filter((call) => call[1] === "pr" && call[2] === "checks"),
      ).toHaveLength(restPolicy === "missing" ? 0 : 1);
      expect(f.state()).toMatchObject({ mutations: 0, posts: 0 });
      expect(() => f.record()).toThrow();
    },
  );

  it.each([
    { contexts: ["CI / checks? & +"], failedContext: "", admitted: true },
    { contexts: ["CI", "Quality"], failedContext: "", admitted: true },
    { contexts: ["CI", "Quality"], failedContext: "Quality", admitted: false },
  ])(
    "checks all contexts $contexts (failing=$failedContext)",
    ({ contexts, failedContext, admitted }) => {
      const f = restFixture({
        quotaAt: "checks",
        restContexts: contexts,
        restFailedContext: failedContext,
      });

      expectAdmission(f, admitted);
      const { calls } = f.state();
      const requests = calls
        .flatMap((call) =>
          call.filter(
            (arg) => arg.startsWith("repos/fixture/repo/commits/") && arg.includes("/check-runs?"),
          ),
        )
        .map((endpoint) => new URL(endpoint, "https://github.com"));
      expect(requests.length).toBeGreaterThan(0);
      expect(
        requests.every(
          (request) =>
            request.searchParams.get("check_name") === (contexts.length === 1 ? contexts[0] : null),
        ),
      ).toBe(true);
    },
  );

  it.each([
    evidenceCase({ restChecks: "bound-status" }, true),
    ...[
      "missing",
      "status-only",
      "wrong-app",
      "wrong-app-status",
      "failed",
      "failed-status",
      "inconsistent-status",
    ].map((fault) =>
      evidenceCase({
        restChecks: fault,
        restCheckApp: fault.startsWith("wrong-app") ? 999 : 15368,
        gates: fault === "failed" ? "fail" : "pass",
      }),
    ),
    ...[
      "same-workflow",
      "other-workflow",
      "other-event",
      "missing-mapping",
      "ambiguous-mapping",
      "same-time",
      "missing-time",
    ].map((restDuplicate) => evidenceCase({ restDuplicate }, restDuplicate === "same-workflow")),
    ...[999, 1_000].map((restUnseenSuiteCount) =>
      evidenceCase(
        { restUnseenSuite: "queued-empty-custom", restUnseenSuiteCount },
        restUnseenSuiteCount === 999,
      ),
    ),
    evidenceCase({ restSuite: "rerunning" }),
    ...[
      { restUnseenSuite: "pending", admitted: false },
      { restUnseenSuite: "failed", admitted: false },
      { restUnseenSuite: "partial-pending", admitted: false },
      { restUnseenSuite: "other-app", admitted: true },
      { restUnseenSuite: "labeler", admitted: true },
      { restUnseenSuite: "hidden-skipped", admitted: false },
      { restUnseenSuite: "irrelevant-failure", admitted: true },
      { restUnseenSuite: "changed-suite", admitted: false },
      { restUnseenSuite: "incomplete-suite", admitted: false },
      { restUnseenSuite: "missing-version", admitted: false },
      { restUnseenSuite: "missing-count", admitted: false },
      { restUnseenSuite: "changed-count", admitted: false },
      { restUnseenSuite: "queued-empty-unbound", restRequiredApp: null, admitted: true },
      { restUnseenSuite: "queued-empty-custom", restRequiredApp: 45678, admitted: true },
      { restUnseenSuite: "queued-empty-drift", admitted: false },
    ].map(({ restUnseenSuite, restRequiredApp = 15368, admitted }) =>
      evidenceCase(
        { restUnseenSuite, restRequiredApp, restCheckApp: restRequiredApp ?? 15368 },
        admitted,
      ),
    ),
  ])("admits REST merge only with complete check evidence: $state", ({ state, admitted }) => {
    const f = restFixture({ quotaAt: "checks", ...state });
    expectAdmission(f, admitted);
  });

  it.each(["queued-empty-custom", "labeler"])(
    "bounds REST evidence reads for 173 %s suites",
    (restUnseenSuite) => {
      const f = restFixture({
        quotaAt: "checks",
        restUnseenSuite,
        restUnseenSuiteCount: 173,
      });
      expectAdmission(f);
      const { calls } = f.state();
      const checkCalls = calls.filter((call) =>
        call.some((arg) => /\/check-(runs|suites)[/?]/.test(arg)),
      );
      // A full native attempt may reread evidence, but request count must not
      // grow as two subprocesses per suite (346 calls per observation).
      expect(checkCalls.length).toBeLessThan(40);
    },
  );

  it.each([
    "supported",
    "classic",
    "queue",
    "unsupported",
    "no-admin",
    "main-advance",
    "open-main-advance",
    "unknown-projection",
  ])("reconciles a lost REST reply across %s policy drift", (restPolicy) => {
    const f = restFixture({ quotaAt: "checks", mode: "applied-open" });
    expectExit(f.run(), 1);
    expect(f.record()).toMatchObject({ phase: "intent", transport: "rest", accepted: false });
    expect(f.state().mutations).toBe(1);
    const intent = f.git(["rev-parse", outcomeRef]);
    const captures = f.captures();
    const landed = f.git(["--git-dir=" + f.remote, "rev-parse", "main"]);
    f.recover();
    const state = f.state();
    if (restPolicy === "no-admin") {
      state.repoAuthority.permissions = { admin: false };
    }
    if (restPolicy === "unknown-projection") {
      Object.assign(state.pr, unknownProjection);
    }
    if (restPolicy === "open-main-advance") {
      state.restMainAdvance = {
        boundary: "during-evidence",
        observed: false,
        main: f.commit(
          f.git(["rev-parse", `${landed}^{tree}`]),
          [landed],
          "Open receipt advance\n",
        ),
      };
    }
    f.save({ ...state, restPolicy });

    const unresolved = expectExit(f.run(), 1);
    expectRetained(f, intent, captures);
    expect(f.state().mutations).toBe(1);
    if (restPolicy === "open-main-advance") {
      expect(f.state().restMainAdvance).toBeNull();
      expect(unresolved.output).toContain("main changed while reading evidence");
    }
    f.recover();
    observeMerged(f, landed, { gates: "fail", restAdvanceMain: restPolicy === "main-advance" });

    expectExit(f.run(), 0);
    expect(f.record()).toMatchObject({
      phase: "merged",
      transport: "rest",
      landed,
      head: f.head,
    });
    expect(f.state()).toMatchObject({ mutations: 1, posts: 0 });
    expect(f.state().mainAdvances).toHaveLength(restPolicy === "main-advance" ? 1 : 0);
  });

  it("never replays an exhausted GraphQL mutation through REST", () => {
    const f = configuredFixture(fixture, { quotaAt: "mutation" });
    const { previous: intent } = retainIntent(f, 1);
    expect(f.record()).toMatchObject({ phase: "intent", accepted: false });
    expect(f.state()).toMatchObject({ mutations: 1, restMergePayload: null });
    f.recover();

    expectExit(f.run(), 1);
    expect(f.git(["rev-parse", outcomeRef])).toBe(intent);
    expect(f.state()).toMatchObject({ mutations: 1, restMergePayload: null });
  });
});
