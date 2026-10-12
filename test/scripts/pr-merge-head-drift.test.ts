import { expect, it } from "vitest";
import { createMergeOutcomeFixtureHarness } from "./pr-merge-outcome.test-support.js";

const { fixture, outcomeRef, describePosix } = createMergeOutcomeFixtureHarness();

function mergedAfterPush(variant = "") {
  const f = fixture();
  f.save({
    ...f.state(),
    mode:
      variant === "unaccepted"
        ? "pending-error"
        : variant === "immediate"
          ? "unapplied"
          : "pending",
    pr: { ...f.state().pr, mergeStateStatus: variant === "immediate" ? "CLEAN" : "BEHIND" },
  });
  const first = f.run(variant !== "immediate");
  expect(first.status, first.output).toBe(["unaccepted", "immediate"].includes(variant) ? 1 : 0);
  if (!["unaccepted", "immediate"].includes(variant)) {
    expect(first.output).toContain("AUTO/QUEUE PENDING");
    expect(f.record()).toMatchObject({
      phase: "intent",
      route: "auto",
      accepted: true,
      head: f.head,
    });
  } else {
    expect(f.record()).toMatchObject({
      phase: "intent",
      route: variant === "immediate" ? "immediate" : "auto",
      accepted: false,
    });
    f.recover();
  }
  let oid = f.git(["rev-parse", outcomeRef]);
  if (variant === "cancelled") {
    const cancelled = f.cancel(oid);
    expect(cancelled.status, cancelled.output).toBe(0);
    expect(f.record().cancellation.state).toBe("confirmed");
    expect(f.state().cancellations).toBe(1);
    oid = f.git(["rev-parse", outcomeRef]);
  }
  const main1 = f.advance("before\n", "main-advanced\n");
  const pushed = f.commit(
    f.tree("after\n", "main-advanced\n"),
    variant === "non-descendant" ? [main1] : [f.head, main1],
    variant === "non-descendant" ? "Rebased\n" : "Merge main\n",
  );
  f.git([
    "push",
    "-q",
    "--force",
    "origin",
    `${pushed}:refs/heads/topic`,
    `${pushed}:refs/pull/123/head`,
  ]);
  const landed = f.commit(
    variant === "tree"
      ? f.tree("partial\n", "main-advanced\n")
      : f.git(["merge-tree", "--write-tree", main1, pushed]),
    variant === "method" ? [main1, pushed] : [main1],
    "Landed squash\n",
  );
  if (variant !== "not-on-main") {
    f.git(["push", "-q", "origin", `${landed}:refs/heads/main`]);
  }
  f.save({
    ...f.state(),
    pr: {
      ...f.state().pr,
      state: "MERGED",
      headRefOid: pushed,
      mergeCommit: { oid: landed },
      autoMergeRequest: null,
      isInMergeQueue: false,
    },
  });
  return { f, oid, pushed, landed };
}

