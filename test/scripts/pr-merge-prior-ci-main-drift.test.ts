import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, expect, it } from "vitest";
import { copyTreeCloseOnExec } from "../helpers/close-on-exec-copy.js";
import { cleanupTempDirs, useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createMergeOutcomeFixtureHarness } from "./pr-merge-outcome.test-support.js";
import { createPriorCiCandidateFactory } from "./pr-merge-prior-ci.test-support.js";

const { describePosix, fixture } = createMergeOutcomeFixtureHarness();
const { preExistingCandidate: createCandidate } = createPriorCiCandidateFactory(fixture);
const snapshots = useAutoCleanupTempDirTracker(afterAll);
const restoredRoots = new Set<string>();
afterEach(() => cleanupTempDirs(restoredRoots));
let prepared: { candidate: ReturnType<typeof createCandidate>; snapshot: string } | undefined;

function preExistingCandidate() {
  if (!prepared) {
    const candidate = createCandidate();
    const snapshot = snapshots.make("pr-main-drift-setup-");
    copyTreeCloseOnExec(candidate.root, snapshot);
    prepared = { candidate, snapshot };
  } else {
    // Keep absolute worktree and evidence paths valid while resetting every case's refs and state.
    rmSync(prepared.candidate.root, { recursive: true, force: true });
    copyTreeCloseOnExec(prepared.snapshot, prepared.candidate.root);
    restoredRoots.add(prepared.candidate.root);
  }
  return prepared.candidate;
}

function expectNoDispatch(f: ReturnType<typeof preExistingCandidate>) {
  expect(f.state().mutations).toBe(0);
  expect(f.state().posts).toBe(0);
  expect(f.captures()).toEqual([]);
  expect(() => f.record()).toThrow();
}

