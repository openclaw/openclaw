import { expect, it } from "vitest";
import { configureMerge, expectExit } from "./pr-merge-assertions.test-support.js";
import { createMergeOutcomeFixtureHarness } from "./pr-merge-outcome.test-support.js";
import { createPriorCiCandidateFactory } from "./pr-merge-prior-ci.test-support.js";
import { landingSnapshotQuery } from "./pr-merge-snapshot.test-support.js";

const { fixture, describePosix, outcomeRef } = createMergeOutcomeFixtureHarness();
const { preExistingCandidate } = createPriorCiCandidateFactory(fixture);
type Candidate = ReturnType<typeof preExistingCandidate>;
const unknown = { mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" };
const ready = { mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED" };
const settlement = (seconds = 4) => ({ seconds, pr: ready });

function unknownGraphqlCandidate() {
  const f = preExistingCandidate();
  configureMerge(f, { graphqlMergeProjection: { mergeStateStatus: "UNKNOWN" } });
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

function refuse(f: Candidate, message: string, exact = false) {
  const result = f.adminPriorCi(f.path);
  if (exact) {
    expectExit(result, 1);
  } else {
    expect(result.status, result.output).not.toBe(0);
  }
  expect(result.output).toContain(message);
  expectNoDispatch(f);
  return result;
}
const unchanged = (count: number) => Array.from({ length: count }, () => ({}));
describePosix("prior-CI whole REST observation fallback", () => {
  it.each([false, true])("rechecks final delegated policy (tightens=%s)", (tightens) => {
    const f = unknownGraphqlCandidate();
    const state = f.state();
    state.mode = "unapplied";
    state.repoAuthority.permissions = { admin: false, maintain: true, push: true };
    state.priorCi.membership = "member";
    state.priorCi.rulesetBypass = "always";
    state.tightenPolicyAfterSecurity = tightens;
    f.save(state);

    const result = f.adminPriorCi(f.path);
    const final = f.state();

    expect(result.status, result.output).toBe(1);
    if (tightens) {
      expect(final.policyTightenedAt).toBeGreaterThan(0);
      expect(final.priorCi.reviewCount).toBe(2);
      expectNoDispatch(f);
      expect(result.output).toContain("writer policy or delegated bypass changed during admission");
    } else {
      expect(result.output).toContain("prior dispatch unresolved");
      expect(final).toMatchObject({
        mutations: 1,
        posts: 0,
        restMergePayload: { sha: f.head, merge_method: "squash" },
      });
      expect(f.record()).toMatchObject({
        phase: "intent",
        head: f.head,
        accepted: false,
        priorCiAdmin: {
          delegation: { kind: "ci-ruleset-bypass", rulesets: [{ id: 41, mode: "always" }] },
        },
      });
    }
    const calls = tightens ? final.calls : readsBeforeDispatch(f);
    const finalSecurityRead = calls.findLastIndex((call) =>
      call.some((arg) => arg.startsWith(`repos/fixture/repo/commits/${f.head}/statuses?`)),
    );
    const finalPolicyRead = calls.findLastIndex((call) =>
      call.some((arg) => arg.startsWith("repos/fixture/repo/rules/branches/main?")),
    );
    const finalWriterRead = calls.findLastIndex((call) =>
      call.includes("repos/fixture/repo/rulesets/41"),
    );
    expect(finalPolicyRead).toBeGreaterThan(finalSecurityRead);
    expect(finalWriterRead).toBeGreaterThan(finalPolicyRead);
  });

  it.each([
    "stable",
    "missing REST commit",
    "continuing main",
    "within read",
    "stability",
    "final authority",
    "recalculated status",
  ])("lands pinned head with REST: %s", (stage) => {
    const f = unknownGraphqlCandidate();
    const state = f.state();
    if (stage === "missing REST commit") {
      state.restMergeCommit = "missing";
    }
    const recalculating = ["stability", "final authority", "recalculated status"].includes(stage);
    const main = recalculating ? f.commit(f.tree("before\n", "advanced\n"), [f.base]) : f.base;
    if (recalculating) {
      state.projectionSettlement = settlement();
      state.restObservations = [
        ...unchanged(stage === "final authority" ? 3 : 1),
        { main, pr: unknown },
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
    const result = expectExit(f.adminPriorCi(f.path));
    const final = f.state();
    expect(final).toMatchObject({
      mutations: 1,
      posts: 1,
      gates: "fail",
      restMergePayload: { sha: f.head, merge_method: "squash" },
    });
    expect(f.record()).toMatchObject({ phase: "complete", head: f.head });
    expect(f.git(["rev-parse", `${f.record().landed}^1`])).toBe(
      stage === "continuing main" || stage === "within read" ? final.mainAdvances.at(-1) : main,
    );
    if (recalculating) {
      expect(final.settlementSleeps).toEqual([2, 2]);
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
      ).toHaveLength(4);
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

  it("retains deadline after UNKNOWN and main advance", () => {
    const f = unknownGraphqlCandidate();
    const main = f.commit(f.tree("before\n", "advanced\n"), [f.base]);
    configureMerge(f, {
      mode: "unapplied",
      projectionSettlement: settlement(),
      restObservations: [
        ...unchanged(3),
        { main, pr: unknown },
        { advanceMain: true, pr: ready },
        { advanceSeconds: 65 },
      ],
    });

    const result = expectExit(f.adminPriorCi(f.path), 1);
    expect(result.output).toContain("prior dispatch unresolved");
    expect(f.state().settlementSleeps).toEqual([2, 2]);
    expect(f.state().mainAdvances).toHaveLength(1);
    expect(result.output).toContain("Admin authority round 3:");
    expect(f.state()).toMatchObject({
      mutations: 1,
      posts: 0,
      restMergePayload: { sha: f.head, merge_method: "squash" },
    });
    expectFinalAuthority(readsBeforeDispatch(f));
    expect(f.record()).toMatchObject({ phase: "intent", head: f.head, accepted: false });
  });

  it.each(["revoked approval", "new failing suite", "rewound main"] as const)(
    "refuses %s after remote-only advance",
    (fault) => {
      const f = unknownGraphqlCandidate();
      configureMerge(f, {
        restObservations: [
          ...unchanged(3),
          { advanceMain: true },
          fault === "revoked approval"
            ? { priorCi: { reviewDecision: "REVIEW_REQUIRED" } }
            : fault === "new failing suite"
              ? { restUnseenSuite: "new-gate" }
              : { main: f.base },
        ],
      });

      const result = refuse(f, "Requalifying admin admission");
      expect(f.state().mainAdvances).toHaveLength(1);
      expect(f.git(["cat-file", "-t", f.state().mainAdvances[0]!])).toBe("commit");
      expect(result.output).toContain(
        fault === "revoked approval"
          ? "current enforced reviews must be satisfied"
          : fault === "new failing suite"
            ? "currently effective CI gate"
            : "both observed and verified main",
      );
    },
  );

  it("requires merged receipt during admission", () => {
    const f = unknownGraphqlCandidate();
    configureMerge(f, {
      restMergeCommit: "missing",
      restObservation: {
        afterRestMainReads: 7,
        pr: { state: "MERGED", mergeCommit: { oid: f.base } },
      },
    });
    refuse(f, "merged PR commit requires GraphQL observation", true);
    expect(f.state().observationReads).toBe(1);
  });
  it("reads checks once after historical preparation", () => {
    const f = unknownGraphqlCandidate();
    configureMerge(f, {
      restObservation: { afterHistoricalRead: true, restUnseenSuite: "new-gate" },
    });

    refuse(f, "currently effective CI gate", true);
    const state = f.state();
    expect(state.restObservationAppliedAt).toBeGreaterThan(0);
    const historyRead = state.calls.findLastIndex((call) =>
      call.includes("repos/fixture/repo/actions/runs/501/attempts/2"),
    );
    expect(historyRead).toBeGreaterThan(0);
    expect(
      state.calls
        .slice(historyRead + 1)
        .filter((call) =>
          call.includes(`repos/fixture/repo/commits/${f.head}/status?per_page=100`),
        ),
    ).toHaveLength(1);
  });
  it.each([1, 4])("survives quota expiry after %s observations", (observations) => {
    const f = preExistingCandidate();
    configureMerge(f, { quotaAt: "observe", quotaAfterObservations: observations });
    expectExit(f.adminPriorCi(f.path));
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
  });

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
    refuse(f, diagnostic, true);
    const final = f.state();
    if (quota) {
      expect(final.observationReads).toBe(4);
      expect(final.restObservationAppliedAt).toBeGreaterThan(0);
    } else {
      expect(final.restObservationAppliedAt).toBe(8);
      expect(final.restMainReads).toBe(final.restObservationAppliedAt);
      if (fault === "admin") {
        expectFinalAuthority(final.calls);
      } else {
        const finalMainRead = final.calls.findLastIndex((call) =>
          call.includes("repos/fixture/repo/git/ref/heads/main"),
        );
        const revokedAuthorityRead = final.calls.findLastIndex((call) =>
          fault === "review"
            ? call.some((arg) => arg.includes("headRefOid reviewDecision"))
            : call.some((arg) => arg.startsWith(`repos/fixture/repo/commits/${f.head}/statuses?`)),
        );
        expect(revokedAuthorityRead).toBeGreaterThan(finalMainRead);
      }
    }
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
  ] as const)("refuses %s (main advanced=%s)", (fault, advanced) => {
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
          ...(fault === "same-main UNKNOWN" ? { pr: unknown } : {}),
        },
      ];
    } else {
      if (fault !== "persistent" && fault !== "same main") {
        state.projectionSettlement = settlement();
      }
      state.restObservations = [
        {},
        {
          main: fault === "same main" ? f.base : main,
          pr: unknown,
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
    const result = refuse(
      f,
      fault === "persistent"
        ? "mergeability recalculation"
        : fault === "rewind" || fault === "divergence"
          ? "both observed and verified main"
          : "PR or main changed during observation",
    );
    if (fault === "persistent") {
      expect(result.output).toContain("60s");
      expect(f.state().settlementSleeps.every((delay) => delay <= 8)).toBe(true);
    } else {
      expect(f.state().settlementSleeps).toEqual(advanced || fault === "same main" ? [2] : [2, 2]);
    }
  });
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
        state.projectionSettlement = settlement();
        state.restObservations = [
          ...unchanged(3),
          { main, pr: unknown },
          {
            pr: ready,
            ...(boundary === "recalculated remote-only main"
              ? { advanceMain: true }
              : { priorCi: { membership: "member" } }),
          },
        ];
      }
      f.save(state);
      refuse(
        f,
        boundary === "start"
          ? "cannot fetch authoritative main"
          : "writer must be an active organization admin",
      );
      expect(f.state().priorCi.adminRevokedDuringMainFetch).toBe(
        boundary === "end" || boundary === "recalculated remote-only main",
      );
      if (boundary === "start") {
        expect(f.state().restMainReads).toBe(8);
      } else if (boundary === "end") {
        expect(f.state().restObservationAppliedAt).toBe(7);
        expect(f.state().restMainReads).toBeGreaterThan(f.state().restObservationAppliedAt);
      }
    },
  );
  it.each(["rewind", "divergence", "conflict", "empty change", "policy"] as const)(
    "refuses %s inside REST observation",
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
      refuse(
        f,
        fault === "policy"
          ? "branch policy changed while reading evidence"
          : fault === "conflict"
            ? "cannot establish prepared-head merge tree"
            : fault === "empty change"
              ? "NO NET CHANGE"
              : "both observed and verified main",
      );
    },
  );
  it("fences unknown outcome across reconciliation drift", () => {
    const f = unknownGraphqlCandidate();
    const main = f.commit(f.tree("before\n", "advanced\n"), [f.base]);
    configureMerge(f, {
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
    ["changed policy", "branch policy changed while reading evidence"],
    ["CI attempt", "newer or running CI attempt"],
    ["GraphQL conflict", "no conflicts"],
    ["final head", "qualified snapshot changed the prepared head"],
    ["final unknown", "PR or main changed during observation"],
  ] as const)("refuses incompatible %s observations", (fault, diagnostic) => {
    const f = unknownGraphqlCandidate();
    const state = f.state();
    const faults: Record<string, NonNullable<typeof state.restObservation>> = {
      head: { pr: { headRefOid: f.base } },
      lifecycle: { pr: { state: "CLOSED" } },
      "known projection": { pr: { mergeStateStatus: "CLEAN" } },
      conflict: { pr: { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" } },
      unknown: { pr: { mergeStateStatus: "UNKNOWN" } },
      "malformed projection": { pr: { mergeStateStatus: "NOT_A_STATE" } },
      "renewed auto": { pr: { autoMergeRequest: { mergeMethod: "SQUASH" } } },
      "queue policy": { restPolicy: "queue" },
      "changed policy": { priorCi: { reviewCount: 2 } },
      "CI attempt": { priorCi: { latestAttempt: 3 } },
    };
    const observation = faults[fault.replace("final ", "")] ?? {};
    if (fault === "known projection") {
      state.graphqlMergeProjection = { mergeable: "UNKNOWN", mergeStateStatus: "BLOCKED" };
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
    refuse(f, diagnostic, true);
    if (fault === "GraphQL conflict") {
      expect(f.state().restMainReads).toBe(0);
    } else {
      expect(f.state().restObservationAppliedAt).toBe(fault.startsWith("final ") ? 7 : 1);
    }
  });
  it.each([
    ["fail", "REST fallback does not authorize an admin bypass"],
    ["pass", "selected merge route is blocked by policy"],
  ])("keeps ordinary REST strict with %s checks", (gates, diagnostic) => {
    const f = fixture();
    configureMerge(f, { restPolicy: "rules", gates, pr: { mergeStateStatus: "BLOCKED" } });
    const result = expectExit(f.run(), 1);
    expect(result.output).toContain(diagnostic);
    expect(f.state().mutations).toBe(0);
    expect(() => f.record()).toThrow();
  });
});
