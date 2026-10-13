import { expect, it } from "vitest";
import { createMergeOutcomeFixtureHarness } from "./pr-merge-outcome.test-support.js";

const { fixture, reuseCompletedSetup, outcomeRef, describePosix } =
  createMergeOutcomeFixtureHarness();

const changedAutoHead = reuseCompletedSetup(function (variant: string) {
  const f = fixture();
  f.save({
    ...f.state(),
    mode:
      variant === "unaccepted" ? "pending-error" : variant === "non-auto" ? "unapplied" : "pending",
    pr: { ...f.state().pr, mergeStateStatus: variant === "non-auto" ? "CLEAN" : "BLOCKED" },
  });
  const result = f.run(variant !== "non-auto");
  expect(result.status, result.output).toBe(["unaccepted", "non-auto"].includes(variant) ? 1 : 0);
  if (variant === "cancelled") {
    const cancelled = f.cancel(f.git(["rev-parse", outcomeRef]));
    expect(cancelled.status, cancelled.output).toBe(0);
  }
  const oid = f.git(["rev-parse", outcomeRef]);
  const selected = f.commit(f.tree("observed replacement\n"), [f.base]);
  f.save({ ...f.state(), pr: { ...f.state().pr, headRefOid: selected, autoMergeRequest: null } });
  return { f, oid, selected };
});

