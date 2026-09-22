import { existsSync } from "node:fs";
import { expect, it } from "vitest";
import { createMergeOutcomeFixtureHarness } from "./pr-merge-outcome.test-support.js";

const { fixture, reconciledMergeAfterCleanup, outcomeRef, describePosix } =
  createMergeOutcomeFixtureHarness();

describePosix("native merge outcome with real Git and supervised lock recovery", () => {
  it.each(["rejected", "lost"])("does not repeat a %s first completion POST", (comment) => {
    const f = reconciledMergeAfterCleanup();
    f.save({ ...f.state(), comment });
    const first = f.complete(f.git(["rev-parse", outcomeRef]));
    expect(first.status, first.output).toBe(1);
    expect(f.record().phase).toBe("commenting");
    expect(f.state().posts).toBe(1);
    f.recover();
    const second = f.complete(f.git(["rev-parse", outcomeRef]));
    expect(second.status, second.output).toBe(comment === "lost" ? 0 : 1);
    expect(f.record().phase).toBe(comment === "lost" ? "complete" : "commenting");
    expect(f.state().posts).toBe(1);
    expect(f.state().mutations).toBe(1);
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

  it("does not replace a missing admin landing audit with an unrecorded comment", () => {
    const f = reconciledMergeAfterCleanup(true);
    const oid = f.git(["rev-parse", outcomeRef]);
    f.save({
      ...f.state(),
      comments: [{ body: `<!-- openclaw-merge:${f.record().attempt} -->`, html_url: "fixture" }],
    });
    const result = f.complete(oid);
    expect(result.status, result.output).toBe(1);
    expect(f.git(["rev-parse", outcomeRef])).toBe(oid);
    expect(f.record().phase).toBe("merged");
    expect(f.state().posts).toBe(0);
    expect(f.state().mutations).toBe(1);
  });

  it.each(["stale-oid", "worktree", "local-branch", "remote-branch"])(
    "refuses explicit completion for %s without mutating resources or posting",
    (fault) => {
      const f = reconciledMergeAfterCleanup();
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
      const result = f.complete(fault === "stale-oid" ? f.base : oid);
      expect(result.status, result.output).toBe(1);
      expect(f.git(["rev-parse", outcomeRef])).toBe(oid);
      expect(f.state().posts).toBe(0);
      expect(f.state().mutations).toBe(1);
      if (fault === "worktree") {
        expect(existsSync(f.worktree)).toBe(true);
      }
      if (fault === "local-branch") {
        expect(f.git(["rev-parse", "pr-123-prep"])).toBe(f.head);
      }
      if (fault === "remote-branch") {
        expect(f.git(["--git-dir=" + f.remote, "rev-parse", "topic"])).toBe(f.head);
      }
    },
  );

  it("preserves a branch recreated while the first completion comment is posted", () => {
    const f = reconciledMergeAfterCleanup();
    f.save({ ...f.state(), cleanup: "advanced" });
    const result = f.complete(f.git(["rev-parse", outcomeRef]));
    expect(result.status, result.output).toBe(1);
    expect(f.record().phase).toBe("commented");
    expect(f.state().posts).toBe(1);
    expect(f.state().mutations).toBe(1);
    expect(f.git(["--git-dir=" + f.remote, "rev-parse", "topic"])).toBe(f.state().cleanupHead);
  });

  it("refuses ambiguous completion markers without posting or advancing the receipt", () => {
    const f = reconciledMergeAfterCleanup();
    const oid = f.git(["rev-parse", outcomeRef]);
    const body = `<!-- openclaw-merge:${f.record().attempt} -->`;
    f.save({
      ...f.state(),
      comments: [1, 2].map((id) => ({ body, html_url: `${f.state().pr.url}#issuecomment-${id}` })),
    });
    const result = f.complete(oid);
    expect(result.status, result.output).toBe(1);
    expect(f.git(["rev-parse", outcomeRef])).toBe(oid);
    expect(f.state().posts).toBe(0);
    expect(f.state().mutations).toBe(1);
  });

  it.each(["rejected", "lost"])("does not duplicate a %s completion comment", (comment) => {
    const f = fixture();
    f.save({ ...f.state(), comment });
    const first = f.run();
    expect(first.status, first.output).toBe(1);
    expect(f.record().phase).toBe("commenting");
    f.recover();
    const second = f.run();
    expect(second.status, second.output).toBe(0);
    expect(f.state().mutations).toBe(1);
    expect(f.state().posts).toBe(1);
    expect(existsSync(f.worktree)).toBe(true);
    expect(f.record().phase).toBe(comment === "lost" ? "commented" : "commenting");
  });

  it("does not delete an advanced remote branch and reports cleanup pending", () => {
    const f = fixture();
    f.save({ ...f.state(), cleanup: "advanced" });
    const run = f.run();
    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain("completion pending");
    expect(f.git(["--git-dir=" + f.remote, "rev-parse", "topic"])).toBe(f.state().cleanupHead);
    expect(f.record().phase).toBe("commented");
    const retry = f.run();
    expect(retry.status, retry.output).toBe(0);
    expect(f.state().posts).toBe(1);
    expect(f.state().mutations).toBe(1);
  });

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
        // Both verified identities survive removal of all disposable prepare artifacts.
        f.git(["merge-base", "--is-ancestor", localHead, outcomeRef]);
        f.git(["reflog", "expire", "--expire=now", "--all"]);
        f.git(["gc", "--prune=now"]);
        expect(f.git(["show", `${localHead}:owner.txt`])).toBe("after");
      }
    },
  );
});
