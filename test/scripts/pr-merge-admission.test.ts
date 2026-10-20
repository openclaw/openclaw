import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  applyFault,
  configureMerge,
  expectExit,
  expectGraphqlSquash,
} from "./pr-merge-assertions.test-support.js";
import { createMergeOutcomeFixtureHarness } from "./pr-merge-outcome.test-support.js";

const { fixture, outcomeRef, lockRef, describePosix, unknownProjection } =
  createMergeOutcomeFixtureHarness();

function expectNoDispatch(f: ReturnType<typeof fixture>) {
  expect(f.state()).toMatchObject({ mutations: 0, posts: 0 });
  expect(() => f.record()).toThrow();
  expect(f.captures()).toEqual([]);
}

function expectSnapshot(stderr: string, prefix: string, expected: unknown) {
  const snapshots = stderr.split("\n").filter((line) => line.startsWith(prefix));
  expect(
    snapshots.map((line) => JSON.parse(line.slice(prefix.length))),
    stderr,
  ).toEqual([expected]);
}

describePosix("native merge outcome with real Git and supervised lock recovery", () => {
  it("merges without a ClawSweeper comment or pre-dispatch comment read", () => {
    const f = fixture();
    configureMerge(f, { issueCommentsErrorAt: 1 });
    expectExit(f.run());
    expect(f.state()).toMatchObject({ issueCommentReads: 0, mutations: 1 });
    expect(f.record()).toMatchObject({ phase: "complete", head: f.head });
    expect(() => f.git(["rev-parse", "--verify", lockRef])).toThrow();
  });

  it("stops before intent when queue removal invalidates the captured squash body", () => {
    const f = fixture();
    configureMerge(f, {
      pr: { isMergeQueueEnabled: true },
      observations: [{ pr: { isMergeQueueEnabled: false } }],
    });
    const run = f.run();
    expectExit(run, 1);
    expect(run.output).toContain("queue policy changed during admission");
    expectNoDispatch(f);
  });

  it.each(["", "Reviewed body\r\n\r\n"])(
    "dispatches ordinary squash once with server headline defaults and exact body bytes %j",
    (body) => {
      const f = fixture();
      const bodyPath = join(f.repo, "body.md");
      writeFileSync(bodyPath, body);
      expectExit(f.run(false, f.repo, "squash", "", "", bodyPath));
      const state = f.state();
      expectGraphqlSquash(f, body);
      expect(state.calls.some((call) => call[1] === "pr" && call[2] === "merge")).toBe(false);
      expect(state).toMatchObject({ observationReads: 4, mutations: 1 });
      expect(f.record()).toMatchObject({ phase: "complete", head: f.head });
    },
  );

  it("explains every rejected admission fact and local conflicts before dispatch", () => {
    const f = fixture();
    f.advance("conflicting main\n", "stable\n");
    configureMerge(f, {
      observations: [
        {
          pr: {
            state: "CLOSED",
            headRefOid: f.base,
            baseRefName: "release",
            isDraft: true,
            mergeable: "CONFLICTING",
            mergeStateStatus: "DIRTY",
            autoMergeRequest: { mergeMethod: "SQUASH" },
            isInMergeQueue: true,
          },
        },
      ],
    });
    const run = f.run();
    expectExit(run, 1);
    for (const line of [
      'state: observed="CLOSED"; expected="OPEN"',
      `headRefOid: observed="${f.base}"; expected="${f.head}"`,
      'baseRefName: observed="release"; expected="main"',
      "isDraft: observed=true; expected=false",
      'mergeable: observed="CONFLICTING"; expected="MERGEABLE|UNKNOWN"',
      'autoMergeRequest: observed={"mergeMethod":"SQUASH"}; expected=null',
      "isInMergeQueue: observed=true; expected=false",
      'REST pulls/123: mergeable=false; mergeable_state="dirty"',
      "Conflicting path: owner.txt",
      `Local outcome ref ${outcomeRef}: absent`,
      "Legacy .local/merge-output.log: absent",
      "rerun merge-run; if the operation lock was retained",
    ]) {
      expect(run.output).toContain(line);
    }
    expectNoDispatch(f);
  });

  it.each([
    { mergeStateStatus: "BLOCKED", admin: false, settles: true },
    { mergeStateStatus: "BEHIND", admin: false, settles: false },
    { mergeStateStatus: "DIRTY", admin: false, settles: false },
    { mergeStateStatus: "DIRTY", admin: true, settles: false },
  ])(
    "refuses merge before intent when gh would reject: %j",
    ({ mergeStateStatus, admin, settles }) => {
      const f = fixture();
      configureMerge(f, {
        admin,
        gates: admin ? "fail" : "pass",
        observations: [
          ...(settles ? [{ pr: unknownProjection }] : []),
          { pr: { mergeable: "MERGEABLE", mergeStateStatus } },
        ],
      });
      const run = f.run();
      expectExit(run, 1);
      expectNoDispatch(f);
      expect(f.state().settlementSleeps).toEqual(settles ? [2] : []);
      expect(existsSync(f.worktree)).toBe(true);
      expect(f.git(["--git-dir=" + f.remote, "rev-parse", "topic"])).toBe(f.head);
      expect(run.output).toContain(`mergeStateStatus: observed="${mergeStateStatus}"; expected=`);
      expect(run.output).toContain("rerun merge-run; if the operation lock was retained");
      if (mergeStateStatus === "DIRTY") {
        expect(run.output).toContain("Conflicts exist");
      }
    },
  );

  it.each([
    { auto: false, mergeStateStatus: "CLEAN", route: "immediate" },
    { auto: true, mergeStateStatus: "BLOCKED", route: "auto" },
    { auto: false, mergeStateStatus: "CLEAN", route: "immediate", statusFirst: true },
  ])(
    "settles initial UNKNOWN projections before one pinned dispatch: %j",
    ({ auto, mergeStateStatus, route, statusFirst }) => {
      const f = fixture();
      configureMerge(f, {
        observations: [
          { pr: unknownProjection },
          { pr: statusFirst ? { mergeStateStatus } : { mergeable: "MERGEABLE" } },
          { pr: statusFirst ? { mergeable: "MERGEABLE" } : { mergeStateStatus } },
        ],
      });
      const run = f.run(auto);
      expectExit(run);
      const state = f.state();
      const submissions = state.calls.filter((call) => call[1] === "pr" && call[2] === "merge");
      if (route === "immediate") {
        expect(submissions).toHaveLength(0);
        expect(state.graphqlMergePayloads[0]?.expectedHeadOid).toBe(f.head);
      } else {
        expect(submissions).toHaveLength(1);
        const args = submissions[0]!;
        expect(args[args.indexOf("--match-head-commit") + 1]).toBe(f.head);
        expect(args).toContain("--auto");
      }
      expect(state).toMatchObject({ mutations: 1, posts: 1, settlementSleeps: [2, 4] });
      expect(f.record()).toMatchObject({ route, phase: "complete", head: f.head, main: f.base });
      expect(f.git(["show", `${f.record().landed}:owner.txt`])).toBe("after");
    },
  );

  it("allows GitHub mergeability to settle after the old three-observation limit", () => {
    const f = fixture();
    configureMerge(f, {
      observations: [
        ...Array.from({ length: 5 }, () => ({ pr: unknownProjection })),
        { pr: { mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" } },
      ],
    });
    expectExit(f.run());
    expect(f.state()).toMatchObject({ settlementSleeps: [2, 4, 8, 8, 8], mutations: 1 });
    expect(f.record()).toMatchObject({ phase: "complete", head: f.head });
  });

  it.each([
    { route: "ordinary", stage: "settlement" },
    { route: "ordinary", stage: "final" },
    { route: "ordinary", stage: "recalculation" },
    { route: "auto", stage: "recalculation" },
    { route: "auto", stage: "projection change" },
    { route: "auto", stage: "unstable projection" },
    { route: "auto", stage: "hooks projection" },
    { route: "Crabbox", stage: "settlement" },
    { route: "Crabbox", stage: "final" },
    { route: "Crabbox", stage: "recalculation" },
    { route: "Crabbox", stage: "last reread" },
    { route: "Crabbox", stage: "projection change" },
    { route: "Crabbox", stage: "proof recalculation" },
  ])("lands $route squash when main advances during $stage admission", ({ route, stage }) => {
    const f = fixture();
    const main = f.commit(f.tree("before\n", "advanced\n"), [f.base]);
    const mergeStateStatus = route === "auto" ? "BLOCKED" : "CLEAN";
    const settled = { pr: { mergeable: "MERGEABLE", mergeStateStatus } };
    const projections: Record<string, Partial<typeof settled.pr>> = {
      recalculation: unknownProjection,
      "projection change": { mergeStateStatus: route === "auto" ? "CLEAN" : "BLOCKED" },
      "unstable projection": { mergeStateStatus: "UNSTABLE" },
      "hooks projection": { mergeStateStatus: "HAS_HOOKS" },
    };
    configureMerge(f, {
      admin: route === "Crabbox",
      gates: route === "Crabbox" ? "fail" : "pass",
      observations:
        stage === "settlement"
          ? [{ pr: unknownProjection }, { ...settled, main }]
          : stage === "proof recalculation"
            ? [settled, { main, reportedMain: f.base }, { pr: unknownProjection }, settled]
            : [
                settled,
                ...(stage === "last reread" ? [{}] : []),
                { main, ...(projections[stage] ? { pr: projections[stage] } : {}) },
                ...(stage === "recalculation" ? [settled] : []),
              ],
    });

    expectExit(f.run(route === "auto"));
    expect(f.record()).toMatchObject({
      phase: "complete",
      route: route === "Crabbox" ? "admin" : route === "auto" ? "auto" : "immediate",
      head: f.head,
      main: stage === "settlement" ? main : f.base,
    });
    expect(f.state()).toMatchObject({ mutations: 1, posts: 1 });
    expect(f.state().settlementSleeps).toEqual(
      stage === "settlement" || stage.includes("recalculation") ? [2] : [],
    );
    expect(f.git(["rev-parse", `${f.record().landed}^1`])).toBe(main);
    expect(f.git(["show", `${f.record().landed}:owner.txt`])).toBe("after");
    expect(f.git(["show", `${f.record().landed}:sibling.txt`])).toBe("advanced");
  });

  it.each([
    "rewritten main",
    "rewritten observed main",
    "conflicting tree",
    "head",
    "closed",
    "draft",
    "queue policy",
    "blocked route",
    "persistent UNKNOWN",
    "strict ordinary",
    "strict initial",
    "strict Crabbox",
    "rewritten final Crabbox main",
  ])("stops a main advance before dispatch on %s", (fault) => {
    const f = fixture();
    const main = f.commit(
      f.tree(fault === "conflicting tree" ? "conflict\n" : "before\n", "advanced\n"),
      fault === "rewritten main" ? [] : [f.base],
    );
    const faults: Record<string, Partial<ReturnType<typeof f.state>["pr"]>> = {
      head: { headRefOid: f.base },
      closed: { state: "CLOSED" },
      draft: { isDraft: true },
      "queue policy": { isMergeQueueEnabled: true },
      "blocked route": { mergeStateStatus: "BEHIND" },
      "persistent UNKNOWN": unknownProjection,
    };
    const first =
      fault === "rewritten observed main"
        ? f.commit(f.tree("before\n", "first advance\n"), [f.base])
        : f.base;
    configureMerge(f, {
      admin: fault.includes("Crabbox"),
      gates: fault.includes("Crabbox") ? "fail" : "pass",
      strictDrift: fault.startsWith("strict "),
      observations:
        fault === "strict initial"
          ? [{ main }]
          : fault === "rewritten final Crabbox main"
            ? [
                {},
                { main, reportedMain: f.base },
                { main: f.commit(f.tree("before\n", "later\n"), [main]), pr: unknownProjection },
                { main, pr: { mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" } },
              ]
            : [{ main: first }, { main, pr: faults[fault] ?? {} }],
    });

    const run = f.run();
    expect(run.status, run.output).not.toBe(0);
    expectNoDispatch(f);
    expect(run.output).toContain(
      fault.startsWith("rewritten")
        ? "both observed and verified main"
        : fault === "conflicting tree"
          ? "cannot establish prepared-head merge tree"
          : fault === "persistent UNKNOWN"
            ? "mergeability recalculation remained UNKNOWN"
            : fault.startsWith("strict ")
              ? "OPENCLAW_PR_STRICT_DRIFT=1"
              : fault === "blocked route"
                ? "selected merge route is blocked"
                : "PR or main changed during observation",
    );
  });

  it("preserves gh queue eligibility when the verified admin route is selected", () => {
    const f = fixture();
    configureMerge(f, {
      admin: true,
      gates: "fail",
      pr: { isMergeQueueEnabled: true, mergeStateStatus: "DIRTY" },
    });
    expectExit(f.run());
    expect(f.state().mutations).toBe(1);
    expect(f.record()).toMatchObject({ route: "admin", phase: "complete", head: f.head });
  });

  it.each([
    "persistent UNKNOWN mergeable",
    "persistent UNKNOWN status",
    "known mergeable reverts",
    "known status reverts",
    "invalid metadata",
    "API error",
    "PR identity",
    "head",
    "merged",
    "draft",
    "auto request",
    "queue policy",
    "queue membership",
    "invalid receipt",
    "conflicting",
    "known HAS_HOOKS",
    "final UNKNOWN mergeable",
    "final UNKNOWN status",
  ])("stops initial settlement without dispatch on %s", (fault) => {
    const f = fixture();
    const next = f.state();
    const { author: _author, headRefName: _headRefName, ...observedPr } = next.pr;
    const steps: Record<string, (typeof next.observations)[number]> = {
      "invalid metadata": { invalid: true },
      "API error": { unavailable: true },
      "PR identity": { pr: { id: "other-pr" } },
      head: { pr: { headRefOid: f.base } },
      draft: { pr: { isDraft: true } },
      "auto request": { pr: { autoMergeRequest: { mergeMethod: "SQUASH" } } },
      "queue policy": { pr: { isMergeQueueEnabled: true } },
      "queue membership": { pr: { isInMergeQueue: true } },
      "invalid receipt": { pr: { mergeCommit: { oid: f.head } } },
      conflicting: { pr: { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" } },
      "known HAS_HOOKS": { pr: { mergeable: "MERGEABLE", mergeStateStatus: "HAS_HOOKS" } },
      "known mergeable reverts": { pr: { mergeable: "UNKNOWN" } },
      "known status reverts": { pr: { mergeStateStatus: "UNKNOWN" } },
      "final UNKNOWN mergeable": { pr: { mergeable: "UNKNOWN" } },
      "final UNKNOWN status": { pr: { mergeStateStatus: "UNKNOWN" } },
    };
    const step = steps[fault] ?? {};
    if (fault === "merged") {
      step.main = f.commit(f.tree("after\n"), [f.base]);
      step.pr = { state: "MERGED", mergeCommit: { oid: step.main } };
    }
    next.observations = [{ pr: unknownProjection }];
    const persistent = fault.startsWith("persistent ");
    if (fault === "persistent UNKNOWN mergeable") {
      next.observations = [{ pr: { mergeable: "UNKNOWN", mergeStateStatus: "CLEAN" } }];
    }
    if (fault === "persistent UNKNOWN status") {
      next.observations = [{ pr: { mergeable: "MERGEABLE", mergeStateStatus: "UNKNOWN" } }];
    }
    const projectionDrift =
      fault === "known mergeable reverts" || fault.startsWith("known status ");
    if (projectionDrift) {
      next.observations.push({
        pr:
          fault === "known mergeable reverts"
            ? { mergeable: "MERGEABLE" }
            : { mergeStateStatus: "CLEAN" },
      });
    }
    const finalRead = fault.startsWith("final ");
    if (finalRead) {
      next.observations.push({ pr: { mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" } });
    }
    if (!persistent) {
      next.observations.push(step);
    }
    f.save(next);
    const run = f.run(true);
    expectExit(run, 1);
    const state = f.state();
    if (persistent) {
      expect(run.output).toContain("60s");
      expect(state.settlementSleeps.reduce((total, delay) => total + delay, 0)).toBe(60);
      expect(state.settlementSleeps.every((delay) => delay <= 8)).toBe(true);
    } else {
      expect(state.observationReads).toBe(finalRead || projectionDrift ? 3 : 2);
      expect(state.settlementSleeps).toEqual(projectionDrift ? [2, 4] : [2]);
    }
    expectNoDispatch(f);
    expect(existsSync(f.worktree)).toBe(true);
    expect(f.git(["--git-dir=" + f.remote, "rev-parse", "topic"])).toBe(f.head);
    // A pre-dispatch stop drains cleanly, so the supervisor releases the process lock.
    expect(() => f.git(["rev-parse", "--verify", lockRef])).toThrow();
    expect(run.output).toContain("Waiting for GitHub mergeability to settle");
    if (persistent) {
      expect(run.output).toContain("stopped before intent/dispatch");
    }
    if (finalRead) {
      expect(run.output).toContain("PR or main changed during observation");
      expect(run.output).toContain("rerun merge-run; if the operation lock was retained");
      expect(run.output).toContain(
        fault === "final UNKNOWN mergeable"
          ? 'mergeable: observed="UNKNOWN"; expected="MERGEABLE"'
          : 'mergeStateStatus: observed="UNKNOWN"; expected="CLEAN"',
      );
      for (const [label, expected] of [
        ["observation", { main: f.base, pr: observedPr, transport: "graphql" }],
        [
          "reread",
          { main: step.main ?? f.base, pr: { ...observedPr, ...step.pr }, transport: "graphql" },
        ],
      ] as const) {
        expectSnapshot(run.stderr, `Merge stability ${label}: `, expected);
      }
    }
    if (projectionDrift) {
      expect(run.output).toContain("PR or main changed while waiting for mergeability");
    }
    if (fault === "known HAS_HOOKS") {
      expect(run.output).toContain(
        "auto-merge admission requires MERGEABLE with CLEAN, UNSTABLE, BEHIND, or BLOCKED status",
      );
    }
    if (fault === "conflicting") {
      expectSnapshot(
        run.stderr,
        `Merge admission rejected (observation 2, prepared head ${f.head}): `,
        { main: f.base, pr: { ...observedPr, ...step.pr }, transport: "graphql" },
      );
    }
  });

  it.each([
    "head",
    "base",
    "closed",
    "draft",
    "invalid",
    "unavailable",
    "conflict",
    "drift",
    "no-op",
    "ancestral-revert",
  ])("refuses new dispatch on %s", (change) => {
    const f = fixture();
    const next = f.state();
    applyFault(change, {
      head: () => (next.pr.headRefOid = f.base),
      base: () => (next.pr.baseRefName = "release"),
      closed: () => (next.pr.state = "CLOSED"),
      draft: () => (next.pr.isDraft = true),
      invalid: () => (next.invalid = true),
      unavailable: () => (next.unavailable = true),
      drift: () => (next.drift = true),
      conflict: () => f.advance("conflict\n"),
      "no-op": () => f.advance(),
      "ancestral-revert": () => {
        f.git(["push", "-q", "origin", f.head + ":refs/heads/main"]);
        f.advance("before\n");
      },
    });
    f.save(next);
    const run = f.run();
    expectExit(run, 1);
    expect(f.state().mutations).toBe(0);
    if (["no-op", "ancestral-revert"].includes(change)) {
      expect(run.output).toContain("NO NET CHANGE");
    }
  });

  it("does not impose squash no-op semantics on an ancestry-recording merge", () => {
    const f = fixture();
    f.advance();
    expectExit(f.run(false, f.repo, "merge"));
    expect(f.state().mutations).toBe(1);
    f.git(["merge-base", "--is-ancestor", f.head, f.record().landed]);
  });

  it.each(["review", "ready", "checks", "pending"])(
    "keeps %s admission ahead of intent",
    (gate) => {
      const f = fixture();
      const next = f.state();
      if (gate === "review" || gate === "ready") {
        next[gate] = false;
      } else {
        next.gates = gate === "checks" ? "fail" : "pending";
      }
      f.save(next);
      const run = f.run(true);
      expectExit(run, 1);
      expect(f.state().mutations).toBe(0);
      expect(() => f.record()).toThrow();
    },
  );
});
