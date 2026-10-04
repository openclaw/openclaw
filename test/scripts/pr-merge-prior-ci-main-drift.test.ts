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
  it.each([
    "unsupported Git",
    "stderr",
    "exit",
    "verified pin",
    "previous-main",
    "reread-main",
    "verified-main",
    "oversized stderr",
  ] as const)("refuses a local-only probe failure: %s", (fault) => {
    const f = preExistingCandidate();
    const state = f.state();
    const secret = "fixture-sensitive-token-not-a-real-credential";
    let probe: { role: string; oid: string; exit: number } | undefined;
    if (fault === "stderr" || fault === "exit") {
      state.priorCi.localOnlyQueryFault = fault;
      state.observations = [{}, {}, {}, {}, { advanceMain: true }];
    } else if (fault === "verified pin") {
      const previous = f.commit(f.tree("before\n", "advanced\n"), [f.base]);
      state.priorCi.localOnlyFailureOid = f.base;
      state.priorCi.localOnlyFailureStderr = "fatal: fixture verified pin is unreadable";
      state.observations = [{}, {}, {}, { main: previous }, { advanceMain: true }];
      probe = { role: "verified-main", oid: f.base, exit: 128 };
    } else if (fault === "unsupported Git" || fault === "oversized stderr") {
      const main = f.commit(f.tree("before\n", "advanced\n"), [f.base]);
      state.observations = [{}, {}, {}, {}, { main }];
      if (fault === "unsupported Git") {
        state.priorCi.unsupportedNoLazy = true;
        probe = { role: "previous-main", oid: f.base, exit: 129 };
      } else {
        state.priorCi.localOnlyFailureOid = main;
        state.priorCi.localOnlyFailureStderr = "Authorization: Bearer " + "sensitive".repeat(2_000);
        probe = { role: "reread-main", oid: main, exit: 128 };
      }
    } else {
      const previous = f.commit(f.tree("before\n", "first advance\n"), [f.base]);
      const main = f.commit(f.tree("before\n", "second advance\n"), [previous]);
      const failed = fault === "previous-main" ? previous : fault === "reread-main" ? main : f.base;
      if (fault === "previous-main") {
        // Failure reporting must not load the PR checkout's configuration.
        writeFileSync(join(f.worktree, "tsconfig.json"), "{ invalid caller tsconfig");
      }
      state.observations = [{}, {}, {}, { main: previous }, { main }];
      state.priorCi.localOnlyFailureOid = failed;
      state.priorCi.localOnlyFailureStderr =
        `fatal: fixture-local object unavailable\nAuthorization: Bearer ${secret}\n` +
        "diagnostic detail ".repeat(200);
      state.priorCi.revokeAdminOnMainFetch = true;
      probe = { role: fault, oid: failed, exit: 128 };
    }
    f.save(state);
    const result = f.adminPriorCi(f.path);
    expect(result.status, result.output).not.toBe(0);
    expect(result.output).toContain("final prior-CI main cannot be verified with local-only Git");
    if (probe) {
      expect(result.output).toContain(`role=${probe.role} oid=${probe.oid} git-exit=${probe.exit}`);
    }
    if (fault === "stderr" || fault === "exit" || fault === "verified pin") {
      expect(result.error, result.output).toBeUndefined();
      expect(result.output).not.toContain("Requalifying prior-CI admission");
      expect(() => f.git(["cat-file", "-e", f.state().mainAdvances[0]!])).toThrow();
    }
    if (fault.endsWith("-main")) {
      expect(result.output).toContain("fatal: fixture-local object unavailable");
      expect(result.output).not.toContain(secret);
      const diagnostic = result.output.split("\n").find((line) => line.includes(`role=${fault}`));
      expect(diagnostic?.length).toBeLessThan(1_024);
      expect(f.state().priorCi.adminRevokedDuringMainFetch).toBe(false);
      expect(f.state().priorCi.membership).toBe("admin");
    }
    if (fault === "oversized stderr") {
      expect(result.output).toContain("Git diagnostic exceeded 8192 bytes");
      expect(result.output).not.toContain("sensitive");
    }
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

  it.each([
    "settlement",
    "final verification",
    "GraphQL recalculation",
    "final GraphQL recalculation",
    "remote-only final main",
    "remote-only recalculation",
  ] as const)("lands the pinned head when main advances during %s", (stage) => {
    const f = preExistingCandidate();
    const remoteOnly = stage.startsWith("remote-only");
    const recalculating = stage.includes("recalculation");
    let main = remoteOnly ? f.base : f.commit(f.tree("before\n", "advanced\n"), [f.base]);
    const state = f.state();
    const unknown = { mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" };
    const settled = { mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED" };
    if (remoteOnly) {
      state.observations = [
        {},
        {},
        {},
        {},
        { advanceMain: true, ...(recalculating ? { pr: unknown } : {}) },
        ...(recalculating ? [{ pr: unknown }, { pr: settled }] : []),
      ];
    } else {
      state.observations =
        stage === "settlement"
          ? [{ pr: unknown }]
          : recalculating
            ? [
                ...Array.from({ length: stage === "GraphQL recalculation" ? 1 : 4 }, () => ({})),
                { main, pr: unknown },
                { pr: settled },
              ]
            : [{}, {}, {}, {}, { main }];
      if (stage === "settlement") {
        state.restObservation = { main, pr: settled };
      }
    }
    f.save(state);
    const result = f.adminPriorCi(f.path);
    expect(result.status, result.output).toBe(0);
    expect(f.state().mutations).toBe(1);
    expect(f.record()).toMatchObject({ phase: "complete", head: f.head });
    if (remoteOnly) {
      expect(f.state().mainAdvances, result.output).toHaveLength(1);
      main = f.state().mainAdvances[0]!;
      expect(f.git(["cat-file", "-t", main])).toBe("commit");
      expect(f.record()).toMatchObject({ accepted: true });
      expect(result.output).toContain(`Requalifying prior-CI admission after main ${main}`);
      expect(f.state().settlementSleeps).toEqual(recalculating ? [1] : []);
    } else {
      if (stage === "settlement") {
        expect(f.state()).toMatchObject({
          observationReads: 1,
          observations: [],
          restObservation: null,
          restObservationAppliedAt: 0,
        });
      }
      if (recalculating) {
        expect(f.state().settlementSleeps).toEqual([1]);
        expect(f.state().restMainReads).toBe(0);
      }
      expect(f.state().restMergePayload).toMatchObject({ sha: f.head, merge_method: "squash" });
      expect(f.record()).toMatchObject({
        main: stage === "settlement" ? main : f.base,
        priorCiAdmin: {
          testedMerge: f.evidence.testedMerge,
          securityReview: { sourceSha: f.base },
        },
      });
      expect(f.git(["show", `${f.record().landed}:owner.txt`])).toBe("resolved conflict");
      expect(f.git(["show", `${f.record().landed}:sibling.txt`])).toBe("advanced");
      expect(result.output).toContain(
        stage === "settlement"
          ? "Admin landing parent audit matched"
          : "Admin landing parent audit drift",
      );
    }
    expect(f.git(["rev-parse", `${f.record().landed}^1`])).toBe(main);
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

  it.each([
    ["conflict", "first observation", "cannot establish prepared-head merge tree"],
    ["empty change", "first observation", "NO NET CHANGE"],
    ["rewritten verified main", "reread", "both observed and verified main"],
    ["rewritten observed main", "reread", "both observed and verified main"],
    ["conflict", "reread", "cannot establish prepared-head merge tree"],
    ["empty change", "reread", "NO NET CHANGE"],
    ["unavailable main", "reread", "cannot fetch authoritative main"],
  ] as const)("refuses %s at %s before intent or merge I/O", (fault, stage, message) => {
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
    if (stage === "first observation" || fault === "rewritten verified main") {
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
    ...(
      [
        ["admin", "writer must be an active organization admin"],
        ["review", "current enforced reviews must be satisfied"],
        ["policy", "evidence or authority changed during admission"],
        ["security source", "publisher source differs from the current owner"],
        ["evidence", "operator evidence changed while reading authority"],
      ] as const
    ).flatMap(([fault, message]) =>
      (["reread", "rematerialization"] as const).map((stage) => [fault, stage, message] as const),
    ),
    ["admin", "pre-final fetch", "writer must be an active organization admin"],
  ] as const)("revalidates %s after main advance during %s", (fault, stage, message) => {
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
    state.observations =
      stage === "pre-final fetch"
        ? [{}, {}, {}, { advanceMain: true }]
        : stage === "rematerialization"
          ? [{}, {}, {}, {}, { advanceMain: true }, { priorCi }]
          : [{}, { main, priorCi }];
    if (stage !== "reread" && fault === "admin") {
      state.priorCi.revokeAdminOnMainFetch = true;
    }
    f.save(state);

    const result = f.adminPriorCi(f.path);
    expect(result.error, result.output).toBeUndefined();

    expect(result.status, result.output).not.toBe(0);
    expect(result.output).toContain(message);
    if (stage === "rematerialization") {
      expect(f.git(["cat-file", "-t", f.state().mainAdvances[0]!])).toBe("commit");
    }
    if (stage === "pre-final fetch") {
      expect(f.state().priorCi.adminRevokedDuringMainFetch, result.output).toBe(true);
      expect(f.state().priorCi.membership).toBe("member");
    }
    expectNoDispatch(f);
  });

  it.each([
    ["head", "reread"],
    ["status", "reread"],
    ["head", "rematerialization"],
    ["rewind", "rematerialization"],
  ] as const)("refuses changed %s during %s", (fault, stage) => {
    const f = preExistingCandidate();
    const state = f.state();
    if (stage === "rematerialization") {
      state.observations = [
        {},
        {},
        {},
        {},
        { advanceMain: true },
        fault === "head" ? { pr: { headRefOid: f.base } } : { main: f.base },
      ];
    } else {
      const main = f.commit(f.tree("before\n", "advanced\n"), [f.base]);
      state.observations = [
        {},
        { main, pr: fault === "head" ? { headRefOid: f.base } : { mergeStateStatus: "BEHIND" } },
      ];
    }
    f.save(state);
    const result = f.adminPriorCi(f.path);
    expect(result.status, result.output).not.toBe(0);
    expect(result.output).toContain(
      fault === "rewind"
        ? "both observed and verified main"
        : "PR or main changed during observation",
    );
    if (stage === "rematerialization") {
      expect(result.error, result.output).toBeUndefined();
      expect(f.git(["cat-file", "-t", f.state().mainAdvances[0]!])).toBe("commit");
    }
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
