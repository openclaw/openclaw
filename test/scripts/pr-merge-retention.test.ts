import { existsSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { configureMerge, expectExit, observeMerged } from "./pr-merge-assertions.test-support.js";
import { createMergeOutcomeFixtureHarness } from "./pr-merge-outcome.test-support.js";

const { fixture, outcomeRef, describePosix } = createMergeOutcomeFixtureHarness();

describePosix("native merge resource retention", () => {
  it.each(["applied-merged", "applied-open"])(
    "reconciles a lost merge response (%s) without redispatch",
    (mode) => {
      const f = fixture();
      f.bindWorkflow();
      configureMerge(f, { mode });
      expectExit(f.retain(), mode === "applied-open" ? 1 : 0);
      expect(
        f
          .captures()
          .map(([, body]) => body)
          .join("\n"),
      ).toContain("502 Bad Gateway");
      if (mode === "applied-open") {
        expectExit(f.run(), 1);
        expect(f.record().phase).toBe("intent");
        expect(f.state()).toMatchObject({ mutations: 1, posts: 0 });
        observeMerged(f, f.git(["--git-dir=" + f.remote, "rev-parse", "main"]));
      }
      expectExit(f.run());
      expect(f.record().phase).toBe("retained");
      expect(f.state()).toMatchObject({ mutations: 1, posts: 1 });
      expect(existsSync(f.worktree)).toBe(true);
      expect(f.git(["--git-dir=" + f.remote, "rev-parse", "topic"])).toBe(f.head);
    },
  );

  it.each(["checkout", "local-ref", "binding"])(
    "refuses retained completion after %s changes",
    (resource) => {
      const f = fixture();
      f.bindWorkflow();
      configureMerge(f, { mode: "applied-open" });
      expectExit(f.retain(), 1);
      const ref =
        resource === "binding"
          ? "refs/openclaw/pr-workflow-bindings/123"
          : resource === "checkout"
            ? "refs/heads/pr-123-prep"
            : "refs/heads/pr-123";
      const old = f.git(["rev-parse", ref]);
      const changed = f.commit(
        f.git(["rev-parse", `${old}^{tree}`]),
        [resource === "binding" ? f.git(["rev-parse", `${old}^`]) : old],
        "Changed retained resource\n",
      );
      f.git(["update-ref", ref, changed, old]);
      observeMerged(f, f.git(["--git-dir=" + f.remote, "rev-parse", "main"]));
      const result = f.run();
      expectExit(result, 1);
      expect(result.output).toContain("retained resources or deletion policy changed");
      expect(f.record().phase).not.toBe("retained");
      expect(f.git(["rev-parse", ref])).toBe(changed);
      expect(f.state()).toMatchObject({ mutations: 1, posts: 0 });
      expect(existsSync(f.worktree)).toBe(true);
      expect(f.git(["--git-dir=" + f.remote, "rev-parse", "topic"])).toBe(f.head);
    },
  );

  it("merges once and retains the original branch, checkout and binding on completion", () => {
    const f = fixture();
    f.bindWorkflow();
    expectExit(f.retain());
    expect(f.record()).toMatchObject({ version: 2, phase: "retained", head: f.head });
    expect(existsSync(f.worktree)).toBe(true);
    expect(f.git(["rev-parse", "pr-123-prep"])).toBe(f.head);
    expect(f.git(["--git-dir=" + f.remote, "rev-parse", "topic"])).toBe(f.head);
    const bindingRef = "refs/openclaw/pr-workflow-bindings/123";
    const binding = f.git(["rev-parse", bindingRef]);
    expectExit(f.run());
    expectExit(f.run(false, f.repo, "squash", f.git(["rev-parse", outcomeRef])));
    expectExit(f.complete(f.git(["rev-parse", outcomeRef])));
    expectExit(f.complete(f.git(["rev-parse", outcomeRef])));
    expect(f.git(["rev-parse", bindingRef])).toBe(binding);
    expect(f.state()).toMatchObject({ posts: 1, mutations: 1 });
  });

  it.each(["admin", "explicit-admin", "auto", "queue"])(
    "refuses %s retention before intent or dispatch",
    (route) => {
      const f = fixture();
      f.bindWorkflow();
      if (route === "admin") {
        configureMerge(f, { admin: true, gates: "fail" });
      }
      if (route === "queue") {
        configureMerge(f, { pr: { isMergeQueueEnabled: true } });
      }
      const result =
        route === "explicit-admin"
          ? f.retain(
              false,
              f.repo,
              "squash",
              "",
              "",
              "",
              "",
              "",
              false,
              "",
              false,
              "unused.json",
              true,
            )
          : f.retain(route === "auto");
      expectExit(result, 1);
      expect(result.output).toContain("retention requires ordinary immediate");
      expect(f.git(["for-each-ref", "--format=%(refname)", outcomeRef])).toBe("");
      expect(f.state()).toMatchObject({ mutations: 0, posts: 0 });
    },
  );

  it.each(["unprotected", "bypass", "unknown-bypass"])(
    "refuses %s deletion authority before dispatch",
    (policy) => {
      const f = fixture();
      f.bindWorkflow();
      configureMerge(f, {
        retentionAutoDelete: true,
        retentionProtected: policy !== "unprotected",
        retentionRuleset: policy === "unknown-bypass",
        retentionUnknownBypass: policy === "unknown-bypass",
        retentionBypass: policy === "bypass",
      });
      expectExit(f.retain(), 1);
      expect(f.git(["for-each-ref", "--format=%(refname)", outcomeRef])).toBe("");
      expect(f.state().mutations).toBe(0);
    },
  );

  it.each([false, true])("accepts effective exact-branch protection (ruleset=%s)", (ruleset) => {
    const f = fixture();
    f.bindWorkflow();
    configureMerge(f, {
      retentionAutoDelete: true,
      retentionProtected: true,
      retentionRuleset: ruleset,
    });
    expectExit(f.retain());
    expect(f.record()).toMatchObject({
      version: 2,
      phase: "retained",
      retention: { remote: { protection: { kind: ruleset ? "ruleset" : "classic" } } },
    });
  });

  it.each(["gc", "stale", "finalized"] as const)(
    "refuses native %s cleanup even without capture files",
    (entry) => {
      const f = fixture();
      f.bindWorkflow();
      expectExit(f.retain());
      for (const [name] of f.captures()) {
        rmSync(join(f.worktree, ".local", name));
      }
      const moved = f.worktree + "-held";
      if (entry === "stale") {
        renameSync(f.worktree, moved);
      }
      if (entry === "finalized") {
        f.git(["remote", "set-url", "origin", "https://github.com/fixture/repo.git"]);
        // Finalized-task admission reads the advertised origin, not a fixture transport URL.
        f.git(["config", "--unset-all", `url.file://${f.remote}.insteadOf`]);
      }
      try {
        const result = f.maintenance(entry);
        expectExit(result, 1);
        expect(result.output).toContain(
          entry === "finalized"
            ? "unresolved native merge/completion"
            : "explicit merge resource retention",
        );
        expect(f.git(["rev-parse", "pr-123-prep"])).toBe(f.head);
        expect(f.git(["--git-dir=" + f.remote, "rev-parse", "topic"])).toBe(f.head);
        expect(existsSync(entry === "stale" ? moved : f.worktree)).toBe(true);
      } finally {
        if (entry === "stale") {
          renameSync(moved, f.worktree);
        }
        if (entry === "finalized") {
          f.git(["remote", "set-url", "origin", f.remote]);
          for (const suffix of ["", ".git"]) {
            f.git([
              "config",
              "--add",
              `url.file://${f.remote}.insteadOf`,
              `https://github.com/fixture/repo${suffix}`,
            ]);
          }
        }
      }
    },
  );

  it("reconciles a lost completion comment response without a second POST", () => {
    const f = fixture();
    f.bindWorkflow();
    configureMerge(f, { comment: "lost" });
    expectExit(f.retain(), 1);
    expect(f.record().phase).toBe("commenting");
    configureMerge(f, { comment: "success" });
    expectExit(f.run());
    expect(f.record().phase).toBe("retained");
    expect(f.state()).toMatchObject({ posts: 1, mutations: 1 });
  });

  it("retains an unexpected queued acknowledgement unresolved without redispatch", () => {
    const f = fixture();
    f.bindWorkflow();
    configureMerge(f, { restPolicy: "supported", asyncMergeStatus: "enqueued" });
    expectExit(f.retain(), 1);
    expectExit(f.run(), 1);
    expect(f.record()).toMatchObject({ version: 2, phase: "intent", accepted: true });
    expect(f.state().mutations).toBe(1);
  });

  it.each(["absent", "advanced"])(
    "does not recreate a branch that becomes %s after merge",
    (cleanup) => {
      const f = fixture();
      f.bindWorkflow();
      configureMerge(f, { cleanup });
      expectExit(f.retain(), 1);
      expect(f.record().phase).toBe("commented");
      expectExit(f.run(), 1);
      expect(f.state()).toMatchObject({ posts: 1, mutations: 1 });
      expect(existsSync(f.worktree)).toBe(true);
    },
  );

  it("rejects switching a cleanup intent into retention", () => {
    const f = fixture();
    f.bindWorkflow();
    configureMerge(f, { asyncMergeStatus: "pending" });
    expectExit(f.run());
    expectExit(f.retain(), 1);
    expect(f.record().version).toBe(1);
    expect(f.state().mutations).toBe(1);
  });

  it("checks deletion policy in the fork head repository rather than the base", () => {
    const f = fixture();
    configureMerge(f, {
      retentionSourceRepository: {
        id: 222,
        full_name: "fork/repo",
        html_url: "https://github.com/fork/repo",
      },
    });
    const args = ["retention", JSON.stringify(f.state().repo), "123", f.head];
    const refused = f.rest(args);
    expectExit(refused, 65);
    expect(refused.output).toContain("head-branch deletion protection");
    configureMerge(f, { retentionForkAutoDelete: false });
    const admitted = f.rest(args);
    expectExit(admitted);
    expect(JSON.parse(admitted.stdout)).toMatchObject({
      repository: { id: 222, nameWithOwner: "fork/repo" },
      head: f.head,
    });
    expect(f.state().mutations).toBe(0);
  });

  it.each(["metadata", "phase", "unknown"])(
    "refuses corrupt v2 %s without cleanup or redispatch",
    (fault) => {
      const f = fixture();
      f.bindWorkflow();
      expectExit(f.retain());
      const original = f.git(["rev-parse", outcomeRef]);
      const record = f.record();
      record.previous = original;
      if (fault === "metadata") {
        record.retention.localRefs["pr-123-prep"] = f.base;
      }
      if (fault === "phase") {
        record.phase = "complete";
      }
      if (fault === "unknown") {
        record.allowCleanup = true;
      }
      const blob = f.git(["hash-object", "-w", "--stdin"], JSON.stringify(record));
      const entries = f
        .git(["ls-tree", original])
        .split("\n")
        .filter((line) => !line.endsWith("\toutcome.json"));
      const tree = f.git(
        ["mktree"],
        [...entries, `100644 blob ${blob}\toutcome.json`, ""].join("\n"),
      );
      const parents = f.git(["show", "-s", "--format=%P", original]).split(" ");
      f.git(["update-ref", outcomeRef, f.commit(tree, [...parents, original])]);
      const result = f.run();
      expectExit(result, 1);
      expect(result.output).toMatch(
        /retention metadata or phase changed|corrupt or mismatched retained record/u,
      );
      expect(f.state()).toMatchObject({ mutations: 1, posts: 1 });
      expect(existsSync(f.worktree)).toBe(true);
    },
  );
});
