import { expect, it } from "vitest";
import { createMergeOutcomeFixtureHarness } from "./pr-merge-outcome.test-support.js";

const { fixture, outcomeRef, describePosix } = createMergeOutcomeFixtureHarness();

describePosix("native accepted auto-merge recovery", () => {
  it.each(["success", "lost"])(
    "cancels accepted auto with %s response before recovering a reviewed replacement",
    (cancellation) => {
      const f = fixture();
      f.save({
        ...f.state(),
        mode: "pending",
        cancellation,
        pr: { ...f.state().pr, mergeStateStatus: "BLOCKED" },
      });
      const pending = f.run(true);
      expect(pending.status, pending.output).toBe(0);
      const accepted = f.git(["rev-parse", outcomeRef]);
      const captures = f.captures();
      const cancelled = f.cancel(accepted);
      expect(cancelled.status, cancelled.output).toBe(0);
      expect(f.state().pr.autoMergeRequest).toBeNull();
      expect(f.record()).toMatchObject({
        accepted: true,
        route: "auto",
        cancellation: { state: "confirmed", outcome: accepted, actor: "fixture-operator" },
      });
      const retired = f.git(["rev-parse", outcomeRef]);
      const retiredRecord = f.record();
      expect(retiredRecord).not.toHaveProperty("transport");
      const requested = f.git(["rev-list", "--parents", "-n", "1", retired]).split(" ").at(-1)!;
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
      expect(f.state()).toMatchObject({ mutations: 2, cancellations: 1, posts: 1 });
      expect(f.record()).toMatchObject({
        phase: "complete",
        head: replacement,
        recovery: { outcome: retired, replacementHead: replacement },
      });
      expect(f.record()).not.toHaveProperty("transport");
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
      expect(f.git(["merge-base", "--is-ancestor", accepted, outcomeRef])).toBe("");
      for (const [name, contents] of captures) {
        expect(f.git(["show", `${requested}:${name}`])).toBe(contents.trim());
      }
    },
  );
  it("never repeats an uncertain auto cancellation and confirms its later observed retirement", () => {
    const f = fixture();
    f.save({
      ...f.state(),
      mode: "pending",
      cancellation: "rejected",
      pr: { ...f.state().pr, mergeStateStatus: "BLOCKED" },
    });
    expect(f.run(true).status).toBe(0);
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
    expect(f.record().cancellation.state).toBe("confirmed");
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
  it.each(["head", "queue", "reread"])(
    "preserves uncertain auto cancellation when %s changes during dispatch",
    (change) => {
      const f = fixture();
      f.save({
        ...f.state(),
        mode: "pending",
        pr: { ...f.state().pr, mergeStateStatus: "BLOCKED" },
      });
      expect(f.run(true).status).toBe(0);
      const changed = change === "queue" ? { isInMergeQueue: true } : { headRefOid: f.base };
      f.save({
        ...f.state(),
        observations: [{}, {}, ...(change === "reread" ? [{}] : []), { pr: changed }],
      });
      const result = f.cancel(f.git(["rev-parse", outcomeRef]));
      expect(result.status, result.output).toBe(1);
      expect(f.state()).toMatchObject({ cancellations: 1, mutations: 1 });
      expect(f.record().cancellation.state).toBe("requested");
    },
  );
  it.each(["head", "queue", "method", "absent"])(
    "refuses auto cancellation when %s no longer matches the retained request",
    (change) => {
      const f = fixture();
      f.save({
        ...f.state(),
        mode: "pending",
        pr: { ...f.state().pr, mergeStateStatus: "BLOCKED" },
      });
      expect(f.run(true).status).toBe(0);
      const accepted = f.git(["rev-parse", outcomeRef]);
      const next = f.state();
      if (change === "head") {
        next.pr.headRefOid = f.base;
      }
      if (change === "queue") {
        next.pr.isMergeQueueEnabled = true;
      }
      if (change === "method") {
        next.pr.autoMergeRequest = { mergeMethod: "MERGE" };
      }
      if (change === "absent") {
        next.pr.autoMergeRequest = null;
      }
      f.save(next);
      const result = f.cancel(accepted);
      expect(result.status, result.output).toBe(1);
      expect(f.state()).toMatchObject({ cancellations: 0, mutations: 1 });
      expect(f.git(["rev-parse", outcomeRef])).toBe(accepted);
    },
  );
});
