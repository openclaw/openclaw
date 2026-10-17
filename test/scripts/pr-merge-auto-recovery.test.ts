import { expect, it } from "vitest";
import { createMergeOutcomeFixtureHarness } from "./pr-merge-outcome.test-support.js";

const { fixture, reuseCompletedSetup, outcomeRef, describePosix } =
  createMergeOutcomeFixtureHarness();
type Fixture = ReturnType<typeof fixture>;
type State = ReturnType<Fixture["state"]>;
function update(f: Fixture, changes: Partial<State> = {}, pr: Partial<State["pr"]> = {}) {
  const state = f.state();
  f.save({ ...state, ...changes, pr: { ...state.pr, ...pr } });
}
function expectStatus(result: ReturnType<Fixture["run"]>, status = 0) {
  expect(result.status, result.output).toBe(status);
}
function expectEffects(f: Fixture, mutations: number, cancellations = 0, posts = 0) {
  expect(f.state()).toMatchObject({ mutations, cancellations, posts });
}
const receipt = (f: Fixture) => f.git(["rev-parse", outcomeRef]);
const savedRecord = (f: Fixture, oid: string) => JSON.parse(f.git(["show", `${oid}:outcome.json`]));
const settled = [
  { pr: { mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" } },
  { pr: { mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED" } },
];

function autoFixture(mode = "pending", cancellation = "success") {
  const f = fixture();
  update(f, { mode, cancellation }, { mergeStateStatus: "BLOCKED" });
  return f;
}

const changedAutoHead = reuseCompletedSetup(function (variant: string) {
  const f = fixture();
  const mode =
    variant === "unaccepted" ? "pending-error" : variant === "non-auto" ? "unapplied" : "pending";
  update(f, { mode }, { mergeStateStatus: variant === "non-auto" ? "CLEAN" : "BLOCKED" });
  expectStatus(f.run(variant !== "non-auto"), ["unaccepted", "non-auto"].includes(variant) ? 1 : 0);
  if (variant === "cancelled") {
    expectStatus(f.cancel(receipt(f)));
  }
  const oid = receipt(f);
  const selected = f.commit(f.tree("observed replacement\n"), [f.base]);
  update(f, {}, { headRefOid: selected, autoMergeRequest: null });
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
    const heads: Record<string, string> = {
      unselected: "",
      "wrong selection": f.base,
      "same head": f.head,
      "unavailable commit": "f".repeat(40),
    };
    const explicit = heads[fault] ?? selected;
    const next = f.state();
    const prChanges: Record<string, Partial<typeof next.pr>> = {
      "unavailable commit": { headRefOid: explicit },
      armed: { autoMergeRequest: { mergeMethod: "SQUASH" } },
      queue: { isMergeQueueEnabled: true },
      MERGED: { state: "MERGED", mergeCommit: { oid: f.head } },
    };
    Object.assign(next.pr, prChanges[fault]);
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
    expectStatus(refused, 1);
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
    expectEffects(f, before.mutations, before.cancellations, before.posts);
    expect(savedRecord(f, oid)).toEqual(original);
    if (fault === "CAS collision") {
      expect(f.git(["cat-file", "blob", outcomeRef])).toBe("successor");
    } else {
      expect(receipt(f)).toBe(oid);
    }
  });

  it("refuses observed-head retirement when transport changes the policy evidence", () => {
    const { f, oid, selected } = changedAutoHead("");
    update(
      f,
      {
        restPolicy: "ruleset",
        quotaAt: "observe",
        quotaAfterObservations: f.state().observationReads + 1,
      },
      { mergeStateStatus: "CLEAN" },
    );
    const refused = f.cancel(oid, selected);
    expect(f.state().quotaTriggered).toBe(true);
    expect(f.state().restMainReads).toBeGreaterThan(0);
    expectStatus(refused, 1);
    expect(refused.output).toContain(
      "observed-head retirement requires stable transport, policy, and PR/main facts",
    );
    expect(receipt(f)).toBe(oid);
    expectEffects(f, 1);
  });

  it("loads an observed-head retirement after the original head is restored and merged", () => {
    const { f, oid, selected } = changedAutoHead("");
    expectStatus(f.cancel(oid, selected));
    const landedTree = f.git(["rev-parse", `${f.head}^{tree}`]);
    const landed = f.commit(landedTree, [f.base], "Landed original head\n");
    f.git(["push", "-q", "origin", `${landed}:refs/heads/main`]);
    update(f, {}, { state: "MERGED", headRefOid: f.head, mergeCommit: { oid: landed } });
    expectStatus(f.run());
    expect(f.record()).toMatchObject({
      phase: "merged",
      landed,
      cancellation: { observedHead: selected },
    });
    expectStatus(f.run());
    expectEffects(f, 1);
  });

  it("retires an absent request at an explicitly observed changed head without dispatch", () => {
    const f = autoFixture();
    expect(f.run(true).status).toBe(0);
    const accepted = receipt(f);
    const original = f.record();
    const captures = f.captures();
    // A collaborator can rewrite the head; retirement does not require ancestry.
    const selected = f.commit(f.tree("collaborator replacement\n"), [f.base]);
    update(f, { observations: settled }, { headRefOid: selected, autoMergeRequest: null });
    expectStatus(f.cancel(accepted, selected));
    const retired = receipt(f);
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
    expectEffects(f, 1);
    for (const [name, contents] of captures) {
      expect(f.git(["show", `${retired}:${name}`])).toBe(contents.trim());
    }
    expect(f.cancel(accepted, selected).status).toBe(1);
    expect(receipt(f)).toBe(retired);
    f.git(["reflog", "expire", "--expire=now", "--all"]);
    f.git(["gc", "--prune=now"]);
    expect(f.git(["cat-file", "-t", selected])).toBe("commit");
    expectStatus(f.run(false, f.repo, "squash", retired, selected), 1);
    expect(receipt(f)).toBe(retired);
    const replacement = f.replacePreparedHead();
    update(f, { mode: "success" }, { mergeStateStatus: "CLEAN" });
    expectStatus(f.run(false, f.repo, "squash", retired, replacement));
    expect(f.record()).toMatchObject({ phase: "complete", head: replacement });
    expectEffects(f, 2, 0, 1);
  });
  it.each(["before cancellation", "after cancellation"])(
    "retires the original auto request when mergeability settles %s",
    (phase) => {
      const f = autoFixture();
      expect(f.run(true).status).toBe(0);
      const accepted = receipt(f);
      update(f, {
        observations: [...(phase === "after cancellation" ? [{}, {}] : []), ...settled],
      });
      expectStatus(f.cancel(accepted));
      expectEffects(f, 1, 1);
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
      const f = autoFixture(mode, cancellation);
      const acknowledged = mode === "pending";
      expectStatus(f.run(true), acknowledged ? 0 : 1);
      const attempt = receipt(f);
      const attemptRecord = f.record();
      const captures = f.captures();
      if (!acknowledged) {
        // The failed request drained, so the supervisor already released its lock.
        expect(f.recover()).toBe(false);
      }
      if (absent) {
        update(f, {}, { autoMergeRequest: null });
      }
      expectStatus(f.cancel(attempt));
      expect(f.state().pr.autoMergeRequest).toBeNull();
      expectEffects(f, 1, absent ? 0 : 1);
      expect(f.record()).toMatchObject({
        accepted: acknowledged,
        route: "auto",
        cancellation: { state: "confirmed", outcome: attempt, actor: "fixture-operator" },
      });
      const retired = receipt(f);
      const retiredRecord = f.record();
      expect(retiredRecord).not.toHaveProperty("transport");
      const retirement = f
        .git(["rev-list", "--ancestry-path", "--reverse", `${attempt}..${retired}`])
        .split("\n")[0]!;
      const replacement = f.replacePreparedHead();
      update(
        f,
        {
          mode: "success",
          pooledMergeBlocked: true,
          quotaAt: "observe",
          quotaFailuresRemaining: 0,
        },
        { mergeStateStatus: "CLEAN" },
      );
      expectStatus(f.run(false, f.repo, "squash", retired, replacement));
      expectEffects(f, 2, absent ? 0 : 1, 1);
      expect(f.record()).toMatchObject({
        phase: "complete",
        head: replacement,
        recovery: { outcome: retired, replacementHead: replacement },
      });
      expect(f.record()).not.toHaveProperty("transport");
      expect(savedRecord(f, attempt)).toEqual(attemptRecord);
      expect(savedRecord(f, retired)).toEqual(retiredRecord);
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
    const f = autoFixture("pending-error", "rejected");
    expect(f.run(true).status).toBe(1);
    expect(f.recover()).toBe(false);
    expectStatus(f.cancel(receipt(f)), 1);
    expect(f.record().cancellation.state).toBe("requested");
    f.recover();
    const requested = receipt(f);
    expectStatus(f.cancel(requested), 1);
    expect(f.state().cancellations).toBe(1);
    f.recover();
    update(f, {}, { autoMergeRequest: null });
    expectStatus(f.cancel(requested));
    expect(f.state()).toMatchObject({ cancellations: 1, mutations: 1 });
    expect(f.record()).toMatchObject({ accepted: false, cancellation: { state: "confirmed" } });
  });
  it("reconciles a concurrent merge during auto cancellation without a second merge", () => {
    const f = autoFixture("pending", "merged");
    expect(f.run(true).status).toBe(0);
    expectStatus(f.cancel(receipt(f)));
    expect(f.record()).toMatchObject({ phase: "merged", landed: f.state().pr.mergeCommit?.oid });
    expectEffects(f, 1, 1);
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
      const f = autoFixture();
      expect(f.run(true).status).toBe(0);
      const accepted = receipt(f);
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
      expectStatus(f.cancel(accepted), 1);
      expect(f.state()).toMatchObject({ cancellations: stage === "before" ? 0 : 1, mutations: 1 });
      if (stage === "before") {
        expect(receipt(f)).toBe(accepted);
      } else {
        expect(f.record().cancellation.state).toBe("requested");
      }
    },
  );
});
