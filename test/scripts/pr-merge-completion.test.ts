import { existsSync } from "node:fs";
import { expect, it } from "vitest";
import { createMergeOutcomeFixtureHarness } from "./pr-merge-outcome.test-support.js";

const { fixture, reconciledMergeAfterCleanup, outcomeRef, describePosix } =
  createMergeOutcomeFixtureHarness();

describePosix("native merge completion", () => {
  it.each([
    ["explicit", "rejected"],
    ["explicit", "lost"],
    ["inline", "rejected"],
    ["inline", "lost"],
  ])("does not repeat a %s %s completion POST", (route, comment) => {
    const explicit = route === "explicit";
    const f = explicit ? reconciledMergeAfterCleanup() : fixture();
    const complete = () => (explicit ? f.complete(f.git(["rev-parse", outcomeRef])) : f.run());
    f.save({ ...f.state(), comment });
    const first = complete();
    expect(first.status, first.output).toBe(1);
    expect(f.record().phase).toBe("commenting");
    expect(f.state().posts).toBe(1);
    f.recover();
    const second = complete();
    expect(second.status, second.output).toBe(explicit && comment === "rejected" ? 1 : 0);
    expect(f.record().phase).toBe(
      comment === "lost" ? (explicit ? "complete" : "commented") : "commenting",
    );
    expect(f.state().posts).toBe(1);
    expect(f.state().mutations).toBe(1);
    if (!explicit) {
      expect(existsSync(f.worktree)).toBe(true);
    }
  });

  it("preserves unrelated local source-name branches during explicit completion", () => {
    const f = reconciledMergeAfterCleanup();
    f.git(["branch", "topic", f.base]);
    const result = f.complete(f.git(["rev-parse", outcomeRef]));
    expect(result.status, result.output).toBe(0);
    expect(f.record().phase).toBe("complete");
    expect(f.git(["rev-parse", "topic"])).toBe(f.base);
    expect(f.state().posts).toBe(1);
    expect(f.state().mutations).toBe(1);
  });

  it.each([
    "stale-oid",
    "worktree",
    "local-branch",
    "remote-branch",
    "admin-audit",
    "ambiguous-marker",
  ])("refuses explicit completion for %s without mutating resources or posting", (fault) => {
    const f = reconciledMergeAfterCleanup(fault === "admin-audit");
    const oid = f.git(["rev-parse", outcomeRef]);
    if (fault === "worktree") {
      f.git(["worktree", "add", "-q", "--detach", f.worktree, f.head]);
    }
    if (fault === "local-branch") {
      f.git(["branch", "pr-123-prep", f.head]);
    }
    if (fault === "remote-branch") {
      f.git(["push", "-q", "origin", `${f.head}:refs/heads/topic`]);
    }
    if (fault === "admin-audit" || fault === "ambiguous-marker") {
      f.save({
        ...f.state(),
        comments: (fault === "admin-audit" ? [1] : [1, 2]).map((id) => ({
          body: `<!-- openclaw-merge:${f.record().attempt} -->`,
          html_url: `${f.state().pr.url}#issuecomment-${id}`,
        })),
      });
    }
    const result = f.complete(fault === "stale-oid" ? f.base : oid);
    expect(result.status, result.output).toBe(1);
    expect(f.git(["rev-parse", outcomeRef])).toBe(oid);
    expect(f.state().posts).toBe(0);
    expect(f.state().mutations).toBe(1);
    if (fault === "admin-audit") {
      expect(f.record().phase).toBe("merged");
    }
    if (fault === "worktree") {
      expect(existsSync(f.worktree)).toBe(true);
    }
    if (fault === "local-branch") {
      expect(f.git(["rev-parse", "pr-123-prep"])).toBe(f.head);
    }
    if (fault === "remote-branch") {
      expect(f.git(["--git-dir=" + f.remote, "rev-parse", "topic"])).toBe(f.head);
    }
  });

  it.each(["explicit", "inline"])(
    "preserves an advanced remote branch during %s completion",
    (route) => {
      const explicit = route === "explicit";
      const f = explicit ? reconciledMergeAfterCleanup() : fixture();
      f.save({ ...f.state(), cleanup: "advanced" });
      const result = explicit ? f.complete(f.git(["rev-parse", outcomeRef])) : f.run();
      expect(result.status, result.output).toBe(explicit ? 1 : 0);
      expect(f.record().phase).toBe("commented");
      expect(f.git(["--git-dir=" + f.remote, "rev-parse", "topic"])).toBe(f.state().cleanupHead);
      if (!explicit) {
        expect(result.output).toContain("completion pending");
        const retry = f.run();
        expect(retry.status, retry.output).toBe(0);
      }
      expect(f.state().posts).toBe(1);
      expect(f.state().mutations).toBe(1);
    },
  );

  it("completes cleanup when GitHub already deleted the source branch", () => {
    const f = fixture();
    f.save({ ...f.state(), cleanup: "absent" });
    const run = f.run();
    expect(run.status, run.output).toBe(0);
    expect(run.output).not.toContain("Warning: remote cleanup pending");
    expect(f.record().phase).toBe("complete");
    expect(f.state().posts).toBe(1);
  });

  it.each([false, true])(
    "checks local/hosted preparation before cleanup (different tree=%s)",
    (differentTree) => {
      const f = fixture();
      const localHead = f.commit(
        f.tree(differentTree ? "unpublished\n" : "after\n"),
        [f.base],
        "Local prepared commit\n",
      );
      f.git(["-C", f.worktree, "reset", "--hard", localHead]);
      f.prepare(f.head, f.base, localHead);
      const run = f.run();
      if (differentTree) {
        expect(run.status, run.output).not.toBe(0);
        expect(f.state().mutations).toBe(0);
        expect(f.git(["rev-parse", "pr-123-prep"])).toBe(localHead);
        expect(existsSync(f.worktree)).toBe(true);
      } else {
        expect(run.status, run.output).toBe(0);
        expect(run.output).not.toContain("cleanup pending");
        expect(f.record().phase).toBe("complete");
        expect(existsSync(f.worktree)).toBe(false);
        expect(f.git(["for-each-ref", "--format=%(refname)", "refs/heads/pr-123-prep"])).toBe("");
        f.git(["merge-base", "--is-ancestor", localHead, outcomeRef]);
        f.git(["reflog", "expire", "--expire=now", "--all"]);
        f.git(["gc", "--prune=now"]);
        expect(f.git(["show", `${localHead}:owner.txt`])).toBe("after");
      }
    },
  );
});
