import { expect, it } from "vitest";
import { createMergeOutcomeFixtureHarness } from "./pr-merge-outcome.test-support.js";
import { createPriorCiCandidateFactory } from "./pr-merge-prior-ci.test-support.js";
import { landingSnapshotQuery } from "./pr-merge-snapshot.test-support.js";

const { fixture, describePosix, outcomeRef } = createMergeOutcomeFixtureHarness();
const { preExistingCandidate } = createPriorCiCandidateFactory(fixture);
type Candidate = ReturnType<typeof preExistingCandidate>;

function unknownGraphqlCandidate() {
  const f = preExistingCandidate();
  f.save({ ...f.state(), graphqlMergeProjection: { mergeStateStatus: "UNKNOWN" } });
  return f;
}

function expectNoDispatch(f: Candidate) {
  expect(f.state()).toMatchObject({ mutations: 0, posts: 0, restMergePayload: null });
  expect(() => f.git(["rev-parse", "--verify", outcomeRef])).toThrow();
  expect(f.captures()).toEqual([]);
}

describePosix("prior-CI whole REST observation fallback", () => {
  it("does not reopen REST observation after final authority when main keeps advancing", () => {
    const f = unknownGraphqlCandidate();
    f.save({
      ...f.state(),
      restObservations: [{}, {}, {}, { advanceMain: true }, { advanceMain: true }],
    });

    const result = f.adminPriorCi(f.path);

    expect(result.status, result.output).toBe(0);
    expect(f.state().mutations).toBe(1);
    expect(f.record()).toMatchObject({ phase: "complete", head: f.head });
    expect(f.git(["rev-parse", `${f.record().landed}^1`])).toBe(f.state().mainAdvances[0]);
  });

  it.each([1, 4])(
    "preserves prior-CI admission when GraphQL quota expires after %s known observations",
    (observations) => {
      const f = preExistingCandidate();
      f.save({ ...f.state(), quotaAt: "observe", quotaAfterObservations: observations });

      const result = f.adminPriorCi(f.path);

      const state = f.state();
      expect(
        result.status,
        result.output +
          JSON.stringify({
            mutations: state.mutations,
            posts: state.posts,
            calls: state.calls.slice(-12),
          }),
      ).toBe(0);
      expect(state).toMatchObject({
        observationReads: observations,
        mutations: 1,
        posts: 1,
        gates: "fail",
        restMergePayload: { sha: f.head, merge_method: "squash" },
      });
      expect(f.record()).toMatchObject({
        phase: "complete",
        transport: "rest",
        route: "admin",
        head: f.head,
        priorCiAdmin: { head: f.head, dispatchTransport: "rest" },
      });
      const dispatch = state.calls.findIndex(
        (call) => call.includes("repos/fixture/repo/pulls/123/merge") && call.includes("PUT"),
      );
      const reads = state.calls.slice(0, dispatch);
      const finalRestRead = reads.findLastIndex((call) =>
        call.includes("repos/fixture/repo/git/ref/heads/main"),
      );
      expect(finalRestRead).toBeGreaterThan(0);
      expect(
        reads.findLastIndex((call) => call.includes("orgs/fixture/memberships/fixture-operator")),
      ).toBeGreaterThan(finalRestRead);
    },
  );

  it.each([
    ["admin", "active organization admin"],
    ["review", "current enforced reviews must be satisfied"],
    ["security", "unsuccessful openclaw/security-sensitive-review"],
  ] as const)(
    "rechecks %s revoked during the first REST read after final GraphQL quota expiry",
    (fault, diagnostic) => {
      const f = preExistingCandidate();
      const state = f.state();
      f.save({
        ...state,
        quotaAt: "observe",
        quotaAfterObservations: 4,
        restObservation: {
          priorCi:
            fault === "admin"
              ? { membership: "member" }
              : fault === "review"
                ? { reviewDecision: "REVIEW_REQUIRED" }
                : { security: { ...state.priorCi.security, fault: "failed-guard" } },
        },
      });

      const result = f.adminPriorCi(f.path);

      expect(result.status, result.output).toBe(1);
      expect(result.output).toContain(diagnostic);
      expect(f.state().observationReads).toBe(4);
      expect(f.state().restObservationAppliedAt).toBeGreaterThan(0);
      expectNoDispatch(f);
    },
  );

  it.each(["stability", "final authority"])(
    "settles a recalculated projection after forward main during %s",
    (stage) => {
      const f = unknownGraphqlCandidate();
      const main = f.commit(f.tree("before\n", "advanced\n"), [f.base]);
      f.save({
        ...f.state(),
        restObservations: [
          ...Array.from({ length: stage === "stability" ? 1 : 3 }, () => ({})),
          { main, pr: { mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" } },
          { pr: { mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED" } },
        ],
      });

      const result = f.adminPriorCi(f.path);

      expect(result.status, result.output).toBe(0);
      expect(f.state()).toMatchObject({
        mutations: 1,
        posts: 1,
        restMergePayload: { sha: f.head, merge_method: "squash" },
        settlementSleeps: [1, 1],
      });
      expect(f.record()).toMatchObject({ phase: "complete", head: f.head, main: f.base });
      expect(f.git(["rev-parse", `${f.record().landed}^1`])).toBe(main);
      const calls = f.state().calls.slice(
        0,
        f
          .state()
          .calls.findIndex(
            (call) => call.includes("repos/fixture/repo/pulls/123/merge") && call.includes("PUT"),
          ),
      );
      const finalMainRead = calls.findLastIndex((call) =>
        call.includes("repos/fixture/repo/git/ref/heads/main"),
      );
      expect(
        calls.findLastIndex((call) => call.includes("orgs/fixture/memberships/fixture-operator")),
      ).toBeGreaterThan(finalMainRead);
    },
  );

  it.each(["same main", "persistent", "conflict", "known status", "policy", "head", "rewind"])(
    "refuses %s during projection recalculation without dispatch",
    (fault) => {
      const f = unknownGraphqlCandidate();
      const main = f.commit(f.tree("before\n", "advanced\n"), [f.base]);
      const restored = { mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED" };
      f.save({
        ...f.state(),
        restObservations: [
          {},
          {
            main: fault === "same main" ? f.base : main,
            pr: { mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" },
          },
          ...(fault === "persistent" || fault === "same main"
            ? []
            : [
                {
                  ...(fault === "rewind" ? { main: f.base } : {}),
                  pr: {
                    ...restored,
                    ...(fault === "conflict"
                      ? { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }
                      : {}),
                    ...(fault === "known status" ? { mergeStateStatus: "CLEAN" } : {}),
                    ...(fault === "head" ? { headRefOid: f.base } : {}),
                  },
                  ...(fault === "policy" ? { priorCi: { reviewCount: 2 } } : {}),
                },
              ]),
        ],
      });

      const result = f.adminPriorCi(f.path);

      expect(result.status, result.output).not.toBe(0);
      expect(result.output).toContain(
        fault === "persistent"
          ? "mergeability recalculation remained UNKNOWN after 3 observations"
          : fault === "rewind"
            ? "both observed and verified main"
            : "PR or main changed during observation",
      );
      expect(f.state().settlementSleeps).toEqual(
        fault === "same main" ? [1] : fault === "persistent" ? [1, 1, 2] : [1, 1],
      );
      expectNoDispatch(f);
    },
  );

  it.each(["rewind", "divergence", "same-main UNKNOWN"])(
    "checks %s against the latest accepted main rather than the intent anchor",
    (fault) => {
      const f = unknownGraphqlCandidate();
      const main = f.commit(f.tree("before\n", "advanced\n"), [f.base]);
      const next =
        fault === "rewind"
          ? f.base
          : fault === "divergence"
            ? f.commit(f.tree("before\n", "divergent\n"), [f.base])
            : main;
      f.save({
        ...f.state(),
        restObservations: [
          {},
          { main },
          {
            main: next,
            ...(fault === "same-main UNKNOWN"
              ? { pr: { mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" } }
              : {}),
          },
        ],
      });
      const result = f.adminPriorCi(f.path);
      expect(result.status, result.output).not.toBe(0);
      expect(result.output).toContain(
        fault === "same-main UNKNOWN"
          ? "PR or main changed during observation"
          : "both observed and verified main",
      );
      expect(f.state().settlementSleeps).toEqual([1]);
      expectNoDispatch(f);
    },
  );

  it.each(["remote-only main", "revoked admin"])(
    "rechecks authority after %s during the final REST materialization",
    (fault) => {
      const f = unknownGraphqlCandidate();
      const main = f.commit(f.tree("before\n", "advanced\n"), [f.base]);
      const state = f.state();
      state.priorCi.revokeAdminOnMainFetch = true;
      state.restObservations = [
        {},
        {},
        {},
        { main, pr: { mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" } },
        {
          pr: { mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED" },
          ...(fault === "remote-only main"
            ? { advanceMain: true }
            : { priorCi: { membership: "member" } }),
        },
      ];
      f.save(state);
      const result = f.adminPriorCi(f.path);
      expect(result.status, result.output).not.toBe(0);
      expect(result.output).toContain("writer must be an active organization admin");
      expect(f.state().priorCi.adminRevokedDuringMainFetch).toBe(fault === "remote-only main");
      expectNoDispatch(f);
    },
  );

  it("lands qualified blocked CI through a complete REST observation after GraphQL remains UNKNOWN", () => {
    const f = unknownGraphqlCandidate();
    const result = f.adminPriorCi(f.path);
    expect(result.status, result.output).toBe(0);
    const state = f.state();
    expect(state).toMatchObject({
      mutations: 1,
      posts: 1,
      gates: "fail",
      restMergePayload: { sha: f.head, merge_method: "squash" },
    });
    const dispatch = state.calls.findIndex(
      (call) => call.includes("repos/fixture/repo/pulls/123/merge") && call.includes("PUT"),
    );
    expect(dispatch).toBeGreaterThan(0);
    const reads = state.calls.slice(0, dispatch);
    expect(reads.filter((call) => call.includes(landingSnapshotQuery))).toHaveLength(1);
    const finalRestRead = reads.findLastIndex((call) =>
      call.includes("repos/fixture/repo/git/ref/heads/main"),
    );
    expect(finalRestRead).toBeGreaterThan(0);
    expect(
      reads.filter((call) => call.includes("repos/fixture/repo/git/ref/heads/main")),
    ).toHaveLength(8);
    expect(
      reads.filter((call) => call.includes("orgs/fixture/memberships/fixture-operator")),
    ).toHaveLength(2);
    expect(
      reads.findLastIndex((call) => call.includes("orgs/fixture/memberships/fixture-operator")),
    ).toBeGreaterThan(finalRestRead);
    expect(f.record()).toMatchObject({
      phase: "complete",
      route: "admin",
      transport: "rest",
      head: f.head,
      priorCiAdmin: { head: f.head, runId: 501, runAttempt: 2, dispatchTransport: "rest" },
    });
    expect(f.git(["rev-parse", `${f.record().landed}^1`])).toBe(f.base);
  });

  it("lands the pinned head when main advances within a complete REST observation", () => {
    const f = unknownGraphqlCandidate();
    f.save({ ...f.state(), restObservation: { advanceMain: true } });

    const result = f.adminPriorCi(f.path);

    expect(result.status, result.output).toBe(0);
    const state = f.state();
    expect(state.mainAdvances).toHaveLength(1);
    expect(state.restObservationAppliedAt).toBe(1);
    expect(state).toMatchObject({
      mutations: 1,
      gates: "fail",
      restMergePayload: { sha: f.head, merge_method: "squash" },
    });
    expect(f.git(["rev-parse", `${f.record().landed}^1`])).toBe(state.mainAdvances[0]);
    expect(f.record()).toMatchObject({ phase: "complete", head: f.head });
    expect(f.record()).not.toHaveProperty("mainBefore");
    const prefix = "REST merge observation: ";
    const diagnostics = result.output
      .split("\n")
      .filter((line) => line.startsWith(prefix))
      .map((line) => JSON.parse(line.slice(prefix.length)));
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        transport: "rest",
        requestedGhRoute: "plain",
        observedGhRoute: "unrecorded",
        mainBefore: f.base,
        mainAfter: state.mainAdvances[0],
        startedAtMs: expect.any(Number),
        finishedAtMs: expect.any(Number),
        elapsedMs: expect.any(Number),
      }),
    );
  });

  it.each(["rewind", "divergence", "conflict", "empty change", "policy"] as const)(
    "refuses %s within a REST observation before dispatch",
    (fault) => {
      const f = unknownGraphqlCandidate();
      const state = f.state();
      const first = f.commit(f.tree("before\n", "first advance\n"), [f.base]);
      state.observations = [{ main: first }];
      const main =
        fault === "rewind"
          ? f.base
          : f.commit(
              f.tree(
                fault === "conflict"
                  ? "conflicting main\n"
                  : fault === "empty change"
                    ? "resolved conflict\n"
                    : "before\n",
                "next advance\n",
              ),
              [fault === "divergence" ? f.base : first],
            );
      state.restObservation = {
        main,
        afterPolicyRead: true,
        ...(fault === "policy" ? { priorCi: { reviewCount: 2 } } : {}),
      };
      f.save(state);

      const result = f.adminPriorCi(f.path);

      expect(result.status, result.output).not.toBe(0);
      expect(result.output).toContain(
        fault === "policy"
          ? "branch policy changed while reading evidence"
          : fault === "conflict"
            ? "cannot establish prepared-head merge tree"
            : fault === "empty change"
              ? "NO NET CHANGE"
              : "both observed and verified main",
      );
      expectNoDispatch(f);
    },
  );

  it.each(["start", "end"] as const)(
    "requires final REST %s materialization before authority",
    (endpoint) => {
      const f = unknownGraphqlCandidate();
      const state = f.state();
      state.priorCi.revokeAdminOnMainFetch = true;
      if (endpoint === "start") {
        state.restMainFault = "unavailable-sha-once";
        state.restMainFaultAfterReads = 6;
      } else {
        state.restObservation = { advanceMain: true, afterRestMainReads: 7 };
      }
      f.save(state);

      const result = f.adminPriorCi(f.path);

      expect(result.status, result.output).not.toBe(0);
      expect(result.output).toContain(
        endpoint === "start" ? "cannot fetch authoritative main" : "active organization admin",
      );
      expect(f.state().priorCi.adminRevokedDuringMainFetch).toBe(endpoint === "end");
      expect(f.state().restMainReads).toBe(8);
      expectNoDispatch(f);
    },
  );

  it("keeps an unknown prior-CI outcome fenced when main moves inside reconciliation", () => {
    const f = unknownGraphqlCandidate();
    const main = f.commit(f.tree("before\n", "advanced\n"), [f.base]);
    f.save({
      ...f.state(),
      mode: "unapplied",
      restMainAdvance: { boundary: "during-evidence", observed: false, main },
    });

    const result = f.adminPriorCi(f.path);

    expect(result.status, result.output).not.toBe(0);
    expect(result.output).toContain(
      "main changed while reading evidence outside active prior-CI admission",
    );
    expect(f.state().mutations).toBe(1);
    expect(f.state().posts).toBe(0);
    expect(f.captures()).toHaveLength(1);
    expect(f.record()).toMatchObject({ phase: "intent", accepted: false, head: f.head });
  });

  it.each([
    ["head", "Merge precondition headRefOid"],
    ["lifecycle", "require OPEN"],
    ["known projection", "PR or main changed while waiting for mergeability"],
    ["conflict", "no conflicts"],
    ["unknown", "mergeability remained UNKNOWN"],
    ["malformed projection", "invalid PR identity or lifecycle evidence"],
    ["renewed auto", "open PR already has an auto-merge request"],
    ["queue policy", "unsupported effective branch rule"],
    ["changed policy", "evidence or authority changed during admission"],
    ["CI attempt", "newer or running CI attempt"],
  ] as const)(
    "refuses REST %s rather than combining incompatible observations",
    (fault, diagnostic) => {
      const f = unknownGraphqlCandidate();
      const state = f.state();
      const observation: NonNullable<typeof state.restObservation> = {};
      if (fault === "head") {
        observation.pr = { headRefOid: f.base };
      }
      if (fault === "lifecycle") {
        observation.pr = { state: "CLOSED" };
      }
      if (fault === "known projection") {
        state.graphqlMergeProjection = { mergeable: "UNKNOWN", mergeStateStatus: "BLOCKED" };
        observation.pr = { mergeStateStatus: "CLEAN" };
      }
      if (fault === "conflict") {
        observation.pr = { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" };
      }
      if (fault === "unknown") {
        observation.pr = { mergeStateStatus: "UNKNOWN" };
      }
      if (fault === "malformed projection") {
        observation.pr = { mergeStateStatus: "NOT_A_STATE" };
      }
      if (fault === "renewed auto") {
        observation.pr = { autoMergeRequest: { mergeMethod: "SQUASH" } };
      }
      if (fault === "queue policy") {
        observation.restPolicy = "queue";
      }
      if (fault === "changed policy") {
        observation.priorCi = { reviewCount: 2 };
      }
      if (fault === "CI attempt") {
        observation.priorCi = { latestAttempt: 3 };
      }
      state.restObservation = observation;
      f.save(state);

      const result = f.adminPriorCi(f.path);
      expect(result.status, result.output).toBe(1);
      expect(result.output).toContain(diagnostic);
      expect(f.state().restObservationAppliedAt).toBe(1);
      expectNoDispatch(f);
    },
  );

  it("does not replace a known GraphQL conflict with a mergeable REST projection", () => {
    const f = unknownGraphqlCandidate();
    f.save({
      ...f.state(),
      graphqlMergeProjection: { mergeable: "CONFLICTING", mergeStateStatus: "UNKNOWN" },
    });
    const result = f.adminPriorCi(f.path);
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain("no conflicts");
    expect(f.state().restMainReads).toBe(0);
    expectNoDispatch(f);
  });

  it.each(["head", "unknown"] as const)("refuses %s in the final REST snapshot", (fault) => {
    const f = unknownGraphqlCandidate();
    f.save({
      ...f.state(),
      restObservation: {
        afterRestMainReads: 7,
        pr: fault === "head" ? { headRefOid: f.base } : { mergeStateStatus: "UNKNOWN" },
      },
    });
    const result = f.adminPriorCi(f.path);
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain("PR or main changed during observation");
    expect(f.state().restObservationAppliedAt).toBe(7);
    expectNoDispatch(f);
  });

  it.each([
    ["admin", "active organization admin"],
    ["review", "current enforced reviews must be satisfied"],
    ["security", "unsuccessful openclaw/security-sensitive-review"],
  ] as const)(
    "revalidates %s authority revoked by the final complete REST read",
    (fault, diagnostic) => {
      const f = unknownGraphqlCandidate();
      const state = f.state();
      state.restObservation = {
        // Revoke at the last observation boundary, before final authority verification.
        afterRestMainReads: 8,
        priorCi:
          fault === "admin"
            ? { membership: "member" }
            : fault === "review"
              ? { reviewDecision: "REVIEW_REQUIRED" }
              : { security: { ...state.priorCi.security, fault: "failed-guard" } },
      };
      f.save(state);
      const result = f.adminPriorCi(f.path);
      expect(result.status, result.output).toBe(1);
      expect(result.output).toContain(diagnostic);
      const finalState = f.state();
      expect(finalState.restObservationAppliedAt).toBe(8);
      expect(finalState.restMainReads).toBe(finalState.restObservationAppliedAt);
      expect(
        finalState.calls.findLastIndex((call) =>
          call.includes("orgs/fixture/memberships/fixture-operator"),
        ),
      ).toBeGreaterThan(
        finalState.calls.findLastIndex((call) =>
          call.includes("repos/fixture/repo/git/ref/heads/main"),
        ),
      );
      expectNoDispatch(f);
    },
  );

  it.each([
    ["fail", "REST fallback does not authorize an admin bypass"],
    ["pass", "selected merge route is blocked by policy"],
  ])(
    "keeps ordinary REST admission strict for blocked projection with %s checks",
    (gates, diagnostic) => {
      const f = fixture();
      f.save({
        ...f.state(),
        restPolicy: "rules",
        gates,
        pr: { ...f.state().pr, mergeStateStatus: "BLOCKED" },
      });
      const result = f.run();
      expect(result.status, result.output).toBe(1);
      expect(result.output).toContain(diagnostic);
      expect(f.state().mutations).toBe(0);
      expect(() => f.record()).toThrow();
    },
  );
});
