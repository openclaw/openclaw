import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  applyFault,
  configuredFixture,
  configureMerge,
  expectExit,
  observeMerged,
} from "./pr-merge-assertions.test-support.js";
import { createMergeOutcomeFixtureHarness } from "./pr-merge-outcome.test-support.js";

const {
  fixture: createFixture,
  reconciledMergeAfterCleanup,
  outcomeRef,
  describePosix,
  unknownProjection,
} = createMergeOutcomeFixtureHarness();

const fixture = (changes: Parameters<typeof configureMerge>[1] = {}) =>
  configuredFixture(createFixture, changes);
const clean = { mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" };

describePosix("native merge outcome with real Git and supervised lock recovery", () => {
  it("lands green CI with MAINTAIN authority", () => {
    const f = fixture();
    const state = f.state();
    state.repoAuthority.permissions = { admin: false, maintain: true, push: true };
    state.restPolicy = "not-found";
    state.priorCi.membership = "member";
    f.save(state);

    expectExit(f.run());
    expect(f.record()).toMatchObject({ phase: "complete", head: f.head });
    expect(f.state().mutations).toBe(1);
    expect(f.state().calls.some((call) => call.some((arg) => arg.includes("/protection")))).toBe(
      false,
    );
    expect(f.state().calls.some((call) => call.some((arg) => arg.startsWith("orgs/")))).toBe(false);
  });

  it.each([
    { phase: "initial", settles: true },
    { phase: "initial", settles: false },
    { phase: "stability", settles: true },
    { phase: "stability", settles: false },
  ])("starts $phase UNKNOWN budget (settles=$settles)", ({ phase, settles }) => {
    const f = fixture();
    const main = f.commit(f.tree("before\n", "advanced\n"), [f.base]);
    configureMerge(f, {
      mode: "unapplied",
      observations: [
        ...(phase === "stability" ? [{}] : []),
        { main, pr: unknownProjection, advanceSeconds: 65 },
        ...(settles ? [{ pr: clean, advanceSeconds: 55 }] : []),
      ],
    });

    const result = expectExit(f.run(), 1);
    if (settles) {
      expect(f.state().settlementSleeps).toEqual([2]);
      expect(result.output).toContain("prior dispatch unresolved");
      expect(f.state().mutations).toBe(1);
      expect(f.record()).toMatchObject({ phase: "intent", head: f.head, accepted: false });
    } else {
      expect(f.state().settlementSleeps.reduce((total, delay) => total + delay, 0)).toBe(60);
      expect(result.output).toContain(
        phase === "initial"
          ? "mergeability remained UNKNOWN"
          : "mergeability recalculation remained UNKNOWN",
      );
      expect(f.state().mutations).toBe(0);
      expect(f.captures()).toEqual([]);
      expect(() => f.record()).toThrow();
    }
    expect(f.state().posts).toBe(0);
  });

  it.each([
    { name: "timely known", known: true, readSeconds: 0, proofSeconds: 65, admitted: true },
    { name: "late known", known: true, readSeconds: 65, proofSeconds: 0, admitted: false },
    { name: "still UNKNOWN", known: false, readSeconds: 0, proofSeconds: 65, admitted: false },
  ])(
    "uses projection time for $name admission",
    ({ known, readSeconds, proofSeconds, admitted }) => {
      const f = fixture();
      const main = f.commit(f.tree("before\n", "advanced\n"), [f.base]);
      configureMerge(f, {
        mainProofDelaySeconds: proofSeconds,
        observations: [
          { pr: unknownProjection },
          {
            main,
            pr: known ? clean : unknownProjection,
            advanceSeconds: readSeconds,
          },
        ],
      });

      const result = f.run();
      const state = f.state();

      expect(state.mainProofDelayedAt, result.output).toBe(proofSeconds ? 2 : null);
      expect(state.settlementSleeps[0]).toBe(2);
      expect(state.settlementSleeps.reduce((total, delay) => total + delay, 0)).toBe(
        known ? 2 : 60,
      );
      expect(result.status, result.output).toBe(admitted ? 0 : 1);
      expect(state.mutations).toBe(admitted ? 1 : 0);
      if (admitted) {
        expect(state.graphqlMergePayloads[0]?.expectedHeadOid).toBe(f.head);
        expect(f.record()).toMatchObject({ phase: "complete", head: f.head, main });
      } else {
        expect(result.output).toContain(
          known ? "mergeability exceeded the 60s settle limit" : "mergeability remained UNKNOWN",
        );
        expect(f.captures()).toEqual([]);
        expect(() => f.record()).toThrow();
      }
    },
  );

  it("completes after cleanup without redispatch", () => {
    const f = reconciledMergeAfterCleanup();
    const landed = f.git(["--git-dir=" + f.remote, "rev-parse", "main"]);
    const previous = f.git(["rev-parse", outcomeRef]);

    expectExit(f.complete(previous));
    expect(f.record()).toMatchObject({ phase: "complete", landed, head: f.head });
    expect(f.state()).toMatchObject({ mutations: 1, posts: 1 });
    expect(f.state().comments[0]!.body).toContain("Merged via squash.");
    expect(f.state().comments[0]!.body).toContain(`/commit/${landed}`);
    f.git(["merge-base", "--is-ancestor", previous, outcomeRef]);

    expectExit(f.complete(previous), 1);
    expect(f.record().phase).toBe("complete");
    expectExit(f.complete(f.git(["rev-parse", outcomeRef])));
    expect(f.state()).toMatchObject({ posts: 1, mutations: 1 });
  });

  it.each(["OPEN", "MERGED"])("reconciles retained %s without UNKNOWN polling", (state) => {
    const f = fixture({ mode: "unapplied" });
    expectExit(f.run(), 1);
    const before = f.git(["rev-parse", outcomeRef]);
    const capture = f.captures();
    f.recover();
    const landed = state === "MERGED" ? f.advance("after\n", "stable\n") : null;
    configureMerge(f, {
      observationReads: 0,
      pr: { ...unknownProjection, state, mergeCommit: landed ? { oid: landed } : null },
    });
    expectExit(f.run(), state === "MERGED" ? 0 : 1);
    expect(f.state()).toMatchObject({
      mutations: 1,
      posts: 0,
      settlementSleeps: [],
      observationReads: 2,
    });
    expect(f.captures()).toEqual(capture);
    expect(existsSync(f.worktree)).toBe(true);
    if (landed) {
      expect(f.record()).toMatchObject({ phase: "merged", landed });
    } else {
      expect(f.git(["rev-parse", outcomeRef])).toBe(before);
    }
  });

  it("preserves empty pre-journal output", () => {
    const f = fixture();
    const capture = join(f.worktree, ".local/merge-output.log");
    writeFileSync(capture, "");
    configureMerge(f, { mode: "unapplied" });
    const run = expectExit(f.run(), 1);
    expect(f.state().mutations).toBe(0);
    expect(readFileSync(capture, "utf8")).toBe("");
    expect(run.output).toContain("Legacy .local/merge-output.log: present");
    expect(run.output).toContain("investigate; see scripts/AGENTS.md merge-outcome doctrine");
    expect(run.output).not.toContain("rerun merge-run; if the operation lock was retained");
    expect(() => f.record()).toThrow();
  });

  it("does not replay applied OPEN after lock release", () => {
    const f = fixture({ mode: "applied-open" });
    expectExit(f.run(), 1);
    expect(f.state().pr.state).toBe("OPEN");
    f.advance();
    // The drained failure released the process lock; the outcome record still blocks a repeat.
    expect(f.recover()).toBe(false);
    const second = f.run();
    expect(f.state().mutations, "one mutation across lock release").toBe(1);
    expect(second.status, second.output).toBe(1);
    expect(f.state().posts).toBe(0);
    expect(second.output).toContain("prior dispatch unresolved");
  });

  it.each(["success", "applied-merged", "advance-at-dispatch"])(
    "confirms %s and retains completion after revert",
    (mode) => {
      const f = fixture({ mode, stale: true });
      const first = expectExit(f.run());
      expect(f.state().posts).toBe(1);
      expect(f.record().phase).toBe("complete");
      expect(first.output).not.toContain("Warning: recorded squash");
      expect(f.ordinaryRead().state).toBe("OPEN");
      f.advance("before\n");
      const second = expectExit(f.run());
      expect(f.state()).toMatchObject({ mutations: 1, posts: 1 });
      expect(second.output).toContain("already complete");
      expect(second.output).not.toContain("Warning: recorded squash");
    },
  );

  it.each(["intent", "dispatch", "receipt"])("retains uncertainty after %s crash", (crash) => {
    const f = fixture({ crash, mode: crash === "receipt" ? "success" : "applied-open" });
    expect(f.run().status).not.toBe(0);
    expect(f.record().phase).toBe("intent");
    f.recover();
    configureMerge(f, { crash: "" });
    expectExit(f.run(), crash === "receipt" ? 0 : 1);
    expect(f.state().mutations).toBe(crash === "intent" ? 0 : 1);
  });

  it.each(["head", "base", "closed", "invalid", "unavailable", "partial", "revert"])(
    "does not replay unresolved %s",
    (change) => {
      const f = fixture({ mode: "unapplied" });
      expectExit(f.run(), 1);
      f.recover();
      const next = f.state();
      applyFault(change, {
        head: () => Object.assign(next.pr, { headRefOid: f.base }),
        base: () => Object.assign(next.pr, { baseRefName: "release" }),
        closed: () => Object.assign(next.pr, { state: "CLOSED" }),
        invalid: () => Object.assign(next, { invalid: true }),
        unavailable: () => Object.assign(next, { unavailable: true }),
        partial: () => f.advance("partial\n"),
        revert: () => {
          f.advance();
          f.advance("before\n");
        },
      });
      f.save(next);
      expectExit(f.run(), 1);
      expect(f.state().mutations).toBe(1);
    },
  );

  it.each([false, true])("reconciles pending UNKNOWN (auto=%s)", (auto) => {
    const f = fixture({
      mode: "pending",
      pr: { isMergeQueueEnabled: !auto, mergeStateStatus: auto ? "BEHIND" : "BLOCKED" },
    });
    const first = expectExit(f.run(auto));
    expect(first.output).toContain("AUTO/QUEUE PENDING");
    const before = f.git(["rev-parse", outcomeRef]);
    const capture = f.captures();
    configureMerge(f, { observationReads: 0, pr: { ...unknownProjection } });
    const pending = f.run(auto);
    expect(f.state()).toMatchObject({ mutations: 1, posts: 0 });
    expect(f.git(["rev-parse", outcomeRef])).toBe(before);
    expect(f.captures()).toEqual(capture);
    expect(pending.status, pending.output).toBe(0);
    expect(pending.output).toContain("AUTO/QUEUE PENDING");
    expect(f.state().settlementSleeps).toEqual([]);
    expect(f.state().observationReads).toBe(2);
    const landed = f.advance("after\n", "stable\n");
    configureMerge(f, {
      pr: {
        state: "MERGED",
        mergeCommit: { oid: landed },
        autoMergeRequest: null,
        isInMergeQueue: false,
      },
    });
    expectExit(f.run(auto));
    expect(f.state().mutations).toBe(1);
  });

  it.each([false, true])("does not redispatch ambiguous auto=%s", (auto) => {
    const f = fixture({
      mode: "pending-error",
      pr: { isMergeQueueEnabled: !auto, mergeStateStatus: auto ? "BEHIND" : "BLOCKED" },
    });
    expect(f.run(auto).status).toBe(1);
    f.recover();
    configureMerge(f, { pr: { autoMergeRequest: null, isInMergeQueue: false } });
    expect(f.run(auto).status).toBe(1);
    expect(f.state().mutations).toBe(1);
  });

  it("audits admin landing in the prepared repository", () => {
    const f = fixture({ admin: true, gates: "fail", comment: "rejected" });
    const result = expectExit(f.run(), 1);
    expect(f.record().phase, result.output).toBe("commenting");
    expect(f.state().calls).toContainEqual([
      "direct",
      "api",
      `repos/fixture/repo/commits/${f.record().landed}`,
    ]);
    expect(
      JSON.parse(readFileSync(join(f.worktree, ".local/merge-crabbox-parent-audit.json"), "utf8")),
    ).toMatchObject({
      status: "match",
      expectedParentSha: f.base,
      actualParentSha: f.base,
    });
    f.recover();
  });

  it("retains admin merge after audit failure", () => {
    const f = fixture({ admin: true, audit: true, gates: "fail" });
    expectExit(f.run(), 1);
    expect(f.record()).toMatchObject({ route: "admin", phase: "merged" });
    f.recover();
    expectExit(f.run());
    expect(f.state()).toMatchObject({ mutations: 1, posts: 0 });
  });

  it("retains commits after worktree deletion and GC", () => {
    const f = fixture({ mode: "unapplied" });
    expectExit(f.run(), 1);
    f.recover();
    f.git(["worktree", "remove", "--force", f.worktree]);
    f.git(["branch", "-D", "pr-123-prep", "pr-123", "topic"]);
    f.git(["update-ref", "-d", "refs/remotes/origin/topic"]);
    f.git(["reflog", "expire", "--expire=now", "--all"]);
    f.git(["gc", "--prune=now"]);
    f.git(["cat-file", "-e", f.head + "^{commit}"]);
    expectExit(f.run(), 1);
    expect(f.state().mutations).toBe(1);
  });

  it.each([
    "corrupt",
    "symbolic",
    "mismatched",
    "missing-head",
    "missing-parent",
    "wrong-tree",
    "unreachable",
    "missing-landed",
    "recovery-head",
    "recovery-extra",
    "recovery-unretained",
    "recovery-method",
    "recovery-repo",
  ])("fails closed on %s outcome evidence", (fault) => {
    const f = fixture({ mode: "unapplied" });
    expectExit(f.run(), 1);
    f.recover();
    const previous = f.git(["rev-parse", outcomeRef]);
    if (fault.startsWith("recovery-")) {
      const original = f.record();
      const record = {
        ...original,
        method: fault === "recovery-method" ? "merge" : original.method,
        repo: fault === "recovery-repo" ? { ...original.repo, id: 1103012935 } : original.repo,
        recovery: {
          outcome: previous,
          attempt: original.attempt,
          actor: "fixture-operator",
          reason: "explicit-operator-recovery",
          replacementHead: fault === "recovery-head" ? f.base : f.head,
          ...(fault === "recovery-extra" ? { allow: true } : {}),
        },
      };
      const blob = f.git(["hash-object", "-w", "--stdin"], JSON.stringify(record));
      const tree = f.git(["mktree"], `100644 blob ${blob}\toutcome.json\n`);
      const parents = [f.head, f.base, ...(fault === "recovery-unretained" ? [] : [previous])];
      f.git(["update-ref", outcomeRef, f.commit(tree, parents)]);
    }
    if (fault === "corrupt") {
      f.git(["update-ref", outcomeRef, f.git(["hash-object", "-w", "--stdin"], "bad")]);
    }
    if (fault === "symbolic") {
      f.git(["symbolic-ref", outcomeRef, "refs/heads/topic"]);
    }
    if (fault === "mismatched") {
      configureMerge(f, { repoAuthority: { ...f.state().repoAuthority, node_id: "other-repo" } });
    }
    if (fault === "missing-head") {
      rmSync(join(f.repo, ".git/objects", f.head.slice(0, 2), f.head.slice(2)));
    }
    if (fault === "missing-parent") {
      const detached = f.commit(f.git(["rev-parse", previous + "^{tree}"]), []);
      f.git(["update-ref", outcomeRef, detached]);
    }
    if (fault === "wrong-tree" || fault === "unreachable" || fault === "missing-landed") {
      const landed =
        fault === "wrong-tree"
          ? f.advance("partial\n")
          : fault === "missing-landed"
            ? "1".repeat(40)
            : f.head;
      observeMerged(f, landed);
    }
    const before = f.git(["rev-parse", outcomeRef]);
    const retry = expectExit(f.run(), 1);
    expect(f.state()).toMatchObject({ mutations: 1, posts: 0 });
    expect(f.git(["rev-parse", outcomeRef])).toBe(before);
    if (fault === "unreachable" || fault === "missing-landed") {
      const landed = fault === "unreachable" ? f.head : "1".repeat(40);
      expect(retry.output).toContain(
        `Merge receipt objects: main=${f.base} main_local=true landed=${landed} landed_local=${fault === "unreachable"}`,
      );
    }
  });

  it("preserves successor at intent CAS", () => {
    const f = fixture({ crash: "successor" });
    expectExit(f.run(), 1);
    expect(f.git(["cat-file", "blob", outcomeRef])).toBe("successor");
    expect(f.state().mutations).toBe(0);
  });

  it("shares outcomes across linked checkouts", () => {
    const f = fixture();
    const linked = join(f.root, "contender");
    f.git(["worktree", "add", "-q", "--detach", linked, f.base]);
    configureMerge(f, { mode: "unapplied" });
    expectExit(f.run(), 1);
    f.recover();
    expectExit(f.run(false, linked), 1);
    expect(f.state().mutations).toBe(1);
  });
});

describePosix("repository identity across gh id representations", () => {
  const canonicalRepo = {
    id: "R_kgDOQb6kRw",
    nameWithOwner: "fixture/repo",
    url: "https://github.com/fixture/repo",
  };
  const retainRepository = (f: ReturnType<typeof fixture>, repo: unknown) => {
    const previous = f.git(["rev-parse", outcomeRef]);
    const parents = f.git(["show", "-s", "--format=%P", previous]).split(" ");
    const blob = f.git(["hash-object", "-w", "--stdin"], JSON.stringify({ ...f.record(), repo }));
    const tree = f.git(["mktree"], `100644 blob ${blob}\toutcome.json\n`);
    const historical = f.commit(tree, [...parents, previous], "Historical repository identity\n");
    f.git(["update-ref", outcomeRef, historical, previous]);
    return historical;
  };

  it.each(
    [
      { name: "node", id: "R_kgDOQb6kRw", nextId: 1103012935 },
      { name: "numeric", id: 1103012935, nextId: "R_kgDOQb6kRw" },
    ].flatMap(({ name, id, nextId }) =>
      [false, true].map((completion) => ({ name, id, nextId, completion })),
    ),
  )(
    "retains $name identity across drift (completion=$completion)",
    ({ id, nextId, completion }) => {
      const f = completion ? reconciledMergeAfterCleanup() : fixture();
      if (!completion) {
        configureMerge(f, { mode: "unapplied", repo: { ...f.state().repo, id } });
        expectExit(f.run(), 1);
        f.recover();
      }
      const repo = { ...canonicalRepo, id };
      const previous = retainRepository(f, repo);
      const bytes = f.git(["show", `${previous}:outcome.json`]);
      const attempt = f.record().attempt;
      const captures = completion ? [] : f.captures();
      configureMerge(f, { repo: { ...f.state().repo, id: nextId } });
      if (completion) {
        expectExit(f.complete(previous));
      } else {
        const observed = expectExit(f.run(), 1);
        expect(observed.output).toContain("prior dispatch unresolved");
        expect(f.git(["rev-parse", outcomeRef])).toBe(previous);
        expect(f.captures()).toEqual(captures);
        expect(f.state()).toMatchObject({ mutations: 1, posts: 0 });
        f.recover();
        configureMerge(f, { mode: "success" });
        expectExit(f.run(false, f.repo, "squash", previous));
        expect(f.record()).toMatchObject({
          recovery: { outcome: previous, attempt, actor: "fixture-operator" },
        });
      }
      expect(f.record().phase).toBe("complete");
      expect(f.record().repo).toEqual(repo);
      expect(f.git(["show", `${previous}:outcome.json`])).toBe(bytes);
      f.git(["merge-base", "--is-ancestor", previous, outcomeRef]);
      expect(f.state()).toMatchObject({ mutations: completion ? 1 : 2, posts: 1 });
      expect(existsSync(f.worktree)).toBe(false);
    },
  );

  it.each(
    [
      { name: "unknown node id", repo: { ...canonicalRepo, id: "R_other" } },
      {
        name: "other repository",
        repo: {
          ...canonicalRepo,
          nameWithOwner: "fixture/other",
          url: "https://github.com/fixture/other",
        },
      },
    ].flatMap((fault) =>
      [false, true].map((completion) => ({ name: fault.name, repo: fault.repo, completion })),
    ),
  )("refuses $name (completion=$completion)", ({ repo, completion }) => {
    const f = completion ? reconciledMergeAfterCleanup() : fixture();
    if (!completion) {
      configureMerge(f, { mode: "unapplied" });
      expectExit(f.run(), 1);
      f.recover();
    }
    const previous = retainRepository(f, repo);
    const bytes = f.git(["show", `${previous}:outcome.json`]);
    const captures = completion ? [] : f.captures();
    configureMerge(f, { mode: "success" });

    const result = completion ? f.complete(previous) : f.run(false, f.repo, "squash", previous);
    expect(result.status, result.output).toBe(1);
    expect(f.git(["rev-parse", outcomeRef])).toBe(previous);
    expect(f.git(["show", `${previous}:outcome.json`])).toBe(bytes);
    expect(f.state()).toMatchObject({ mutations: 1, posts: 0 });
    expect(existsSync(f.worktree)).toBe(!completion);
    if (!completion) {
      expect(f.captures()).toEqual(captures);
      expect(f.git(["--git-dir=" + f.remote, "rev-parse", "topic"])).toBe(f.head);
    }
  });

  it.each([
    { name: "fractional numeric id", authority: { id: 1.5 } },
    { name: "numeric node id", authority: { node_id: 1103012935 } },
    { name: "different name", authority: { full_name: "fixture/other" } },
    { name: "different host", authority: { html_url: "https://elsewhere.invalid/fixture/repo" } },
  ])("rejects $name before intent", ({ authority }) => {
    const f = fixture();
    configureMerge(f, { repoAuthority: { ...f.state().repoAuthority, ...authority } });
    expectExit(f.run(), 1);
    expect(f.state()).toMatchObject({ mutations: 0, posts: 0 });
    expect(() => f.record()).toThrow();
    expect(f.captures()).toEqual([]);
    expect(existsSync(f.worktree)).toBe(true);
  });

  it.each([false, true])("requires repo authority (completion=%s)", (completion) => {
    const f = completion ? reconciledMergeAfterCleanup() : fixture();
    const previous = completion ? f.git(["rev-parse", outcomeRef]) : undefined;
    configureMerge(f, { repoAuthorityUnavailable: true });
    const result = previous ? f.complete(previous) : f.run();
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain("repository metadata unavailable");
    expect(f.state()).toMatchObject({ mutations: completion ? 1 : 0, posts: 0 });
    if (previous) {
      expect(f.git(["rev-parse", outcomeRef])).toBe(previous);
    } else {
      expect(() => f.record()).toThrow();
    }
    expect(existsSync(f.worktree)).toBe(!completion);
  });
});