describePosix("prior-CI forward main admission", () => {
  it("preserves the UNKNOWN budget while rematerializing a cold main before authority", () => {
    const f = preExistingCandidate();
    const unknown = { mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" };
    f.save({
      ...f.state(),
      mainProofDelaySeconds: 197,
      mainProofDelayAfterObservations: 5,
      observations: [
        {},
        {},
        {},
        {},
        { advanceMain: true, pr: unknown },
        { pr: unknown },
        { pr: { mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED" } },
      ],
    });

    const result = f.adminPriorCi(f.path);

    expect(result.error, result.output).toBeUndefined();
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain("Prior-CI local-only main unavailable");
    expect(f.state().mainProofDelayedAt).not.toBeNull();
    expect(f.state().mainAdvances).toHaveLength(1);
    expect(f.state().mutations).toBe(1);
    expect(f.record()).toMatchObject({ phase: "complete", head: f.head });
    expect(f.git(["rev-parse", `${f.record().landed}^1`])).toBe(f.state().mainAdvances[0]);
  });

  it.each([
    { transport: "graphql", proofSeconds: 197, readSeconds: 55, admitted: true },
    { transport: "rest", proofSeconds: 197, readSeconds: 55, admitted: true },
    { transport: "graphql", proofSeconds: 197, readSeconds: 61, admitted: false },
    { transport: "rest", proofSeconds: 197, readSeconds: 61, admitted: false },
    { transport: "rest", proofSeconds: 901, readSeconds: 0, admitted: false },
  ])(
    "keeps remote settlement bounded after $proofSeconds seconds of local proof over $transport ($readSeconds seconds remote)",
    ({ transport, proofSeconds, readSeconds, admitted }) => {
      const f = preExistingCandidate();
      const main = f.commit(f.tree("before\n", "advanced\n"), [f.base]);
      const state = f.state();
      const observations = [
        { main, pr: { mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" } },
        {
          pr: { mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED" },
          advanceSeconds: readSeconds,
        },
      ];
      state.mainProofDelaySeconds = proofSeconds;
      state.mainProofDelayMain = main;
      if (transport === "rest") {
        state.graphqlMergeProjection = { mergeStateStatus: "UNKNOWN" };
        state.restObservations = [{}, {}, {}, ...observations];
      } else {
        state.observations = [{}, ...observations];
      }
      f.save(state);

      const result = f.adminPriorCi(f.path);

      expect(result.error, result.output).toBeUndefined();
      expect(f.state().mainProofDelayedAt, result.output).not.toBeNull();
      if (admitted) {
        expect(result.status, result.output).toBe(0);
        expect(f.state().mutations).toBe(1);
        expect(f.record()).toMatchObject({ phase: "complete", head: f.head });
        expect(f.git(["rev-parse", `${f.record().landed}^1`])).toBe(main);
      } else {
        expect(result.status, result.output).not.toBe(0);
        expect(result.output).toContain(
          proofSeconds > 900 ? "900s/32-round limit" : "60s settle limit",
        );
        expectNoDispatch(f);
      }
    },
  );

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

  it("lands after more than three main advances once a round stays stable", () => {
    const f = preExistingCandidate();
    f.save({
      ...f.state(),
      graphqlMergeProjection: { mergeStateStatus: "UNKNOWN" },
      restObservations: [
        {},
        {},
        {},
        ...Array.from({ length: 4 }, () => ({ advanceMain: true })),
        {},
      ],
    });
    const result = f.adminPriorCi(f.path);
    expect(result.error, result.output).toBeUndefined();
    expect(result.status, result.output).toBe(0);
    expect(f.state().mainAdvances).toHaveLength(4);
    expect(result.output).toContain("Admin authority round 5:");
    expect(f.state().mutations).toBe(1);
    expect(f.record()).toMatchObject({ phase: "complete", head: f.head });
    expect(f.git(["rev-parse", `${f.record().landed}^1`])).toBe(f.state().mainAdvances.at(-1));
  });

  it("stops at the authority deadline before intent when main keeps advancing", () => {
    const f = preExistingCandidate();
    f.save({
      ...f.state(),
      graphqlMergeProjection: { mergeStateStatus: "UNKNOWN" },
      restObservations: [{}, {}, {}, { advanceMain: true, advanceSeconds: 901 }],
    });
    const result = f.adminPriorCi(f.path);
    expect(result.error, result.output).toBeUndefined();
    expect(result.status, result.output).not.toBe(0);
    expect(result.output).toContain("900s/32-round limit");
    expectNoDispatch(f);
  });

  it.each([
    "settlement",
    "final verification",
    "GraphQL recalculation",
    "final GraphQL recalculation",
    "remote-only final main",
    "remote-only recalculation",
    "known status",
    "final known status",
  ] as const)("lands the pinned head when main advances during %s", (stage) => {
    const f = preExistingCandidate();
    const remoteOnly = stage.startsWith("remote-only");
    const recalculating = stage.includes("recalculation");
    let main = remoteOnly ? f.base : f.commit(f.tree("before\n", "advanced\n"), [f.base]);
    const state = f.state();
    const unknown = { mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" };
    const settled = {
      mergeable: "MERGEABLE",
      mergeStateStatus: stage.includes("known status") ? "CLEAN" : "BLOCKED",
    };
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
      state.observations = stage.includes("known status")
        ? [
            ...Array.from({ length: stage === "known status" ? 1 : 4 }, () => ({})),
            { main, pr: settled },
          ]
        : stage === "settlement"
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
      expect(result.output).toContain(
        "Requalifying admin admission against the next fresh main snapshot",
      );
      expect(f.state().settlementSleeps).toEqual(recalculating ? [2] : []);
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
        expect(f.state().settlementSleeps).toEqual([2]);
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

  it("waits for late mergeability recalculation after a verified main advance", () => {
    const f = preExistingCandidate();
    const main = f.commit(f.tree("before\n", "advanced\n"), [f.base]);
    const unknown = { mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" };
    f.save({
      ...f.state(),
      observations: [
        {},
        { main, pr: unknown },
        ...Array.from({ length: 3 }, () => ({ pr: unknown })),
        { pr: { mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED" } },
      ],
    });

    const result = f.adminPriorCi(f.path);

    expect(result.status, result.output).toBe(0);
    expect(f.state().settlementSleeps).toEqual([2, 4, 8, 8]);
    expect(f.state().mutations).toBe(1);
    expect(f.record()).toMatchObject({ phase: "complete", head: f.head });
  });

  it.each([
    ["same main", "PR or main changed during observation"],
    ["persistent", "mergeability recalculation"],
    ["conflict", "PR or main changed during observation"],
    ["head", "PR or main changed during observation"],
    ["rewind", "both observed and verified main"],
    ["final revoked admin", "writer must be an active organization admin"],
    ["final revoked review", "current enforced reviews must be satisfied"],
  ] as const)("refuses %s during GraphQL recalculation", (fault, diagnostic) => {
    const f = preExistingCandidate();
    const main = f.commit(f.tree("before\n", "advanced\n"), [f.base]);
    const state = f.state();
    state.priorCi.revokeAdminOnMainFetch = true;
    if (fault === "persistent") {
      state.clockStep = 20;
    }
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
                mergeStateStatus: "BLOCKED",
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
    if (fault === "persistent") {
      expect(result.output).toContain("60s");
      expect(f.state().settlementSleeps.every((delay) => delay <= 8)).toBe(true);
    } else {
      expect(f.state().settlementSleeps).toEqual(fault === "same main" ? [] : [2]);
    }
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
    ["strict", "reread", "OPENCLAW_PR_STRICT_DRIFT=1"],
    ["strict", "first observation", "OPENCLAW_PR_STRICT_DRIFT=1"],
  ] as const)("refuses %s at %s before intent or merge I/O", (fault, stage, message) => {
    const f = preExistingCandidate();
    const state = f.state();
    state.strictDrift = fault === "strict";
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
        ["new failing suite", "currently effective CI gate"],
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
    if (fault === "new failing suite") {
      state.observations.at(-1)!.restUnseenSuite = "new-gate";
    }
    if (stage !== "reread" && fault === "admin") {
      state.priorCi.revokeAdminOnMainFetch = true;
    }
    f.save(state);

    const result = f.adminPriorCi(f.path);
    expect(result.error, result.output).toBeUndefined();

    expect(result.status, result.output).not.toBe(0);
    expect(result.output).toContain(message);
    if (stage === "rematerialization") {
      expect(result.output).toContain("Requalifying admin admission");
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
      state.observations = [{}, { main, pr: { headRefOid: f.base } }];
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
      expect(result.output).toContain("Requalifying admin admission");
      expect(f.git(["cat-file", "-t", f.state().mainAdvances[0]!])).toBe("commit");
    }
    expectNoDispatch(f);
  });

  it("refuses a changed Security Review publisher source on the newly observed main", () => {
    const f = preExistingCandidate();
    const blob = f.git(["hash-object", "-w", "--stdin"], "changed protected publisher source\n");
    const replace = (tree: string, name: string, entry: string) =>
      f.git(
        ["mktree"],
        [
          ...f
            .git(["ls-tree", tree])
            .split("\n")
            .filter((line) => !line.endsWith(`\t${name}`)),
          entry,
          "",
        ].join("\n"),
      );
    const lib = replace(
      `${f.base}:scripts/lib`,
      "bounded-response.mjs",
      `100644 blob ${blob}\tbounded-response.mjs`,
    );
    const scripts = replace(`${f.base}:scripts`, "lib", `040000 tree ${lib}\tlib`);
    const tree = replace(f.base, "scripts", `040000 tree ${scripts}\tscripts`);
    const main = f.commit(tree, [f.base]);
    f.save({ ...f.state(), observations: [{}, { main }] });

    const result = f.adminPriorCi(f.path);

    expect(result.status, result.output).not.toBe(0);
    expect(result.output).toContain("publisher source differs from the current owner");
    expectNoDispatch(f);
  });

  it("keeps retained prior-CI outcomes fenced after main moves", () => {
    const f = preExistingCandidate();
    f.save({ ...f.state(), mode: "unapplied" });
    f.adminPriorCi(f.path);
    expect(f.record()).toMatchObject({ phase: "intent", route: "admin" });
    expect(f.state().mutations).toBe(1);
    expect(f.recover()).toBe(false);
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
