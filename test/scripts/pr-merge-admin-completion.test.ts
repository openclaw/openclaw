import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import * as proof from "./pr-merge-assertions.test-support.js";
import { createMergeOutcomeFixtureHarness } from "./pr-merge-outcome.test-support.js";
import { createPriorCiCandidateFactory } from "./pr-merge-prior-ci.test-support.js";

const { fixture, outcomeRef, describePosix } = createMergeOutcomeFixtureHarness();
const { preExistingCandidate } = createPriorCiCandidateFactory(fixture);

function missingAdminAudit(drift = false) {
  const f = proof.configuredFixture(preExistingCandidate, {
    audit: true,
    mode: drift ? "advance-at-dispatch" : "success",
  });
  const dispatched = proof.expectExit(f.adminPriorCi(f.path), 1);
  expect(dispatched.output).toContain("audit unavailable");
  expect(f.record()).toMatchObject({ phase: "merged", route: "admin", accepted: true });
  expect(f.state()).toMatchObject({ mutations: 1, posts: 0 });
  expect(existsSync(join(f.worktree, ".local/merge-crabbox-parent-audit.json"))).toBe(false);
  expect(f.recover()).toBe(false);
  proof.configureMerge(f, { audit: false });
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
      proof.expectExit(f.complete(receipt));
      expect(f.record()).toMatchObject({ phase: "complete", priorCiAdmin: original.priorCiAdmin });
      expect(f.state()).toMatchObject({ mutations: 1, posts: 1 });
      for (const text of [
        `Reconstructed after merge landing-parent audit: ${drift ? "drift" : "match"}`,
        f.git(["rev-parse", `${original.landed}^1`]),
        "No original at-landing audit is claimed",
        original.main,
        "No current-head CI success is claimed",
      ]) {
        expect(f.state().comments[0]?.body).toContain(text);
      }
      expect(JSON.parse(f.git(["show", `${receipt}:outcome.json`]))).toEqual(original);
      expect(f.git(["merge-base", "--is-ancestor", receipt, outcomeRef])).toBe("");
    },
  );

  it.each(["present", "unavailable", "mismatched", "changed head"])(
    "checks the %s historical audit before requiring source cleanup",
    (audit) => {
      const f = missingAdminAudit();
      const receipt = f.git(["rev-parse", outcomeRef]);
      const original = f.record();
      proof.configureMerge(f, {
        audit: audit === "unavailable",
        auditParent: audit === "mismatched" ? f.head : "",
        ...(audit === "changed head" ? { pr: { headRefOid: f.base } } : {}),
      });
      const completed = proof.expectExit(f.complete(receipt), 1);
      if (audit === "present") {
        expect(completed.output).toContain("Reconstructed after merge landing-parent audit:");
        expect(completed.output).toContain("native worktree to be absent");
      } else if (audit === "changed head") {
        expect(completed.output).not.toContain("Reconstructed after merge landing-parent audit:");
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

  it("preserves a successor outcome instead of posting from a stale receipt", () => {
    const f = missingAdminAudit();
    const receipt = f.git(["rev-parse", outcomeRef]);
    removeOwnedFixtureCheckout(f);
    proof.configureMerge(f, { crash: "successor" });
    proof.expectExit(f.complete(receipt), 1);
    expect(f.git(["cat-file", "blob", outcomeRef])).toBe("successor");
    expect(f.state()).toMatchObject({ mutations: 1, posts: 0 });
  });

  it.each(["rejected", "lost"])("never repeats a %s delayed admin comment", (comment) => {
    const f = missingAdminAudit();
    removeOwnedFixtureCheckout(f);
    proof.configureMerge(f, { comment });
    proof.expectExit(f.complete(f.git(["rev-parse", outcomeRef])), 1);
    expect(f.record().phase).toBe("commenting");
    expect(f.state()).toMatchObject({ mutations: 1, posts: 1 });
    f.recover();
    proof.configureMerge(f, { audit: true });
    proof.expectExit(f.complete(f.git(["rev-parse", outcomeRef])), comment === "lost" ? 0 : 1);
    expect(f.record().phase).toBe(comment === "lost" ? "complete" : "commenting");
    expect(f.state()).toMatchObject({ mutations: 1, posts: 1 });
  });
});
