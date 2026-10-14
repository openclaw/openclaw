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

function readsBeforeDispatch(f: Candidate) {
  const calls = f.state().calls;
  const dispatch = calls.findIndex(
    (call) => call.includes("repos/fixture/repo/pulls/123/merge") && call.includes("PUT"),
  );
  expect(dispatch).toBeGreaterThan(0);
  return calls.slice(0, dispatch);
}

function expectFinalAuthority(calls: ReturnType<Candidate["state"]>["calls"]) {
  const finalMainRead = calls.findLastIndex((call) =>
    call.includes("repos/fixture/repo/git/ref/heads/main"),
  );
  expect(finalMainRead).toBeGreaterThan(0);
  expect(
    calls.findLastIndex((call) => call.includes("orgs/fixture/memberships/fixture-operator")),
  ).toBeGreaterThan(finalMainRead);
}

describePosix("prior-CI whole REST observation fallback", () => {
  it.each([
    "stable",
    "missing REST commit",
    "continuing main",
    "within read",
    "stability",
    "final authority",
    "recalculated status",
  ])("lands the pinned head after complete REST admission: %s", (stage) => {
    const f = unknownGraphqlCandidate();
    const state = f.state();
    if (stage === "missing REST commit") {
      state.restMergeCommit = "missing";
    }
    const recalculating = ["stability", "final authority", "recalculated status"].includes(stage);
    const main = recalculating ? f.commit(f.tree("before\n", "advanced\n"), [f.base]) : f.base;
    if (recalculating) {
      state.restObservations = [
        ...Array.from({ length: stage === "final authority" ? 3 : 1 }, () => ({})),
        { main, pr: { mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" } },
        {
          pr: {
            mergeable: "MERGEABLE",
            mergeStateStatus: stage === "recalculated status" ? "CLEAN" : "BLOCKED",
          },
        },
      ];
    } else if (stage === "continuing main") {
      state.restObservations = [{}, {}, {}, { advanceMain: true }, { advanceMain: true }];
    } else if (stage === "within read") {
      state.restObservation = { advanceMain: true };
    }
    f.save(state);
    const result = f.adminPriorCi(f.path);
    expect(result.status, result.output).toBe(0);
    const final = f.state();
    expect(final).toMatchObject({
      mutations: 1,
      posts: 1,
      gates: "fail",
      restMergePayload: { sha: f.head, merge_method: "squash" },
    });
    expect(f.record()).toMatchObject({ phase: "complete", head: f.head });
    expect(f.git(["rev-parse", `${f.record().landed}^1`])).toBe(
      stage === "continuing main" || stage === "within read" ? final.mainAdvances[0] : main,
    );
    if (recalculating) {
      expect(final.settlementSleeps).toEqual([1, 1]);
      expect(f.record().main).toBe(f.base);
      expectFinalAuthority(readsBeforeDispatch(f));
    }
    if (stage === "stable" || stage === "missing REST commit") {
      const reads = readsBeforeDispatch(f);
      expect(reads.filter((call) => call.includes(landingSnapshotQuery))).toHaveLength(1);
      expect(
        reads.filter((call) => call.includes("repos/fixture/repo/git/ref/heads/main")),
      ).toHaveLength(8);
      expect(
        reads.filter((call) => call.includes("orgs/fixture/memberships/fixture-operator")),
      ).toHaveLength(2);
      expectFinalAuthority(reads);
      expect(f.record()).toMatchObject({
        route: "admin",
        transport: "rest",
        priorCiAdmin: { head: f.head, runId: 501, runAttempt: 2, dispatchTransport: "rest" },
      });
      expect(final.graphqlMergePayloads).toEqual([]);
      expect(
        final.observationReads > reads.filter((call) => call.includes(landingSnapshotQuery)).length,
      ).toBe(stage === "missing REST commit");
    }
    if (stage === "within read") {
      expect(final.mainAdvances).toHaveLength(1);
      expect(final.restObservationAppliedAt).toBe(1);
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
          mainAfter: final.mainAdvances[0],
          startedAtMs: expect.any(Number),
          finishedAtMs: expect.any(Number),
          elapsedMs: expect.any(Number),
        }),
      );
    }
  });

  it("refuses a missing merged receipt during active prior-CI admission", () => {
    const f = unknownGraphqlCandidate();
    f.save({
      ...f.state(),
      restMergeCommit: "missing",
      restObservation: {
        afterRestMainReads: 7,
        pr: { state: "MERGED", mergeCommit: { oid: f.base } },
      },
    });
    const result = f.adminPriorCi(f.path);
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain(
      "merged PR receipt became unavailable during active prior-CI admission",
    );
    expect(f.state().observationReads).toBe(1);
    expectNoDispatch(f);
  });

  it.each([1, 4])(
    "preserves prior-CI admission when GraphQL quota expires after %s known observations",
    (observations) => {
      const f = preExistingCandidate();
      f.save({ ...f.state(), quotaAt: "observe", quotaAfterObservations: observations });
      const result = f.adminPriorCi(f.path);
      expect(result.status, result.output).toBe(0);
      expect(f.state()).toMatchObject({
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
      expectFinalAuthority(readsBeforeDispatch(f));
    },
  );

  it.each(
    (
      [
        ["admin", "active organization admin"],
        ["review", "current enforced reviews must be satisfied"],
        ["security", "unsuccessful openclaw/security-sensitive-review"],
      ] as const
    ).flatMap(([fault, diagnostic]) =>
      (["quota expiry", "final REST read"] as const).map((boundary) => ({
        fault,
        diagnostic,
        boundary,
      })),
    ),
  )("rechecks $fault revoked at $boundary", ({ fault, diagnostic, boundary }) => {
    const quota = boundary === "quota expiry";
    const f = quota ? preExistingCandidate() : unknownGraphqlCandidate();
    const state = f.state();
    state.restObservation = {
      ...(quota ? {} : { afterRestMainReads: 8 }),
      priorCi:
        fault === "admin"
          ? { membership: "member" }
          : fault === "review"
            ? { reviewDecision: "REVIEW_REQUIRED" }
            : { security: { ...state.priorCi.security, fault: "failed-guard" } },
    };
    if (quota) {
      state.quotaAt = "observe";
      state.quotaAfterObservations = 4;
    }
    f.save(state);
    const result = f.adminPriorCi(f.path);
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain(diagnostic);
    const final = f.state();
    if (quota) {
      expect(final.observationReads).toBe(4);
      expect(final.restObservationAppliedAt).toBeGreaterThan(0);
    } else {
      expect(final.restObservationAppliedAt).toBe(8);
      expect(final.restMainReads).toBe(final.restObservationAppliedAt);
      expectFinalAuthority(final.calls);
    }
    expectNoDispatch(f);
  });

  it.each([
    ["same main", false],
    ["persistent", false],
    ["conflict", false],
    ["policy", false],
    ["head", false],
    ["rewind", false],
    ["rewind", true],
    ["divergence", true],
    ["same-main UNKNOWN", true],
  ] as const)(
    "refuses %s against the latest accepted main (already advanced=%s)",
    (fault, advanced) => {
      const f = unknownGraphqlCandidate();
      const main = f.commit(f.tree("before\n", "advanced\n"), [f.base]);
      const state = f.state();
      if (advanced) {
        const next =
          fault === "rewind"
            ? f.base
            : fault === "divergence"
              ? f.commit(f.tree("before\n", "divergent\n"), [f.base])
              : main;
        state.restObservations = [
          {},
          { main },
          {
            main: next,
            ...(fault === "same-main UNKNOWN"
              ? { pr: { mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" } }
              : {}),
          },
        ];
      } else {
        state.restObservations = [
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
                    mergeable: fault === "conflict" ? "CONFLICTING" : "MERGEABLE",
                    mergeStateStatus: fault === "conflict" ? "DIRTY" : "BLOCKED",
                    ...(fault === "head" ? { headRefOid: f.base } : {}),
                  },
                  ...(fault === "policy" ? { priorCi: { reviewCount: 2 } } : {}),
                },
              ]),
        ];
      }
      f.save(state);
      const result = f.adminPriorCi(f.path);
      expect(result.status, result.output).not.toBe(0);
      expect(result.output).toContain(
        fault === "persistent"
          ? "mergeability recalculation remained UNKNOWN after 3 observations"
          : fault === "rewind" || fault === "divergence"
            ? "both observed and verified main"
            : "PR or main changed during observation",
      );
      expect(f.state().settlementSleeps).toEqual(
        advanced || fault === "same main" ? [1] : fault === "persistent" ? [1, 1, 2] : [1, 1],
      );
      expectNoDispatch(f);
    },
  );

  it.each(["start", "end", "recalculated remote-only main", "recalculated revoked admin"])(
    "materializes %s before final authority",
    (boundary) => {
      const f = unknownGraphqlCandidate();
      const state = f.state();
      state.priorCi.revokeAdminOnMainFetch = true;
      if (boundary === "start") {
        state.restMainFault = "unavailable-sha-once";
        state.restMainFaultAfterReads = 6;
      } else if (boundary === "end") {
        state.restObservation = { advanceMain: true, afterRestMainReads: 7 };
      } else {
        const main = f.commit(f.tree("before\n", "advanced\n"), [f.base]);
        state.restObservations = [
          {},
          {},
          {},
          { main, pr: { mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" } },
          {
            pr: { mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED" },
            ...(boundary === "recalculated remote-only main"
              ? { advanceMain: true }
              : { priorCi: { membership: "member" } }),
          },
        ];
      }
      f.save(state);
      const result = f.adminPriorCi(f.path);
      expect(result.status, result.output).not.toBe(0);
      expect(result.output).toContain(
        boundary === "start"
          ? "cannot fetch authoritative main"
          : "writer must be an active organization admin",
      );
      expect(f.state().priorCi.adminRevokedDuringMainFetch).toBe(
        boundary === "end" || boundary === "recalculated remote-only main",
      );
      if (boundary === "start" || boundary === "end") {
        expect(f.state().restMainReads).toBe(8);
      }
      expectNoDispatch(f);
    },
  );

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
    expect(f.state()).toMatchObject({ mutations: 1, posts: 0 });
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
    ["GraphQL conflict", "no conflicts"],
    ["final head", "PR or main changed during observation"],
    ["final unknown", "PR or main changed during observation"],
  ] as const)("refuses %s rather than combining incompatible observations", (fault, diagnostic) => {
    const f = unknownGraphqlCandidate();
    const state = f.state();
    const observation: NonNullable<typeof state.restObservation> = {};
    if (fault === "head" || fault === "final head") {
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
    if (fault === "unknown" || fault === "final unknown") {
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
    if (fault.startsWith("final ")) {
      observation.afterRestMainReads = 7;
    }
    if (fault === "GraphQL conflict") {
      state.graphqlMergeProjection = { mergeable: "CONFLICTING", mergeStateStatus: "UNKNOWN" };
    } else {
      state.restObservation = observation;
    }
    f.save(state);
    const result = f.adminPriorCi(f.path);
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain(diagnostic);
    if (fault === "GraphQL conflict") {
      expect(f.state().restMainReads).toBe(0);
    } else {
      expect(f.state().restObservationAppliedAt).toBe(fault.startsWith("final ") ? 7 : 1);
    }
    expectNoDispatch(f);
  });

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