describePosix("native merged head-drift receipt", () => {
  it("records the pushed head without dispatch and completes after source cleanup and GC", () => {
    const { f, oid, pushed, landed } = mergedAfterPush();
    const original = f.git(["show", `${oid}:outcome.json`]);
    const reconcile = f.run(true);
    expect(reconcile.status, reconcile.output).toBe(1);
    expect(reconcile.output).toContain("PR identity/head/base drift from the retained attempt");
    expect(reconcile.output).toContain(
      `scripts/pr merge-recover 123 ${oid} --confirmed-operator-recovery --merged-head ${pushed}`,
    );
    expect(f.git(["rev-parse", outcomeRef])).toBe(oid);
    expect(f.state()).toMatchObject({ mutations: 1, posts: 0 });
    const cancel = f.cancel(oid);
    expect(cancel.status, cancel.output).toBe(1);
    expect(f.git(["rev-parse", outcomeRef])).toBe(oid);
    expect(f.state().cancellations).toBe(0);
    const incomplete = f.complete(oid);
    expect(incomplete.status, incomplete.output).toBe(1);
    expect(incomplete.output).toContain("completion requires the exact verified merge receipt");

    const accepted = f.acceptHeadDrift(oid, pushed);
    expect(accepted.status, accepted.output).toBe(0);
    expect(accepted.output).toContain(`MERGED pushed head ${pushed}`);
    expect(f.record()).toMatchObject({
      phase: "merged",
      landed,
      head: f.head,
      route: "auto",
      accepted: true,
      headDrift: { actor: "fixture-operator", mergedHead: pushed, outcome: oid },
    });
    const receipt = f.git(["rev-parse", outcomeRef]);
    f.git(["merge-base", "--is-ancestor", oid, receipt]);
    expect(f.git(["show", `${oid}:outcome.json`])).toBe(original);
    expect(f.git(["show", "-s", "--format=%P", receipt]).split(" ")).toContain(pushed);
    expect(f.state()).toMatchObject({ mutations: 1, posts: 0, cancellations: 0 });
    const stale = f.acceptHeadDrift(oid, pushed);
    expect(stale.status, stale.output).toBe(1);
    expect(f.git(["rev-parse", outcomeRef])).toBe(receipt);
    const resumed = f.run();
    expect(resumed.status, resumed.output).toBe(0);
    expect(resumed.output).toContain("Merge confirmed; completion pending");
    expect(f.state().mutations).toBe(1);

    f.git(["worktree", "remove", "--force", f.worktree]);
    f.git(["branch", "-D", "pr-123-prep", "pr-123", "topic"]);
    f.git(["update-ref", "-d", "refs/remotes/origin/topic"]);
    f.git(["push", "-q", "origin", ":refs/heads/topic"]);
    f.git(["reflog", "expire", "--expire=now", "--all"]);
    f.git(["gc", "--prune=now"]);
    f.git(["cat-file", "-e", `${pushed}^{commit}`]);
    const done = f.complete(f.git(["rev-parse", outcomeRef]));
    expect(done.status, done.output).toBe(0);
    expect(f.record().phase).toBe("complete");
    expect(f.state()).toMatchObject({ posts: 1, mutations: 1 });
    const body = f.state().comments[0]!.body;
    for (const text of [
      "Merged via squash auto-merge.",
      `/commit/${landed}`,
      `/commits/${pushed}`,
      `/commits/${f.head}`,
      "pushed after the auto-merge request",
    ]) {
      expect(body).toContain(text);
    }
  });

  it.each([
    [
      "stale-oid",
      "head-drift receipt requires the exact current retained accepted non-queue auto intent",
    ],
    ["same-head", "selected merged head equals the retained auto head"],
    ["unselected-head", "explicitly selected merged head"],
    ["identity", "explicitly selected merged head"],
    ["base", "explicitly selected merged head"],
    ["open", "explicitly selected merged head"],
    ["non-descendant", "does not strictly descend from the retained auto head"],
    ["method", "landed commit shape does not match the retained squash method"],
    ["tree", "landed tree does not match the prepared source"],
    ["not-on-main", "not reachable from authoritative main"],
    ["cancelled", "without a cancellation record"],
    [
      "unaccepted",
      "head-drift receipt requires the exact current retained accepted non-queue auto intent",
    ],
    [
      "immediate",
      "head-drift receipt requires the exact current retained accepted non-queue auto intent",
    ],
  ])("refuses %s without changing the retained intent or remote state", (variant, refusal) => {
    const { f, oid, pushed } = mergedAfterPush(variant);
    if (variant === "identity") {
      f.save({ ...f.state(), pr: { ...f.state().pr, id: "other-pr" } });
    }
    if (variant === "base") {
      f.save({ ...f.state(), pr: { ...f.state().pr, baseRefName: "release" } });
    }
    if (variant === "open") {
      f.save({ ...f.state(), pr: { ...f.state().pr, state: "OPEN", mergeCommit: null } });
    }
    const before = f.state();
    const result = f.acceptHeadDrift(
      variant === "stale-oid" ? f.base : oid,
      variant === "same-head" ? f.head : variant === "unselected-head" ? f.base : pushed,
    );
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain(refusal);
    expect(f.git(["rev-parse", outcomeRef])).toBe(oid);
    expect(f.record().phase).toBe("intent");
    expect(f.state()).toMatchObject({
      mutations: before.mutations,
      posts: 0,
      cancellations: before.cancellations,
    });
  });
});
