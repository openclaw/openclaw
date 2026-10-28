import { existsSync } from "node:fs";
import { expect, it } from "vitest";
import { configureMerge, expectExit } from "./pr-merge-assertions.test-support.js";
import { createMergeOutcomeFixtureHarness } from "./pr-merge-outcome.test-support.js";

const { fixture, reconciledMergeAfterCleanup, outcomeRef, describePosix } =
  createMergeOutcomeFixtureHarness();

describePosix("native merge completion", () => {
  it("retires the workflow binding only after verified native cleanup", () => {
    const f = fixture();
    f.bindWorkflow();
    configureMerge(f, { cleanup: "absent" });
    const nested = "refs/heads/archive/refs/heads/topic";
    f.git(["push", "-q", "origin", `${f.head}:${nested}`]);
    const run = expectExit(f.run());
    expect(run.output).not.toContain("Warning: remote cleanup pending");
    expect(f.record().phase).toBe("complete");
    expect(f.state().posts).toBe(1);
    expect(f.git(["--git-dir=" + f.remote, "rev-parse", nested])).toBe(f.head);
    expect(
      f.git(["for-each-ref", "--format=%(refname)", "refs/openclaw/pr-workflow-bindings/123"]),
    ).toBe("");
    expectExit(f.run());
    expect(
      f.git(["for-each-ref", "--format=%(refname)", "refs/openclaw/pr-workflow-bindings/123"]),
    ).toBe("");
    expect(f.state().mutations).toBe(1);
  });

  it("retains an unfinished workflow and retires it on explicit delayed completion", () => {
    const f = reconciledMergeAfterCleanup();
    f.bindWorkflow();
    configureMerge(f, { comment: "rejected" });
    expectExit(f.complete(f.git(["rev-parse", outcomeRef])), 1);
    const ref = "refs/openclaw/pr-workflow-bindings/123";
    const binding = f.git(["rev-parse", ref]);
    expect(f.git(["rev-parse", `${binding}^`])).toBe(f.base);
    f.recover();
    configureMerge(f, {
      comments: [{ body: `<!-- openclaw-merge:${f.record().attempt} -->`, html_url: "fixture" }],
    });
    expectExit(f.complete(f.git(["rev-parse", outcomeRef])));
    expect(f.record().phase).toBe("complete");
    expect(f.git(["for-each-ref", "--format=%(refname)", ref])).toBe("");
  });

  it.each(["rejected", "lost"])("does not repeat an inline %s completion POST", (comment) => {
    const f = fixture();
    configureMerge(f, { comment });
    expectExit(f.run(), 1);
    expect(f.record().phase).toBe("commenting");
    expect(f.state().posts).toBe(1);
    f.recover();
    expectExit(f.run());
    expect(f.record().phase).toBe(comment === "lost" ? "commented" : "commenting");
    expect(f.state()).toMatchObject({ posts: 1, mutations: 1 });
    expect(existsSync(f.worktree)).toBe(true);
  });

  it("preserves unrelated local source-name branches during explicit completion", () => {
    const f = reconciledMergeAfterCleanup();
    f.git(["branch", "topic", f.base]);
    const nested = "refs/heads/archive/refs/heads/topic";
    f.git(["push", "-q", "origin", `${f.head}:${nested}`]);
    expectExit(f.complete(f.git(["rev-parse", outcomeRef])));
    expect(f.record().phase).toBe("complete");
    expect(f.git(["rev-parse", "topic"])).toBe(f.base);
    expect(f.git(["--git-dir=" + f.remote, "rev-parse", nested])).toBe(f.head);
    expect(f.state()).toMatchObject({ posts: 1, mutations: 1 });
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
      configureMerge(f, {
        comments: (fault === "admin-audit" ? [1] : [1, 2]).map((id) => ({
          body: `<!-- openclaw-merge:${f.record().attempt} -->`,
          html_url: `${f.state().pr.url}#issuecomment-${id}`,
        })),
      });
    }
    expectExit(f.complete(fault === "stale-oid" ? f.base : oid), 1);
    expect(f.git(["rev-parse", outcomeRef])).toBe(oid);
    expect(f.state()).toMatchObject({ posts: 0, mutations: 1 });
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
      configureMerge(f, { cleanup: "advanced" });
      const result = expectExit(
        explicit ? f.complete(f.git(["rev-parse", outcomeRef])) : f.run(),
        explicit ? 1 : 0,
      );
      expect(f.record().phase).toBe("commented");
      expect(f.git(["--git-dir=" + f.remote, "rev-parse", "topic"])).toBe(f.state().cleanupHead);
      if (!explicit) {
        expect(result.output).toContain("completion pending");
        expectExit(f.run());
      }
      expect(f.state()).toMatchObject({ posts: 1, mutations: 1 });
    },
  );

  it("refuses unpublished local preparation before cleanup", () => {
    const f = fixture();
    const localHead = f.commit(f.tree("unpublished\n"), [f.base], "Local prepared commit\n");
    f.git(["-C", f.worktree, "reset", "--hard", localHead]);
    f.prepare(f.head, f.base, localHead);
    const run = f.run();
    expect(run.status, run.output).not.toBe(0);
    expect(f.state().mutations).toBe(0);
    expect(f.git(["rev-parse", "pr-123-prep"])).toBe(localHead);
    expect(existsSync(f.worktree)).toBe(true);
  });
});
