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
    ).toHaveLength(10);
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
    ["main within snapshot", "main changed while reading evidence"],
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
      if (fault === "main within snapshot") {
        observation.advanceMain = true;
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
        postAuthorityRestBoundary: "start",
        pr: fault === "head" ? { headRefOid: f.base } : { mergeStateStatus: "UNKNOWN" },
      },
    });
    const result = f.adminPriorCi(f.path);
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain("PR or main changed during observation");
    expect(f.state().restObservationAppliedAt).toBe(9);
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
        // Revoke after the complete observation that follows the existing final authority check.
        postAuthorityRestBoundary: "complete",
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
      expect(finalState.restObservationAppliedAt).toBe(10);
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
