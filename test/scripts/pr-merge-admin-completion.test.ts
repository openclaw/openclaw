import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createMergeOutcomeFixtureHarness } from "./pr-merge-outcome.test-support.js";
import { createPriorCiCandidateFactory } from "./pr-merge-prior-ci.test-support.js";

const { fixture, outcomeRef, describePosix } = createMergeOutcomeFixtureHarness();
const { preExistingCandidate } = createPriorCiCandidateFactory(fixture);

function missingAdminAudit(drift = false) {
  const f = preExistingCandidate();
  f.save({ ...f.state(), audit: true, mode: drift ? "advance-at-dispatch" : "success" });
  const dispatched = f.adminPriorCi(f.path);
  expect(dispatched.status, dispatched.output).toBe(1);
  expect(dispatched.output).toContain("audit unavailable");
  expect(f.record()).toMatchObject({ phase: "merged", route: "admin", accepted: true });
  expect(f.state()).toMatchObject({ mutations: 1, posts: 0 });
  expect(existsSync(join(f.worktree, ".local/merge-crabbox-parent-audit.json"))).toBe(false);
  // The drained failure already released the process lock.
  expect(f.recover()).toBe(false);
  f.save({ ...f.state(), audit: false });
  return f;
}

function removeOwnedFixtureCheckout(f: ReturnType<typeof missingAdminAudit>) {
  f.git(["worktree", "remove", "--force", f.worktree]);
  f.git(["branch", "-D", "pr-123-prep", "pr-123", "topic"]);
  f.git(["push", "-q", "origin", ":refs/heads/topic"]);
}

describePosix("delayed prior-CI admin completion", () => {
  it.each([false, true])(
    "reconstructs the historical audit without redispatching (parent drift=%s)",
    (drift) => {
      const f = missingAdminAudit(drift);
      const receipt = f.git(["rev-parse", outcomeRef]);
      const original = f.record();
      removeOwnedFixtureCheckout(f);
      const completed = f.complete(receipt);
      expect(completed.status, completed.output).toBe(0);
      expect(f.record()).toMatchObject({ phase: "complete", priorCiAdmin: original.priorCiAdmin });
      expect(f.state()).toMatchObject({ mutations: 1, posts: 1 });
      expect(f.state().comments[0]?.body).toContain(
        `Reconstructed after merge landing-parent audit: ${drift ? "drift" : "match"}`,
      );
      expect(f.state().comments[0]?.body).toContain(f.git(["rev-parse", `${original.landed}^1`]));
      expect(f.state().comments[0]?.body).toContain("No original at-landing audit is claimed");
      expect(f.state().comments[0]?.body).toContain(original.main);
      expect(f.state().comments[0]?.body).toContain("No current-head CI success is claimed");
      expect(JSON.parse(f.git(["show", `${receipt}:outcome.json`]))).toEqual(original);
      expect(f.git(["merge-base", "--is-ancestor", receipt, outcomeRef])).toBe("");
    },
  );

  it.each(["present", "unavailable", "mismatched"])(
    "checks the %s historical audit before requiring source cleanup",
    (audit) => {
      const f = missingAdminAudit();
      const receipt = f.git(["rev-parse", outcomeRef]);
      const original = f.record();
      f.save({
        ...f.state(),
        audit: audit === "unavailable",
        auditParent: audit === "mismatched" ? f.head : "",
      });
      const completed = f.complete(receipt);
      expect(completed.status, completed.output).toBe(1);
      if (audit === "present") {
        expect(completed.output).toContain("Reconstructed after merge landing-parent audit:");
        expect(completed.output).toContain("native worktree to be absent");
      } else {
        expect(completed.output).toContain(
          audit === "unavailable"
            ? "audit unavailable"
            : "differs from the verified historical commit",
        );
        expect(completed.output).not.toContain("native worktree to be absent");
      }
      expect(existsSync(f.worktree)).toBe(true);
      expect(existsSync(join(f.worktree, ".local/merge-crabbox-parent-audit.json"))).toBe(false);
      expect(f.git(["rev-parse", outcomeRef])).toBe(receipt);
      expect(f.record()).toEqual(original);
      expect(f.state()).toMatchObject({ mutations: 1, posts: 0 });
    },
  );

  it("refuses a changed remote head before reconstructing an audit or requesting cleanup", () => {
    const f = missingAdminAudit();
    const receipt = f.git(["rev-parse", outcomeRef]);
    f.save({ ...f.state(), pr: { ...f.state().pr, headRefOid: f.base } });
    const completed = f.complete(receipt);
    expect(completed.status, completed.output).toBe(1);
    expect(completed.output).not.toContain("Reconstructed after merge landing-parent audit:");
    expect(existsSync(f.worktree)).toBe(true);
    expect(f.git(["rev-parse", outcomeRef])).toBe(receipt);
    expect(f.state()).toMatchObject({ mutations: 1, posts: 0 });
  });

  it("preserves a successor outcome instead of posting from a stale receipt", () => {
    const f = missingAdminAudit();
    const receipt = f.git(["rev-parse", outcomeRef]);
    removeOwnedFixtureCheckout(f);
    f.save({ ...f.state(), crash: "successor" });
    const completed = f.complete(receipt);
    expect(completed.status, completed.output).toBe(1);
    expect(f.git(["cat-file", "blob", outcomeRef])).toBe("successor");
    expect(f.state()).toMatchObject({ mutations: 1, posts: 0 });
  });

  it.each(["rejected", "lost"])("never repeats a %s delayed admin comment", (comment) => {
    const f = missingAdminAudit();
    removeOwnedFixtureCheckout(f);
    f.save({ ...f.state(), comment });
    const first = f.complete(f.git(["rev-parse", outcomeRef]));
    expect(first.status, first.output).toBe(1);
    expect(f.record().phase).toBe("commenting");
    expect(f.state()).toMatchObject({ mutations: 1, posts: 1 });
    f.recover();
    f.save({ ...f.state(), audit: true });
    const second = f.complete(f.git(["rev-parse", outcomeRef]));
    expect(second.status, second.output).toBe(comment === "lost" ? 0 : 1);
    expect(f.record().phase).toBe(comment === "lost" ? "complete" : "commenting");
    expect(f.state()).toMatchObject({ mutations: 1, posts: 1 });
  });
});
