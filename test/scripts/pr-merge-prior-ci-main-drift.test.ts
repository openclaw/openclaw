import { expect, it } from "vitest";
import { createMergeOutcomeFixtureHarness } from "./pr-merge-outcome.test-support.js";
import { createPriorCiCandidateFactory } from "./pr-merge-prior-ci.test-support.js";

const { describePosix, fixture } = createMergeOutcomeFixtureHarness();
const { preExistingCandidate } = createPriorCiCandidateFactory(fixture);

function expectNoDispatch(f: ReturnType<typeof preExistingCandidate>) {
  expect(f.state().mutations).toBe(0);
  expect(f.state().posts).toBe(0);
  expect(f.captures()).toEqual([]);
  expect(() => f.record()).toThrow();
}

describePosix("prior-CI forward main admission", () => {
  it("revalidates admin authority after the pre-final missing-main fetch", () => {
    const f = preExistingCandidate();
    const state = f.state();
    state.priorCi.revokeAdminOnMainFetch = true;
    // This remote-only commit reaches the last materialization window. The
    // original ordering instead fetched it after final authority verification.
    state.observations = [{}, {}, {}, { advanceMain: true }];
    f.save(state);

    const result = f.adminPriorCi(f.path);

    expect(f.state().priorCi.adminRevokedDuringMainFetch, result.output).toBe(true);
    expect(f.state().priorCi.membership).toBe("member");
    expectNoDispatch(f);
    expect(result.status, result.output).not.toBe(0);
    expect(result.output).toContain("writer must be an active organization admin");
  });

  it("refuses a remote-only final main without fetching or dispatching", () => {
    const f = preExistingCandidate();
    const state = f.state();
    state.priorCi.revokeAdminOnMainFetch = true;
    state.observations = [{}, {}, {}, {}, { advanceMain: true }];
    f.save(state);

    const result = f.adminPriorCi(f.path);

    expect(f.state().mainAdvances, result.output).toHaveLength(1);
    const main = f.state().mainAdvances[0]!;
    expect(f.state().priorCi.adminRevokedDuringMainFetch).toBe(false);
    expect(f.state().priorCi.membership).toBe("admin");
    expect(() => f.git(["cat-file", "-e", main])).toThrow();
    expectNoDispatch(f);
    expect(result.status, result.output).not.toBe(0);
    expect(result.output).toContain("final prior-CI main cannot be verified with local-only Git");
  });

  it("refuses final main movement when Git cannot guarantee local-only reads", () => {
    const f = preExistingCandidate();
    const main = f.commit(f.tree("before\n", "advanced\n"), [f.base]);
    const state = f.state();
    state.priorCi.unsupportedNoLazy = true;
    state.observations = [{}, {}, {}, {}, { main }];
    f.save(state);
    const result = f.adminPriorCi(f.path);
    expect(result.status, result.output).not.toBe(0);
    expect(result.output).toContain("final prior-CI main cannot be verified with local-only Git");
    expectNoDispatch(f);
  });

  it.each(["settlement", "final verification"])(
    "lands the pinned head when main advances during %s",
    (stage) => {
      const f = preExistingCandidate();
      const main = f.commit(f.tree("before\n", "advanced\n"), [f.base]);
      const state = f.state();
      state.observations =
        stage === "settlement"
          ? [
              { pr: { mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" } },
              { main, pr: { mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED" } },
            ]
          : [{}, {}, {}, {}, { main }];
      f.save(state);

      const result = f.adminPriorCi(f.path);

      expect(result.status, result.output).toBe(0);
      expect(f.state().mutations).toBe(1);
      expect(f.state().restMergePayload).toMatchObject({ sha: f.head, merge_method: "squash" });
      expect(f.record()).toMatchObject({
        phase: "complete",
        head: f.head,
        main: stage === "settlement" ? main : f.base,
        priorCiAdmin: {
          testedMerge: f.evidence.testedMerge,
          securityReview: { sourceSha: f.base },
        },
      });
      expect(f.git(["rev-parse", `${f.record().landed}^`])).toBe(main);
      expect(f.git(["show", `${f.record().landed}:owner.txt`])).toBe("resolved conflict");
      expect(f.git(["show", `${f.record().landed}:sibling.txt`])).toBe("advanced");
      expect(result.output).toContain(
        stage === "settlement"
          ? "Admin landing parent audit matched"
          : "Admin landing parent audit drift",
      );
    },
  );

  it.each([
    ["rewritten verified main", "both observed and verified main"],
    ["rewritten observed main", "both observed and verified main"],
    ["conflict", "cannot establish prepared-head merge tree"],
    ["empty change", "NO NET CHANGE"],
    ["unavailable main", "cannot fetch authoritative main"],
  ])("refuses %s before intent or merge I/O", (fault, message) => {
    const f = preExistingCandidate();
    const state = f.state();
    const main = f.commit(
      f.tree(
        fault === "conflict"
          ? "conflicting main\n"
          : fault === "empty change"
            ? "resolved conflict\n"
            : "before\n",
      ),
      fault === "rewritten verified main" ? [] : [f.base],
      "Different main\n",
    );
    state.observations = [{}, { main }];
    if (fault === "rewritten verified main") {
      state.observations = [{ main }];
    }
    if (fault === "rewritten observed main") {
      const first = f.commit(f.tree("before\n", "first advance\n"), [f.base]);
      state.observations = [{ main: first }, { main }];
    }
    if (fault === "unavailable main") {
      state.observations = [{}, { reportedMain: "f".repeat(40) }];
    }
    f.save(state);

    const result = f.adminPriorCi(f.path);

    expect(result.status, result.output).not.toBe(0);
    expect(result.output).toContain(message);
    expectNoDispatch(f);
  });

  it.each([
    ["admin", "writer must be an active organization admin"],
    ["review", "current enforced reviews must be satisfied"],
    ["policy", "evidence or authority changed during admission"],
    ["security source", "publisher source differs from the current owner"],
    ["evidence", "operator evidence changed while reading authority"],
  ])("revalidates %s after accepting a main advance", (fault, message) => {
    const f = preExistingCandidate();
    const state = f.state();
    const main = f.commit(f.tree("before\n", "advanced\n"), [f.base]);
    const priorCi: Partial<typeof state.priorCi> = {};
    if (fault === "admin") {
      priorCi.membership = "member";
    }
    if (fault === "review") {
      priorCi.reviewDecision = "REVIEW_REQUIRED";
    }
    if (fault === "policy") {
      priorCi.reviewCount = 2;
    }
    if (fault === "security source") {
      priorCi.security = { ...state.priorCi.security, fault: "changed-publisher-source" };
    }
    if (fault === "evidence") {
      priorCi.mutateEvidence = true;
    }
    state.observations = [{}, { main, priorCi }];
    f.save(state);

    const result = f.adminPriorCi(f.path);

    expect(result.status, result.output).not.toBe(0);
    expect(result.output).toContain(message);
    expectNoDispatch(f);
  });

  it.each(["head", "status"])("does not normalize changed PR %s with main", (fact) => {
    const f = preExistingCandidate();
    const state = f.state();
    const main = f.commit(f.tree("before\n", "advanced\n"), [f.base]);
    state.observations = [
      {},
      { main, pr: fact === "head" ? { headRefOid: f.base } : { mergeStateStatus: "BEHIND" } },
    ];
    f.save(state);
    const result = f.adminPriorCi(f.path);
    expect(result.status, result.output).not.toBe(0);
    expect(result.output).toContain("PR or main changed during observation");
    expectNoDispatch(f);
  });

  it("keeps Crabbox admin main stability strict", () => {
    const f = fixture();
    const main = f.commit(f.tree("before\n", "advanced\n"), [f.base]);
    f.save({ ...f.state(), admin: true, gates: "fail", observations: [{}, { main }] });
    const result = f.run();
    expect(result.status, result.output).not.toBe(0);
    expect(result.output).toContain("PR or main changed during observation");
    expect(f.state().mutations).toBe(0);
    expect(() => f.record()).toThrow();
  });

  it("keeps retained prior-CI outcomes fenced after main moves", () => {
    const f = preExistingCandidate();
    f.save({ ...f.state(), mode: "unapplied" });
    f.adminPriorCi(f.path);
    expect(f.record()).toMatchObject({ phase: "intent", route: "admin" });
    expect(f.state().mutations).toBe(1);
    expect(f.recover()).toBe(true);
    const outcome = f.git(["rev-parse", "refs/openclaw/pr-merge-outcomes/123"]);
    const main = f.commit(f.tree("before\n", "advanced\n"), [f.base]);
    f.save({ ...f.state(), observations: [{}, { main }] });

    const result = f.run();

    expect(result.status, result.output).not.toBe(0);
    expect(result.output).toContain("PR or main changed during observation");
    expect(f.state().mutations).toBe(1);
    expect(f.git(["rev-parse", "refs/openclaw/pr-merge-outcomes/123"])).toBe(outcome);
  });
});