describePosix("native auto-merge recovery", () => {
  it.each([
    "unselected",
    "wrong selection",
    "same head",
    "unavailable commit",
    "armed",
    "queue",
    "MERGED",
    "unaccepted",
    "non-auto",
    "cancelled",
    "reread MERGED",
    "reread head",
    "reread main",
    "reread base",
    "reread policy",
    "reread request",
    "reread queue",
    "CAS collision",
  ])("preserves the original receipt on observed-head refusal: %s", (fault) => {
    const { f, oid, selected } = changedAutoHead(
      ["unaccepted", "non-auto", "cancelled"].includes(fault) ? fault : "",
    );
    const original = f.record();
    const before = f.state();
    let explicit = selected;
    const next = f.state();
    if (fault === "unselected") {
      explicit = "";
    }
    if (fault === "wrong selection") {
      explicit = f.base;
    }
    if (fault === "same head") {
      explicit = f.head;
    }
    if (fault === "unavailable commit") {
      next.pr.headRefOid = explicit = "f".repeat(40);
    }
    if (fault === "armed") {
      next.pr.autoMergeRequest = { mergeMethod: "SQUASH" };
    }
    if (fault === "queue") {
      next.pr.isMergeQueueEnabled = true;
    }
    if (fault === "MERGED") {
      next.pr.state = "MERGED";
      next.pr.mergeCommit = { oid: f.head };
    }
    if (fault === "CAS collision") {
      next.crash = "successor";
    }
    const drifts: Record<string, (typeof next.observations)[number]> = {
      "reread MERGED": { pr: { state: "MERGED", mergeCommit: { oid: f.head } } },
      "reread head": { pr: { headRefOid: f.base } },
      "reread main": { advanceMain: true },
      "reread base": { pr: { baseRefName: "release" } },
      "reread policy": { pr: { isDraft: true } },
      "reread request": { pr: { autoMergeRequest: { mergeMethod: "SQUASH" } } },
      "reread queue": { pr: { isInMergeQueue: true } },
    };
    const drift = drifts[fault];
    if (drift) {
      next.observations = [{}, drift];
    }
    f.save(next);
    const refused = f.cancel(oid, explicit);
    expect(refused.status, refused.output).toBe(1);
    const expectedGuard = fault.startsWith("reread ")
      ? "observed-head retirement requires stable transport, policy, and PR/main facts"
      : fault === "CAS collision"
        ? "outcome owner changed"
        : fault === "non-auto"
          ? "exact retained auto intent"
          : fault === "unselected"
            ? "original open PR/head/base"
            : ["same head", "unavailable commit", "unaccepted", "cancelled"].includes(fault)
              ? "accepted uncancelled auto intent"
              : "selected open PR/head/base";
    expect(refused.output).toContain(expectedGuard);
    expect(f.state()).toMatchObject({
      mutations: before.mutations,
      cancellations: before.cancellations,
      posts: before.posts,
    });
    expect(JSON.parse(f.git(["show", `${oid}:outcome.json`]))).toEqual(original);
    if (fault === "CAS collision") {
      expect(f.git(["cat-file", "blob", outcomeRef])).toBe("successor");
    } else {
      expect(f.git(["rev-parse", outcomeRef])).toBe(oid);
    }
  });

  it("refuses observed-head retirement when transport changes the policy evidence", () => {
    const { f, oid, selected } = changedAutoHead("");
    f.save({
      ...f.state(),
      restPolicy: "ruleset",
      quotaAt: "observe",
      quotaAfterObservations: f.state().observationReads + 1,
      pr: { ...f.state().pr, mergeStateStatus: "CLEAN" },
    });
    const refused = f.cancel(oid, selected);
    expect(f.state().quotaTriggered).toBe(true);
    expect(f.state().restMainReads).toBeGreaterThan(0);
    expect(refused.status, refused.output).toBe(1);
    expect(refused.output).toContain(
      "observed-head retirement requires stable transport, policy, and PR/main facts",
    );
    expect(f.git(["rev-parse", outcomeRef])).toBe(oid);
    expect(f.state()).toMatchObject({ mutations: 1, cancellations: 0, posts: 0 });
  });

  it("loads an observed-head retirement after the original head is restored and merged", () => {
    const { f, oid, selected } = changedAutoHead("");
    const cancelled = f.cancel(oid, selected);
    expect(cancelled.status, cancelled.output).toBe(0);
    const landed = f.commit(
      f.git(["rev-parse", `${f.head}^{tree}`]),
      [f.base],
      "Landed original head\n",
    );
    f.git(["push", "-q", "origin", `${landed}:refs/heads/main`]);
    f.save({
      ...f.state(),
      pr: { ...f.state().pr, state: "MERGED", headRefOid: f.head, mergeCommit: { oid: landed } },
    });
    const reconciled = f.run();
    expect(reconciled.status, reconciled.output).toBe(0);
    expect(f.record()).toMatchObject({
      phase: "merged",
      landed,
      cancellation: { observedHead: selected },
    });
    const reloaded = f.run();
    expect(reloaded.status, reloaded.output).toBe(0);
    expect(f.state()).toMatchObject({ mutations: 1, cancellations: 0, posts: 0 });
  });

  it("retires an absent request at an explicitly observed changed head without dispatch", () => {
    const f = fixture();
    f.save({ ...f.state(), mode: "pending", pr: { ...f.state().pr, mergeStateStatus: "BLOCKED" } });
    expect(f.run(true).status).toBe(0);
    const accepted = f.git(["rev-parse", outcomeRef]);
    const original = f.record();
    const captures = f.captures();
    // A collaborator can rewrite the head; retirement does not require ancestry.
    const selected = f.commit(f.tree("collaborator replacement\n"), [f.base]);
    f.save({
      ...f.state(),
      pr: { ...f.state().pr, headRefOid: selected, autoMergeRequest: null },
      observations: [
        { pr: { mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" } },
        { pr: { mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED" } },
      ],
    });
    const result = f.cancel(accepted, selected);
    expect(result.status, result.output).toBe(0);
    const retired = f.git(["rev-parse", outcomeRef]);
    expect(f.record()).toEqual({
      ...original,
      cancellation: {
        actor: "fixture-operator",
        outcome: accepted,
        state: "confirmed",
        observedHead: selected,
      },
    });
    expect(f.git(["rev-list", "--count", "--ancestry-path", `${accepted}..${retired}`])).toBe("1");
    expect(f.git(["show", "-s", "--format=%P", retired]).split(" ")).toContain(selected);
    expect(f.state()).toMatchObject({ mutations: 1, cancellations: 0, posts: 0 });
    for (const [name, contents] of captures) {
      expect(f.git(["show", `${retired}:${name}`])).toBe(contents.trim());
    }
    expect(f.cancel(accepted, selected).status).toBe(1);
    expect(f.git(["rev-parse", outcomeRef])).toBe(retired);
    f.git(["reflog", "expire", "--expire=now", "--all"]);
    f.git(["gc", "--prune=now"]);
    expect(f.git(["cat-file", "-t", selected])).toBe("commit");
    const stale = f.run(false, f.repo, "squash", retired, selected);
    expect(stale.status, stale.output).toBe(1);
    expect(f.git(["rev-parse", outcomeRef])).toBe(retired);
    const replacement = f.replacePreparedHead();
    f.save({ ...f.state(), mode: "success", pr: { ...f.state().pr, mergeStateStatus: "CLEAN" } });
    const recovered = f.run(false, f.repo, "squash", retired, replacement);
    expect(recovered.status, recovered.output).toBe(0);
    expect(f.record()).toMatchObject({ phase: "complete", head: replacement });
    expect(f.state()).toMatchObject({ mutations: 2, cancellations: 0, posts: 1 });
  });
  it.each(["before cancellation", "after cancellation"])(
    "retires the original auto request when mergeability settles %s",
    (phase) => {
      const f = fixture();
      f.save({
        ...f.state(),
        mode: "pending",
        pr: { ...f.state().pr, mergeStateStatus: "BLOCKED" },
      });
      expect(f.run(true).status).toBe(0);
      const accepted = f.git(["rev-parse", outcomeRef]);
      f.save({
        ...f.state(),
        observations: [
          ...(phase === "after cancellation" ? [{}, {}] : []),
          { pr: { mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" } },
          { pr: { mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED" } },
        ],
      });
      const result = f.cancel(accepted);
      expect(result.status, result.output).toBe(0);
      expect(f.state()).toMatchObject({ cancellations: 1, mutations: 1, posts: 0 });
      expect(f.record()).toMatchObject({
        phase: "intent",
        accepted: true,
        head: f.head,
        route: "auto",
        cancellation: { state: "confirmed", outcome: accepted },
      });
      expect(f.state().pr.autoMergeRequest).toBeNull();
    },
  );
  it.each([
    { mode: "pending", cancellation: "success", absent: false },
    { mode: "pending", cancellation: "lost", absent: false },
    { mode: "pending-error", cancellation: "success", absent: false },
    { mode: "pending", cancellation: "success", absent: true },
  ])(
    "retires auto before recovering a reviewed replacement (submission=$mode, cancellation=$cancellation, absent=$absent)",
    ({ mode, cancellation, absent }) => {
      const f = fixture();
      f.save({
        ...f.state(),
        mode,
        cancellation,
        pr: { ...f.state().pr, mergeStateStatus: "BLOCKED" },
      });
      const pending = f.run(true);
      const acknowledged = mode === "pending";
      expect(pending.status, pending.output).toBe(acknowledged ? 0 : 1);
      const attempt = f.git(["rev-parse", outcomeRef]);
      const attemptRecord = f.record();
      const captures = f.captures();
      if (!acknowledged) {
        // The failed request drained, so the supervisor already released its lock.
        expect(f.recover()).toBe(false);
      }
      if (absent) {
        f.save({ ...f.state(), pr: { ...f.state().pr, autoMergeRequest: null } });
      }
      const cancelled = f.cancel(attempt);
      expect(cancelled.status, cancelled.output).toBe(0);
      expect(f.state().pr.autoMergeRequest).toBeNull();
      expect(f.state()).toMatchObject({
        mutations: 1,
        cancellations: absent ? 0 : 1,
        posts: 0,
      });
      expect(f.record()).toMatchObject({
        accepted: acknowledged,
        route: "auto",
        cancellation: { state: "confirmed", outcome: attempt, actor: "fixture-operator" },
      });
      const retired = f.git(["rev-parse", outcomeRef]);
      const retiredRecord = f.record();
      expect(retiredRecord).not.toHaveProperty("transport");
      const retirement = f
        .git(["rev-list", "--ancestry-path", "--reverse", `${attempt}..${retired}`])
        .split("\n")[0]!;
      const replacement = f.replacePreparedHead();
      f.save({
        ...f.state(),
        mode: "success",
        pooledMergeBlocked: true,
        quotaAt: "observe",
        quotaFailuresRemaining: 0,
        pr: { ...f.state().pr, mergeStateStatus: "CLEAN" },
      });
      const recovered = f.run(false, f.repo, "squash", retired, replacement);
      expect(recovered.status, recovered.output).toBe(0);
      expect(f.state()).toMatchObject({ mutations: 2, cancellations: absent ? 0 : 1, posts: 1 });
      expect(f.record()).toMatchObject({
        phase: "complete",
        head: replacement,
        recovery: { outcome: retired, replacementHead: replacement },
      });
      expect(f.record()).not.toHaveProperty("transport");
      expect(JSON.parse(f.git(["show", `${attempt}:outcome.json`]))).toEqual(attemptRecord);
      expect(JSON.parse(f.git(["show", `${retired}:outcome.json`]))).toEqual(retiredRecord);
      expect(f.state().restMergePayload).toBeNull();
      expect(f.state().graphqlMergePayloads).toEqual([
        {
          pullRequestId: "fixture-pr",
          expectedHeadOid: replacement,
          mergeMethod: "SQUASH",
          commitBody: f.state().mergeBody,
        },
      ]);
      expect(f.state().mergeBody).toContain(f.state().previewBody);
      expect(f.git(["merge-base", "--is-ancestor", attempt, outcomeRef])).toBe("");
      for (const [name, contents] of captures) {
        expect(f.git(["show", `${retirement}:${name}`])).toBe(contents.trim());
      }
    },
  );
  it("never repeats an uncertain auto cancellation and confirms its later observed retirement", () => {
    const f = fixture();
    f.save({
      ...f.state(),
      mode: "pending-error",
      cancellation: "rejected",
      pr: { ...f.state().pr, mergeStateStatus: "BLOCKED" },
    });
    expect(f.run(true).status).toBe(1);
    expect(f.recover()).toBe(false);
    const first = f.cancel(f.git(["rev-parse", outcomeRef]));
    expect(first.status, first.output).toBe(1);
    expect(f.record().cancellation.state).toBe("requested");
    f.recover();
    const requested = f.git(["rev-parse", outcomeRef]);
    const retry = f.cancel(requested);
    expect(retry.status, retry.output).toBe(1);
    expect(f.state().cancellations).toBe(1);
    f.recover();
    f.save({ ...f.state(), pr: { ...f.state().pr, autoMergeRequest: null } });
    const confirmed = f.cancel(requested);
    expect(confirmed.status, confirmed.output).toBe(0);
    expect(f.state()).toMatchObject({ cancellations: 1, mutations: 1 });
    expect(f.record()).toMatchObject({ accepted: false, cancellation: { state: "confirmed" } });
  });
  it("reconciles a concurrent merge during auto cancellation without a second merge", () => {
    const f = fixture();
    f.save({
      ...f.state(),
      mode: "pending",
      cancellation: "merged",
      pr: { ...f.state().pr, mergeStateStatus: "BLOCKED" },
    });
    expect(f.run(true).status).toBe(0);
    const result = f.cancel(f.git(["rev-parse", outcomeRef]));
    expect(result.status, result.output).toBe(0);
    expect(f.record()).toMatchObject({ phase: "merged", landed: f.state().pr.mergeCommit?.oid });
    expect(f.state()).toMatchObject({ cancellations: 1, mutations: 1, posts: 0 });
  });
  it.each([
    ["head", "during"],
    ["queue", "during"],
    ["head", "reread"],
    ["head", "before"],
    ["queue", "before"],
    ["method", "before"],
  ] as const)(
    "preserves auto cancellation authority when %s changes %s dispatch",
    (change, stage) => {
      const f = fixture();
      f.save({
        ...f.state(),
        mode: "pending",
        pr: { ...f.state().pr, mergeStateStatus: "BLOCKED" },
      });
      expect(f.run(true).status).toBe(0);
      const accepted = f.git(["rev-parse", outcomeRef]);
      const next = f.state();
      if (stage === "before") {
        if (change === "head") {
          next.pr.headRefOid = f.base;
        } else if (change === "queue") {
          next.pr.isMergeQueueEnabled = true;
        } else {
          next.pr.autoMergeRequest = { mergeMethod: "MERGE" };
        }
      } else {
        const changed = change === "queue" ? { isInMergeQueue: true } : { headRefOid: f.base };
        next.observations = [{}, {}, ...(stage === "reread" ? [{}] : []), { pr: changed }];
      }
      f.save(next);
      const result = f.cancel(accepted);
      expect(result.status, result.output).toBe(1);
      expect(f.state()).toMatchObject({ cancellations: stage === "before" ? 0 : 1, mutations: 1 });
      if (stage === "before") {
        expect(f.git(["rev-parse", outcomeRef])).toBe(accepted);
      } else {
        expect(f.record().cancellation.state).toBe("requested");
      }
    },
  );
});
