import { writeFileSync } from "node:fs";
import { join } from "node:path";
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

  it.each([false, true])(
    "requalifies remote-only final main (recalculating: %s)",
    (recalculating) => {
      const f = preExistingCandidate();
      const state = f.state();
      const unknown = { mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" };
      state.observations = [
        {},
        {},
        {},
        {},
        { advanceMain: true, ...(recalculating ? { pr: unknown } : {}) },
        ...(recalculating
          ? [{ pr: unknown }, { pr: { mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED" } }]
          : []),
      ];
      f.save(state);

      const result = f.adminPriorCi(f.path);

      expect(f.state().mainAdvances, result.output).toHaveLength(1);
      const main = f.state().mainAdvances[0]!;
      expect(result.status, result.output).toBe(0);
      expect(f.git(["cat-file", "-t", main])).toBe("commit");
      expect(f.state().mutations).toBe(1);
      expect(f.record()).toMatchObject({ phase: "complete", accepted: true, head: f.head });
      expect(f.git(["rev-parse", `${f.record().landed}^1`])).toBe(main);
      expect(result.output).toContain(`Requalifying prior-CI admission after main ${main}`);
      expect(f.state().settlementSleeps).toEqual(recalculating ? [1] : []);
    },
  );

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
    expect(result.output).toContain(`role=previous-main oid=${f.base} git-exit=129`);
    expectNoDispatch(f);
  });

  it.each(["stderr", "exit"])("refuses a missing-object query with %s failure", (fault) => {
    const f = preExistingCandidate();
    const state = f.state();
    state.priorCi.localOnlyQueryFault = fault;
    state.observations = [{}, {}, {}, {}, { advanceMain: true }];
    f.save(state);
    const result = f.adminPriorCi(f.path);
    expect(result.error, result.output).toBeUndefined();
    expect(result.status, result.output).not.toBe(0);
    expect(result.output).toContain("final prior-CI main cannot be verified with local-only Git");
    expect(result.output).not.toContain("Requalifying prior-CI admission");
    expect(() => f.git(["cat-file", "-e", f.state().mainAdvances[0]!])).toThrow();
    expectNoDispatch(f);
  });

  it("stops after three authority rounds without fetching the last missing tip", () => {
    const f = preExistingCandidate();
    f.save({
      ...f.state(),
      observations: [
        {},
        {},
        {},
        {},
        { advanceMain: true },
        {},
        { advanceMain: true },
        {},
        { advanceMain: true },
      ],
    });
    const result = f.adminPriorCi(f.path);
    expect(result.error, result.output).toBeUndefined();
    expect(result.status, result.output).not.toBe(0);
    expect(result.output).toContain("main kept advancing after 3 authority rounds");
    const advances = f.state().mainAdvances;
    expect(advances).toHaveLength(3);
    for (const main of advances.slice(0, 2)) {
      expect(f.git(["cat-file", "-t", main])).toBe("commit");
    }
    expect(() => f.git(["cat-file", "-e", advances[2]!])).toThrow();
    expectNoDispatch(f);
  });

  it("requires the verified pin before rematerializing a newly missing main", () => {
    const f = preExistingCandidate();
    const previous = f.commit(f.tree("before\n", "advanced\n"), [f.base]);
    const state = f.state();
    state.priorCi.localOnlyFailureOid = f.base;
    state.priorCi.localOnlyFailureStderr = "fatal: fixture verified pin is unreadable";
    state.observations = [{}, {}, {}, { main: previous }, { advanceMain: true }];
    f.save(state);
    const result = f.adminPriorCi(f.path);
    expect(result.error, result.output).toBeUndefined();
    expect(result.status, result.output).not.toBe(0);
    expect(result.output).toContain(`role=verified-main oid=${f.base}`);
    expect(result.output).not.toContain("Requalifying prior-CI admission");
    expect(() => f.git(["cat-file", "-e", f.state().mainAdvances[0]!])).toThrow();
    expectNoDispatch(f);
  });

  it.each(["head", "rewind"])("refuses %s after materializing the captured tip", (fault) => {
    const f = preExistingCandidate();
    const state = f.state();
    state.observations = [
      {},
      {},
      {},
      {},
      { advanceMain: true },
      fault === "head" ? { pr: { headRefOid: f.base } } : { main: f.base },
    ];
    f.save(state);
    const result = f.adminPriorCi(f.path);
    expect(result.error, result.output).toBeUndefined();
    expect(result.status, result.output).not.toBe(0);
    expect(result.output).toContain(
      fault === "head"
        ? "PR or main changed during observation"
        : "both observed and verified main",
    );
    expect(f.git(["cat-file", "-t", f.state().mainAdvances[0]!])).toBe("commit");
    expectNoDispatch(f);
  });

  it.each(["previous-main", "reread-main", "verified-main"] as const)(
    "identifies a failed %s probe with a bounded redacted diagnostic",
    (role) => {
      const f = preExistingCandidate();
      const previous = f.commit(f.tree("before\n", "first advance\n"), [f.base]);
      const main = f.commit(f.tree("before\n", "second advance\n"), [previous]);
      const failed = role === "previous-main" ? previous : role === "reread-main" ? main : f.base;
      const secret = "fixture-sensitive-token-not-a-real-credential";
      if (role === "previous-main") {
        // Failure reporting must not load the PR checkout's configuration.
        writeFileSync(join(f.worktree, "tsconfig.json"), "{ invalid caller tsconfig");
      }
      const state = f.state();
      state.observations = [{}, {}, {}, { main: previous }, { main }];
      state.priorCi.localOnlyFailureOid = failed;
      state.priorCi.localOnlyFailureStderr =
        `fatal: fixture-local object unavailable\nAuthorization: Bearer ${secret}\n` +
        "diagnostic detail ".repeat(200);
      state.priorCi.revokeAdminOnMainFetch = true;
      f.save(state);

      const result = f.adminPriorCi(f.path);

      expect(result.status, result.output).not.toBe(0);
      expect(result.output).toContain(`role=${role} oid=${failed} git-exit=128`);
      expect(result.output).toContain("fatal: fixture-local object unavailable");
      expect(result.output).not.toContain(secret);
      const diagnostic = result.output.split("\n").find((line) => line.includes(`role=${role}`));
      expect(diagnostic?.length).toBeLessThan(1_024);
      expect(f.state().priorCi.adminRevokedDuringMainFetch).toBe(false);
      expect(f.state().priorCi.membership).toBe("admin");
      expectNoDispatch(f);
    },
  );

  it("omits oversized Git stderr instead of clipping an unredacted credential", () => {
    const f = preExistingCandidate();
    const main = f.commit(f.tree("before\n", "advanced\n"), [f.base]);
    const state = f.state();
    state.observations = [{}, {}, {}, {}, { main }];
    state.priorCi.localOnlyFailureOid = main;
    state.priorCi.localOnlyFailureStderr = "Authorization: Bearer " + "sensitive".repeat(2_000);
    f.save(state);

    const result = f.adminPriorCi(f.path);

    expect(result.status, result.output).not.toBe(0);
    expect(result.output).toContain(`role=reread-main oid=${main} git-exit=128`);
    expect(result.output).toContain("Git diagnostic exceeded 8192 bytes");
    expect(result.output).not.toContain("sensitive");
    expectNoDispatch(f);
  });

  it.each([
    "settlement",
    "final verification",
    "GraphQL recalculation",
    "final GraphQL recalculation",
  ])("lands the pinned head when main advances during %s", (stage) => {
    const f = preExistingCandidate();
    const main = f.commit(f.tree("before\n", "advanced\n"), [f.base]);
    const state = f.state();
    state.observations =
      stage === "settlement"
        ? [{ pr: { mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" } }]
        : stage === "GraphQL recalculation" || stage === "final GraphQL recalculation"
          ? [
              ...Array.from({ length: stage === "GraphQL recalculation" ? 1 : 4 }, () => ({})),
              { main, pr: { mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" } },
              { pr: { mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED" } },
            ]
          : [{}, {}, {}, {}, { main }];
    if (stage === "settlement") {
      state.restObservation = {
        main,
        pr: { mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED" },
      };
    }
    f.save(state);

    const result = f.adminPriorCi(f.path);

    expect(result.status, result.output).toBe(0);
    if (stage === "settlement") {
      expect(f.state()).toMatchObject({
        observationReads: 1,
        observations: [],
        restObservation: null,
        restObservationAppliedAt: 0,
      });
    }
    if (stage === "GraphQL recalculation" || stage === "final GraphQL recalculation") {
      expect(f.state().settlementSleeps).toEqual([1]);
      expect(f.state().restMainReads).toBe(0);
    }
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
  });

  it.each([
    ["same main", "PR or main changed during observation"],
    ["persistent", "mergeability recalculation remained UNKNOWN after 3 observations"],
    ["conflict", "PR or main changed during observation"],
    ["known status", "PR or main changed during observation"],
    ["head", "PR or main changed during observation"],
    ["rewind", "both observed and verified main"],
    ["final revoked admin", "writer must be an active organization admin"],
    ["final revoked review", "current enforced reviews must be satisfied"],
  ] as const)("refuses %s during GraphQL recalculation", (fault, diagnostic) => {
    const f = preExistingCandidate();
    const main = f.commit(f.tree("before\n", "advanced\n"), [f.base]);
    const state = f.state();
    state.priorCi.revokeAdminOnMainFetch = true;
    state.observations = [
      ...Array.from({ length: fault.startsWith("final ") ? 4 : 1 }, () => ({})),
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
                mergeStateStatus: fault === "known status" ? "CLEAN" : "BLOCKED",
                ...(fault === "head" ? { headRefOid: f.base } : {}),
              },
              ...(fault === "final revoked admin" ? { priorCi: { membership: "member" } } : {}),
              ...(fault === "final revoked review"
                ? { priorCi: { reviewDecision: "REVIEW_REQUIRED" } }
                : {}),
            },
          ]),
    ];
    f.save(state);

    const result = f.adminPriorCi(f.path);

    expect(result.status, result.output).not.toBe(0);
    expect(result.output).toContain(diagnostic);
    expect(f.state().settlementSleeps).toEqual(
      fault === "same main" ? [] : fault === "persistent" ? [1, 2] : [1],
    );
    expect(f.state().priorCi.adminRevokedDuringMainFetch).toBe(false);
    expectNoDispatch(f);
  });

  it.each(["conflict", "empty change"] as const)(
    "checks first-observation %s composition",
    (fault) => {
      const f = preExistingCandidate();
      const main = f.commit(
        f.tree(fault === "conflict" ? "conflicting main\n" : "resolved conflict\n"),
        [f.base],
      );
      f.save({ ...f.state(), observations: [{ main }] });

      const result = f.adminPriorCi(f.path);

      expect(result.status, result.output).not.toBe(0);
      expect(result.output).toContain(
        fault === "conflict" ? "cannot establish prepared-head merge tree" : "NO NET CHANGE",
      );
      expectNoDispatch(f);
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

  it.each(
    (
      [
        ["admin", "writer must be an active organization admin"],
        ["review", "current enforced reviews must be satisfied"],
        ["policy", "evidence or authority changed during admission"],
        ["security source", "publisher source differs from the current owner"],
        ["evidence", "operator evidence changed while reading authority"],
      ] as const
    ).flatMap(([fault, message]) =>
      [false, true].map((remoteOnly) => [fault, remoteOnly, message] as const),
    ),
  )("revalidates %s after main advance (remote-only: %s)", (fault, remoteOnly, message) => {
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
    state.observations = remoteOnly
      ? [{}, {}, {}, {}, { advanceMain: true }, { priorCi }]
      : [{}, { main, priorCi }];
    if (remoteOnly && fault === "admin") {
      state.priorCi.revokeAdminOnMainFetch = true;
    }
    f.save(state);

    const result = f.adminPriorCi(f.path);
    expect(result.error, result.output).toBeUndefined();

    expect(result.status, result.output).not.toBe(0);
    expect(result.output).toContain(message);
    if (remoteOnly) {
      expect(f.git(["cat-file", "-t", f.state().mainAdvances[0]!])).toBe("commit");
    }
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
