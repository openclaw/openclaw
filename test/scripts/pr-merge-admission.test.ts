import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createMergeOutcomeFixtureHarness } from "./pr-merge-outcome.test-support.js";

const { fixture, outcomeRef, lockRef, describePosix, unknownProjection } =
  createMergeOutcomeFixtureHarness();

describePosix("native merge outcome with real Git and supervised lock recovery", () => {
  it("stops before intent when queue removal invalidates the captured squash body", () => {
    const f = fixture();
    f.save({
      ...f.state(),
      pr: { ...f.state().pr, isMergeQueueEnabled: true },
      observations: [{ pr: { isMergeQueueEnabled: false } }],
    });
    const run = f.run();
    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain("queue policy changed during admission");
    expect(f.state().mutations).toBe(0);
    expect(f.captures()).toEqual([]);
    expect(() => f.record()).toThrow();
  });

  it.each(["", "Reviewed body\r\n\r\n"])(
    "dispatches ordinary squash once with server headline defaults and exact body bytes %j",
    (body) => {
      const f = fixture();
      const bodyPath = join(f.repo, "body.md");
      writeFileSync(bodyPath, body);
      const run = f.run(false, f.repo, "squash", "", "", bodyPath);
      expect(run.status, run.output).toBe(0);
      const state = f.state();
      expect(state.graphqlMergePayloads).toEqual([
        {
          pullRequestId: "fixture-pr",
          expectedHeadOid: f.head,
          mergeMethod: "SQUASH",
          commitBody: body,
        },
      ]);
      expect(state.calls.some((call) => call[1] === "pr" && call[2] === "merge")).toBe(false);
      expect(state.observationReads).toBe(4);
      expect(state.mutations).toBe(1);
      expect(f.record()).toMatchObject({ phase: "complete", head: f.head });
    },
  );

  it("explains every rejected admission fact and local conflicts before dispatch", () => {
    const f = fixture();
    f.advance("conflicting main\n", "stable\n");
    f.save({
      ...f.state(),
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
    expect(run.status, run.output).toBe(1);
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
      "lock-recover, then rerun merge-run",
    ]) {
      expect(run.output).toContain(line);
    }
    expect(f.state().mutations).toBe(0);
    expect(f.state().posts).toBe(0);
    expect(() => f.record()).toThrow();
    expect(f.captures()).toEqual([]);
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
      f.save({
        ...f.state(),
        admin,
        gates: admin ? "fail" : "pass",
        observations: [
          ...(settles ? [{ pr: unknownProjection }] : []),
          { pr: { mergeable: "MERGEABLE", mergeStateStatus } },
        ],
      });
      const run = f.run();
      expect(f.state().mutations, run.output).toBe(0);
      expect(run.status, run.output).toBe(1);
      expect(f.state().posts).toBe(0);
      expect(f.state().settlementSleeps).toEqual(settles ? [1] : []);
      expect(() => f.record()).toThrow();
      expect(f.captures()).toEqual([]);
      expect(existsSync(f.worktree)).toBe(true);
      expect(f.git(["--git-dir=" + f.remote, "rev-parse", "topic"])).toBe(f.head);
      expect(run.output).toContain(`mergeStateStatus: observed="${mergeStateStatus}"; expected=`);
      expect(run.output).toContain("lock-recover, then rerun merge-run");
      if (mergeStateStatus === "DIRTY") {
        expect(run.output).toContain("Conflicts exist");
      }
    },
  );

  it.each([
    { auto: false, mergeStateStatus: "CLEAN", route: "immediate" },
    { auto: true, mergeStateStatus: "CLEAN", route: "immediate" },
    { auto: true, mergeStateStatus: "BEHIND", route: "auto" },
    { auto: true, mergeStateStatus: "BLOCKED", route: "auto" },
    { auto: false, mergeStateStatus: "CLEAN", route: "immediate", statusFirst: true },
  ])(
    "settles initial UNKNOWN projections before one pinned dispatch: %j",
    ({ auto, mergeStateStatus, route, statusFirst }) => {
      const f = fixture();
      f.save({
        ...f.state(),
        observations: [
          { pr: unknownProjection },
          { pr: statusFirst ? { mergeStateStatus } : { mergeable: "MERGEABLE" } },
          { pr: statusFirst ? { mergeable: "MERGEABLE" } : { mergeStateStatus } },
        ],
      });
      const run = f.run(auto);
      expect(run.status, run.output).toBe(0);
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
      expect(state.mutations).toBe(1);
      expect(state.posts).toBe(1);
      expect(state.settlementSleeps).toEqual([1, 2]);
      expect(f.record()).toMatchObject({ route, phase: "complete", head: f.head, main: f.base });
      expect(f.git(["show", `${f.record().landed}:owner.txt`])).toBe("after");
    },
  );

  it.each(["settlement", "final"])(
    "lands ordinary squash when main advances during %s admission",
    (stage) => {
      const f = fixture();
      const main = f.commit(f.tree("before\n", "advanced\n"), [f.base]);
      const settled = { pr: { mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" } };
      f.save({
        ...f.state(),
        observations: [
          { pr: unknownProjection },
          { ...settled, ...(stage === "settlement" ? { main } : {}) },
          ...(stage === "final" ? [{ main }] : []),
        ],
      });

      const run = f.run(stage === "final");

      expect(run.status, run.output).toBe(0);
      expect(f.record()).toMatchObject({
        phase: "complete",
        head: f.head,
        main: stage === "settlement" ? main : f.base,
      });
      expect(f.state().mutations).toBe(1);
      expect(f.state().posts).toBe(1);
      expect(f.git(["show", `${f.record().landed}:owner.txt`])).toBe("after");
      expect(f.git(["show", `${f.record().landed}:sibling.txt`])).toBe("advanced");
    },
  );

  it("preserves gh queue eligibility when the verified admin route is selected", () => {
    const f = fixture();
    f.save({
      ...f.state(),
      admin: true,
      gates: "fail",
      pr: { ...f.state().pr, isMergeQueueEnabled: true, mergeStateStatus: "DIRTY" },
    });
    const run = f.run();
    expect(run.status, run.output).toBe(0);
    expect(f.state().mutations).toBe(1);
    expect(f.record()).toMatchObject({ route: "admin", phase: "complete", head: f.head });
  });

  it.each([
    "persistent UNKNOWN",
    "persistent UNKNOWN mergeable",
    "persistent UNKNOWN status",
    "known mergeable reverts",
    "known status reverts",
    "known status changes",
    "invalid metadata",
    "API error",
    "PR identity",
    "head",
    "base",
    "closed",
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
    "final changed status",
  ])("stops initial settlement without dispatch on %s", (fault) => {
    const f = fixture();
    const next = f.state();
    const { author: _author, headRefName: _headRefName, ...observedPr } = next.pr;
    const step: (typeof next.observations)[number] = {};
    switch (fault) {
      case "invalid metadata":
        step.invalid = true;
        break;
      case "API error":
        step.unavailable = true;
        break;
      case "PR identity":
        step.pr = { id: "other-pr" };
        break;
      case "head":
        step.pr = { headRefOid: f.base };
        break;
      case "base":
        step.pr = { baseRefName: "release" };
        break;
      case "closed":
        step.pr = { state: "CLOSED" };
        break;
      case "merged":
        step.main = f.commit(f.tree("after\n"), [f.base]);
        step.pr = { state: "MERGED", mergeCommit: { oid: step.main } };
        break;
      case "draft":
        step.pr = { isDraft: true };
        break;
      case "auto request":
        step.pr = { autoMergeRequest: { mergeMethod: "SQUASH" } };
        break;
      case "queue policy":
        step.pr = { isMergeQueueEnabled: true };
        break;
      case "queue membership":
        step.pr = { isInMergeQueue: true };
        break;
      case "invalid receipt":
        step.pr = { mergeCommit: { oid: f.head } };
        break;
      case "conflicting":
        step.pr = { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" };
        break;
      case "known HAS_HOOKS":
        step.pr = { mergeable: "MERGEABLE", mergeStateStatus: "HAS_HOOKS" };
        break;
      case "known mergeable reverts":
        step.pr = { mergeable: "UNKNOWN" };
        break;
      case "known status reverts":
        step.pr = { mergeStateStatus: "UNKNOWN" };
        break;
      case "known status changes":
        step.pr = { mergeStateStatus: "BEHIND" };
        break;
      case "final UNKNOWN mergeable":
        step.pr = { mergeable: "UNKNOWN" };
        break;
      case "final UNKNOWN status":
        step.pr = { mergeStateStatus: "UNKNOWN" };
        break;
      case "final changed status":
        step.pr = { mergeStateStatus: "BEHIND" };
        break;
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
    expect(run.status, run.output).toBe(1);
    const state = f.state();
    expect(state.observationReads).toBe(persistent || finalRead || projectionDrift ? 3 : 2);
    expect(state.settlementSleeps).toEqual(persistent || projectionDrift ? [1, 2] : [1]);
    expect(state.mutations).toBe(0);
    expect(state.posts).toBe(0);
    expect(() => f.record()).toThrow();
    expect(f.captures()).toEqual([]);
    expect(existsSync(f.worktree)).toBe(true);
    expect(f.git(["--git-dir=" + f.remote, "rev-parse", "topic"])).toBe(f.head);
    expect(f.git(["cat-file", "-t", lockRef])).toBe("blob");
    expect(run.output).toContain("Waiting for GitHub mergeability to settle");
    if (persistent) {
      expect(run.output).toContain("stopped before intent/dispatch");
    }
    if (finalRead) {
      expect(run.output).toContain("PR or main changed during observation");
      expect(run.output).toContain("lock-recover, then rerun merge-run");
      expect(run.output).toContain(
        fault === "final UNKNOWN mergeable"
          ? 'mergeable: observed="UNKNOWN"; expected="MERGEABLE"'
          : `mergeStateStatus: observed="${fault === "final UNKNOWN status" ? "UNKNOWN" : "BEHIND"}"; expected="CLEAN"`,
      );
      for (const [label, expected] of [
        ["observation", { main: f.base, pr: observedPr, transport: "graphql" }],
        [
          "reread",
          { main: step.main ?? f.base, pr: { ...observedPr, ...step.pr }, transport: "graphql" },
        ],
      ] as const) {
        const prefix = `Merge stability ${label}: `;
        const snapshots = run.stderr
          .split("\n")
          .filter((line) => line.startsWith(prefix))
          .map((line) => JSON.parse(line.slice(prefix.length)));
        expect(snapshots, run.output).toEqual([expected]);
      }
    }
    if (projectionDrift) {
      expect(run.output).toContain("PR or main changed while waiting for mergeability");
    }
    if (fault === "known HAS_HOOKS") {
      expect(run.output).toContain(
        "auto-merge admission requires MERGEABLE with CLEAN, BEHIND, or BLOCKED status",
      );
    }
    if (fault === "conflicting") {
      const prefix = `Merge admission rejected (observation 2, prepared head ${f.head}): `;
      const rejected = run.stderr
        .split("\n")
        .filter((line) => line.startsWith(prefix))
        .map((line) => JSON.parse(line.slice(prefix.length)));
      expect(rejected, run.output).toEqual([
        { main: f.base, pr: { ...observedPr, ...step.pr }, transport: "graphql" },
      ]);
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
    if (change === "head") {
      next.pr.headRefOid = f.base;
    }
    if (change === "base") {
      next.pr.baseRefName = "release";
    }
    if (change === "closed") {
      next.pr.state = "CLOSED";
    }
    if (change === "draft") {
      next.pr.isDraft = true;
    }
    if (change === "invalid") {
      next.invalid = true;
    }
    if (change === "unavailable") {
      next.unavailable = true;
    }
    if (change === "drift") {
      next.drift = true;
    }
    if (change === "conflict") {
      f.advance("conflict\n");
    }
    if (change === "no-op") {
      f.advance();
    }
    if (change === "ancestral-revert") {
      f.git(["push", "-q", "origin", f.head + ":refs/heads/main"]);
      f.advance("before\n");
    }
    f.save(next);
    const run = f.run();
    expect(run.status, run.output).toBe(1);
    expect(f.state().mutations).toBe(0);
    if (["no-op", "ancestral-revert"].includes(change)) {
      expect(run.output).toContain("NO NET CHANGE");
    }
  });

  it("does not impose squash no-op semantics on an ancestry-recording merge", () => {
    const f = fixture();
    f.advance();
    const run = f.run(false, f.repo, "merge");
    expect(run.status, run.output).toBe(0);
    expect(f.state().mutations).toBe(1);
    f.git(["merge-base", "--is-ancestor", f.head, f.record().landed]);
  });

  it.each(["review", "ready", "checks", "pending", "existing-auto", "auto-ineligible"])(
    "keeps %s admission ahead of intent",
    (gate) => {
      const f = fixture();
      const next = f.state();
      if (gate === "review") {
        next.review = false;
      }
      if (gate === "ready") {
        next.ready = false;
      }
      if (gate === "checks") {
        next.gates = "fail";
      }
      if (gate === "pending") {
        next.gates = "pending";
      }
      if (gate === "existing-auto") {
        next.pr.autoMergeRequest = { mergeMethod: "MERGE" };
      }
      if (gate === "auto-ineligible") {
        next.pr.mergeStateStatus = "HAS_HOOKS";
      }
      f.save(next);
      const run = f.run(true);
      expect(run.status, run.output).toBe(1);
      expect(f.state().mutations).toBe(0);
      expect(() => f.record()).toThrow();
    },
  );

  it("blocks ack-only ClawSweeper evidence before intent", () => {
    const f = fixture();
    f.save({
      ...f.state(),
      issueComments: [
        {
          id: 1,
          body: "<!-- clawsweeper-pr-ack:opened item=123 -->",
          user: { id: 274271284, login: "clawsweeper[bot]", type: "Bot" },
        },
      ],
    });

    const run = f.run();

    expect(run.status, run.output).toBe(1);
    expect(f.state().mutations).toBe(0);
    expect(() => f.record()).toThrow();
  });

  it.each([
    {
      name: "removed",
      comments: [
        {
          id: 2,
          body: "<!-- clawsweeper-pr-ack:opened item=123 -->",
          user: { id: 274271284, login: "clawsweeper[bot]", type: "Bot" },
        },
      ],
    },
    {
      name: "expired",
      comments: [
        {
          id: 2,
          body: `<!-- clawsweeper-review-version item=123 reviewed_at=${new Date(Date.now() - 13 * 60 * 60_000).toISOString()} sha=${"a".repeat(40)} source_revision=${"c".repeat(64)} lease_owner=github-run-2 lease_comment_id=2 v=1 -->

<!-- clawsweeper-review item=123 -->`,
          user: { id: 274271284, login: "clawsweeper[bot]", type: "Bot" },
        },
      ],
    },
  ])("revalidates $name review evidence immediately before intent", ({ comments }) => {
    const f = fixture();
    f.save({ ...f.state(), issueCommentsAfterFirst: comments });

    const run = f.run();

    expect(run.status, run.output).toBe(1);
    expect(f.state().issueCommentReads).toBe(2);
    expect(f.state().mutations).toBe(0);
    expect(() => f.record()).toThrow();
  });

  it("fails closed when the final review comment read is unavailable", () => {
    const f = fixture();
    f.save({ ...f.state(), issueCommentsErrorAt: 2 });

    const run = f.run();

    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain("unable to read current issue comments");
    expect(f.state().mutations).toBe(0);
    expect(() => f.record()).toThrow();
  });

  it("retains evidence from a newer completion observed at final admission", () => {
    const f = fixture();
    const reviewedAt = new Date(Date.now() + 1_000).toISOString();
    f.save({
      ...f.state(),
      issueCommentsAfterFirst: [
        ...f.state().issueComments,
        {
          id: 2,
          body: `<!-- clawsweeper-review-version item=123 reviewed_at=${reviewedAt} sha=${f.head} source_revision=${"c".repeat(64)} lease_owner=github-run-2 lease_comment_id=2 v=1 -->

<!-- clawsweeper-review item=123 -->`,
          user: { id: 274271284, login: "clawsweeper[bot]", type: "Bot" },
        },
      ],
    });

    const run = f.run();

    expect(run.status, run.output).toBe(0);
    expect(f.record().clawsweeperReview).toMatchObject({
      commentId: 2,
      reviewedAt,
      reviewedSha: f.head,
      sourceRevision: "c".repeat(64),
    });
  });
});
