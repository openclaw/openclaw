import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createMergeOutcomeFixtureHarness } from "./pr-merge-outcome.test-support.js";

const {
  fixture,
  reconciledMergeAfterCleanup,
  outcomeRef,
  describePosix,
  unknownProjection,
  scripts,
} = createMergeOutcomeFixtureHarness();

describePosix("native merge outcome with real Git and supervised lock recovery", () => {
  it("explicitly completes a reconciled merge after cleanup without another merge dispatch", () => {
    const f = reconciledMergeAfterCleanup();
    const landed = f.git(["--git-dir=" + f.remote, "rev-parse", "main"]);
    const previous = f.git(["rev-parse", outcomeRef]);

    const completed = f.complete(previous);
    expect(completed.status, completed.output).toBe(0);
    expect(f.record()).toMatchObject({ phase: "complete", landed, head: f.head });
    expect(f.state().mutations).toBe(1);
    expect(f.state().posts).toBe(1);
    expect(f.state().comments[0]!.body).toContain("Merged via squash.");
    expect(f.state().comments[0]!.body).toContain(`/commit/${landed}`);
    f.git(["merge-base", "--is-ancestor", previous, outcomeRef]);

    const stale = f.complete(previous);
    expect(stale.status, stale.output).toBe(1);
    expect(f.record().phase).toBe("complete");
    const again = f.complete(f.git(["rev-parse", outcomeRef]));
    expect(again.status, again.output).toBe(0);
    expect(f.state().posts).toBe(1);
    expect(f.state().mutations).toBe(1);
  });

  it.each(["OPEN", "MERGED"])(
    "reconciles retained %s with UNKNOWN projections without admission waiting",
    (state) => {
      const f = fixture();
      f.save({ ...f.state(), mode: "unapplied" });
      expect(f.run().status).toBe(1);
      const before = f.git(["rev-parse", outcomeRef]);
      const capture = f.captures();
      f.recover();
      const landed = state === "MERGED" ? f.advance("after\n", "stable\n") : null;
      f.save({
        ...f.state(),
        observationReads: 0,
        pr: {
          ...f.state().pr,
          ...unknownProjection,
          state,
          mergeCommit: landed ? { oid: landed } : null,
        },
      });
      const run = f.run();
      expect(run.status, run.output).toBe(state === "MERGED" ? 0 : 1);
      expect(f.state().mutations).toBe(1);
      expect(f.state().posts).toBe(0);
      expect(f.state().settlementSleeps).toEqual([]);
      expect(f.state().observationReads).toBe(2);
      expect(f.captures()).toEqual(capture);
      expect(existsSync(f.worktree)).toBe(true);
      if (landed) {
        expect(f.record()).toMatchObject({ phase: "merged", landed });
      } else {
        expect(f.git(["rev-parse", outcomeRef])).toBe(before);
      }
    },
  );

  it.each(["", "Earlier merge response was lost\n"])(
    "refuses pre-journal merge output without erasing its evidence: %j",
    (output) => {
      const f = fixture();
      const capture = join(f.worktree, ".local/merge-output.log");
      writeFileSync(capture, output);
      f.save({ ...f.state(), mode: "unapplied" });
      const run = f.run();
      expect(run.status, run.output).toBe(1);
      expect(f.state().mutations).toBe(0);
      expect(readFileSync(capture, "utf8")).toBe(output);
      expect(run.output).toContain("Legacy .local/merge-output.log: present");
      expect(run.output).toContain("investigate; see scripts/AGENTS.md merge-outcome doctrine");
      expect(run.output).not.toContain("lock-recover, then rerun merge-run");
      expect(() => f.record()).toThrow();
    },
  );

  it("does not repeat applied 502 + OPEN after main advance and exact lock recovery", () => {
    const f = fixture();
    f.save({ ...f.state(), mode: "applied-open" });
    const first = f.run();
    expect(first.status, first.output).toBe(1);
    expect(f.state().pr.state).toBe("OPEN");
    f.advance();
    expect(f.recover()).toBe(true);
    const second = f.run();
    expect(f.state().mutations, "one mutation across exact lock recovery").toBe(1);
    expect(second.status, second.output).toBe(1);
    expect(f.state().posts).toBe(0);
    expect(second.output).toContain("prior dispatch unresolved");
  });

  it.each(["success", "applied-merged", "advance-at-dispatch"])(
    "confirms %s through fresh reads and preserves completion after later revert",
    (mode) => {
      const f = fixture();
      f.save({ ...f.state(), mode, stale: true });
      const first = f.run();
      expect(first.status, first.output).toBe(0);
      expect(f.state().posts).toBe(1);
      expect(f.record().phase).toBe("complete");
      expect(first.output).not.toContain("Warning: recorded squash");
      expect(f.ordinaryRead().state).toBe("OPEN");
      f.advance("before\n");
      const second = f.run();
      expect(second.status, second.output).toBe(0);
      expect(f.state().mutations).toBe(1);
      expect(f.state().posts).toBe(1);
      expect(second.output).toContain("already complete");
      expect(second.output).not.toContain("Warning: recorded squash");
    },
  );

  it.each(["intent", "dispatch", "receipt"])(
    "retains uncertainty across crash/failure at %s",
    (crash) => {
      const f = fixture();
      f.save({ ...f.state(), crash, mode: crash === "receipt" ? "success" : "applied-open" });
      expect(f.run().status).not.toBe(0);
      expect(f.record().phase).toBe("intent");
      f.recover();
      f.save({ ...f.state(), crash: "" });
      const retry = f.run();
      expect(retry.status, retry.output).toBe(crash === "receipt" ? 0 : 1);
      expect(f.state().mutations).toBe(crash === "intent" ? 0 : 1);
    },
  );

  it.each(["head", "base", "closed", "invalid", "unavailable", "partial", "revert"])(
    "does not replay unresolved intent after %s",
    (change) => {
      const f = fixture();
      f.save({ ...f.state(), mode: "unapplied" });
      expect(f.run().status).toBe(1);
      f.recover();
      const next = f.state();
      if (change === "head") {
        next.pr.headRefOid = f.base;
      }
      if (change === "base") {
        next.pr.baseRefName = "release";
      }
      if (change === "closed") {
        next.pr.state = "CLOSED";
      }
      if (change === "invalid") {
        next.invalid = true;
      }
      if (change === "unavailable") {
        next.unavailable = true;
      }
      if (change === "partial") {
        f.advance("partial\n");
      }
      if (change === "revert") {
        f.advance();
        f.advance("before\n");
      }
      f.save(next);
      const retry = f.run();
      expect(retry.status, retry.output).toBe(1);
      expect(f.state().mutations).toBe(1);
    },
  );

  it.each([
    { auto: false, method: "squash" },
    { auto: false, method: "merge" },
    { auto: true, method: "squash" },
  ])("reconciles accepted pending UNKNOWN intent without polling for %j", ({ auto, method }) => {
    const f = fixture();
    f.save({
      ...f.state(),
      mode: "pending",
      pr: {
        ...f.state().pr,
        isMergeQueueEnabled: !auto,
        mergeStateStatus: auto ? "BEHIND" : "BLOCKED",
      },
    });
    const first = f.run(auto, f.repo, method);
    expect(first.status, first.output).toBe(0);
    expect(first.output).toContain("AUTO/QUEUE PENDING");
    const before = f.git(["rev-parse", outcomeRef]);
    const capture = f.captures();
    f.save({
      ...f.state(),
      observationReads: 0,
      pr: { ...f.state().pr, ...unknownProjection },
    });
    const pending = f.run(auto, f.repo, method);
    expect(f.state().mutations).toBe(1);
    expect(f.state().posts).toBe(0);
    expect(f.git(["rev-parse", outcomeRef])).toBe(before);
    expect(f.captures()).toEqual(capture);
    expect(pending.status, pending.output).toBe(0);
    expect(pending.output).toContain("AUTO/QUEUE PENDING");
    expect(f.state().settlementSleeps).toEqual([]);
    expect(f.state().observationReads).toBe(2);
    const landed = f.advance("after\n", "stable\n");
    f.save({
      ...f.state(),
      pr: {
        ...f.state().pr,
        state: "MERGED",
        mergeCommit: { oid: landed },
        autoMergeRequest: null,
        isInMergeQueue: false,
      },
    });
    const done = f.run(auto, f.repo, method);
    expect(done.status, done.output).toBe(0);
    expect(f.state().mutations).toBe(1);
  });

  it.each([false, true])(
    "never cancels/rearms/falls back after ambiguous queue/auto=%s",
    (auto) => {
      const f = fixture();
      f.save({
        ...f.state(),
        mode: "pending-error",
        pr: {
          ...f.state().pr,
          isMergeQueueEnabled: !auto,
          mergeStateStatus: auto ? "BEHIND" : "BLOCKED",
        },
      });
      expect(f.run(auto).status).toBe(1);
      f.recover();
      f.save({
        ...f.state(),
        pr: { ...f.state().pr, autoMergeRequest: null, isInMergeQueue: false },
      });
      expect(f.run(auto).status).toBe(1);
      expect(f.state().mutations).toBe(1);
    },
  );

  it("audits a confirmed admin landing using the prepared repository", () => {
    const f = fixture();
    f.save({ ...f.state(), admin: true, gates: "fail", comment: "rejected" });
    const result = f.run();
    expect(result.status, result.output).toBe(1);
    expect(f.record().phase, result.output).toBe("commenting");
    expect(f.state().calls).toContainEqual([
      "direct",
      "api",
      `repos/fixture/repo/commits/${f.record().landed}`,
    ]);
    expect(
      JSON.parse(readFileSync(join(f.worktree, ".local/merge-crabbox-parent-audit.json"), "utf8")),
    ).toMatchObject({
      status: "match",
      expectedParentSha: f.base,
      actualParentSha: f.base,
    });
    f.recover();
  });

  it("retains confirmed admin merge before failed post-merge audit", () => {
    const f = fixture();
    f.save({ ...f.state(), admin: true, audit: true, gates: "fail" });
    const first = f.run();
    expect(first.status, first.output).toBe(1);
    expect(f.record().route).toBe("admin");
    expect(f.record().phase).toBe("merged");
    f.recover();
    const retry = f.run();
    expect(retry.status, retry.output).toBe(0);
    expect(f.state().mutations).toBe(1);
    expect(f.state().posts).toBe(0);
  });

  it("keeps required commits reachable through worktree deletion and aggressive GC", () => {
    const f = fixture();
    f.save({ ...f.state(), mode: "unapplied" });
    expect(f.run().status).toBe(1);
    f.recover();
    f.git(["worktree", "remove", "--force", f.worktree]);
    f.git(["branch", "-D", "pr-123-prep", "pr-123", "topic"]);
    f.git(["update-ref", "-d", "refs/remotes/origin/topic"]);
    f.git(["reflog", "expire", "--expire=now", "--all"]);
    f.git(["gc", "--prune=now"]);
    f.git(["cat-file", "-e", f.head + "^{commit}"]);
    expect(f.run().status).toBe(1);
    expect(f.state().mutations).toBe(1);
  });

  it.each([
    "corrupt",
    "symbolic",
    "mismatched",
    "missing-head",
    "missing-parent",
    "wrong-tree",
    "unreachable",
    "recovery-head",
    "recovery-extra",
    "recovery-unretained",
    "recovery-method",
    "recovery-repo",
  ])("fails closed on %s outcome evidence", (fault) => {
    const f = fixture();
    f.save({ ...f.state(), mode: "unapplied" });
    expect(f.run().status).toBe(1);
    f.recover();
    const previous = f.git(["rev-parse", outcomeRef]);
    if (fault.startsWith("recovery-")) {
      const original = f.record();
      const record = {
        ...original,
        method: fault === "recovery-method" ? "merge" : original.method,
        repo: fault === "recovery-repo" ? { ...original.repo, id: 1103012935 } : original.repo,
        recovery: {
          outcome: previous,
          attempt: original.attempt,
          actor: "fixture-operator",
          reason: "explicit-operator-recovery",
          replacementHead: fault === "recovery-head" ? f.base : f.head,
          ...(fault === "recovery-extra" ? { allow: true } : {}),
        },
      };
      const blob = f.git(["hash-object", "-w", "--stdin"], JSON.stringify(record));
      const tree = f.git(["mktree"], `100644 blob ${blob}\toutcome.json\n`);
      const parents = [f.head, f.base, ...(fault === "recovery-unretained" ? [] : [previous])];
      f.git(["update-ref", outcomeRef, f.commit(tree, parents)]);
    }
    if (fault === "corrupt") {
      f.git(["update-ref", outcomeRef, f.git(["hash-object", "-w", "--stdin"], "bad")]);
    }
    if (fault === "symbolic") {
      f.git(["symbolic-ref", outcomeRef, "refs/heads/topic"]);
    }
    if (fault === "mismatched") {
      f.save({
        ...f.state(),
        repoAuthority: { ...f.state().repoAuthority, node_id: "other-repo" },
      });
    }
    if (fault === "missing-head") {
      rmSync(join(f.repo, ".git/objects", f.head.slice(0, 2), f.head.slice(2)));
    }
    if (fault === "missing-parent") {
      const detached = f.commit(f.git(["rev-parse", previous + "^{tree}"]), []);
      f.git(["update-ref", outcomeRef, detached]);
    }
    if (fault === "wrong-tree" || fault === "unreachable") {
      const landed = fault === "wrong-tree" ? f.advance("partial\n") : f.head;
      f.save({
        ...f.state(),
        pr: { ...f.state().pr, state: "MERGED", mergeCommit: { oid: landed } },
      });
    }
    const before = f.git(["rev-parse", outcomeRef]);
    const retry = f.run();
    expect(retry.status, retry.output).toBe(1);
    expect(f.state().mutations).toBe(1);
    expect(f.state().posts).toBe(0);
    expect(f.git(["rev-parse", outcomeRef])).toBe(before);
  });

  it("does not overwrite a successor installed at intent CAS", () => {
    const f = fixture();
    f.save({ ...f.state(), crash: "successor" });
    const run = f.run();
    expect(run.status, run.output).toBe(1);
    expect(f.git(["cat-file", "blob", outcomeRef])).toBe("successor");
    expect(f.state().mutations).toBe(0);
  });

  it("shares retained outcome across linked checkout contenders", () => {
    const f = fixture();
    const linked = join(f.root, "contender");
    f.git(["worktree", "add", "-q", "--detach", linked, f.base]);
    f.save({ ...f.state(), mode: "unapplied" });
    expect(f.run().status).toBe(1);
    f.recover();
    const retry = f.run(false, linked);
    expect(retry.status, retry.output).toBe(1);
    expect(f.state().mutations).toBe(1);
  });
});

describePosix("merge_outcome_repo_identity", () => {
  // Local historical records contain either scalar. Remote admission separately
  // binds the whole retained object to the authoritative repository pair.
  const identity = (repo: unknown, parentEnv: NodeJS.ProcessEnv = process.env) =>
    spawnSync(
      "bash",
      [
        "-c",
        `set -euo pipefail; . "$1"; printf '%s' "$2" | merge_outcome_repo_identity`,
        "bash",
        join(scripts, "pr-lib/merge-outcome.sh"),
        JSON.stringify(repo),
      ],
      {
        encoding: "utf8",
        env: { ...parentEnv, OPENCLAW_PR_GITHUB_SNAPSHOT_ROOT: undefined },
      },
    );

  it.each([1103012935, "R_kgDOQb6kRw"])(
    "validates identity %s despite an unrelated inherited helper snapshot",
    (id) => {
      const repo = {
        id,
        nameWithOwner: "openclaw/openclaw",
        url: "https://github.com/openclaw/openclaw",
      };
      const run = identity(repo, {
        ...process.env,
        OPENCLAW_PR_GITHUB_SNAPSHOT_ROOT: join(scripts, "pr-lib"),
      });
      expect(run.status, run.stderr).toBe(0);
      expect(JSON.parse(run.stdout)).toEqual(repo);
      expect(run.stderr).toBe("");
    },
  );

  it.each([
    ["a missing id", {}],
    ["a null id", { id: null }],
    ["an empty string id", { id: "" }],
    ["an object id", { id: { node: "x" } }],
  ])("still rejects %s", (_label, overrides) => {
    const run = identity({
      nameWithOwner: "openclaw/openclaw",
      url: "https://github.com/openclaw/openclaw",
      ...overrides,
    });
    expect(run.status, run.stderr).toBe(4);
    expect(run.stderr).toBe("");
    expect(run.stdout).toBe("");
  });

  it("still rejects a url that does not belong to the named repository", () => {
    const run = identity({
      id: 1103012935,
      nameWithOwner: "openclaw/openclaw",
      url: "https://github.com/attacker/openclaw",
    });
    expect(run.status, run.stderr).toBe(4);
    expect(run.stderr).toBe("");
    expect(run.stdout).toBe("");
  });
});

describePosix("repository identity across gh id representations", () => {
  const canonicalRepo = {
    id: "R_kgDOQb6kRw",
    nameWithOwner: "fixture/repo",
    url: "https://github.com/fixture/repo",
  };
  const historicalIds = [
    { name: "node", id: "R_kgDOQb6kRw", nextId: 1103012935 },
    { name: "numeric", id: 1103012935, nextId: "R_kgDOQb6kRw" },
  ];
  const retainRepository = (f: ReturnType<typeof fixture>, repo: unknown) => {
    const previous = f.git(["rev-parse", outcomeRef]);
    const parents = f.git(["show", "-s", "--format=%P", previous]).split(" ");
    const blob = f.git(["hash-object", "-w", "--stdin"], JSON.stringify({ ...f.record(), repo }));
    const tree = f.git(["mktree"], `100644 blob ${blob}\toutcome.json\n`);
    const historical = f.commit(tree, [...parents, previous], "Historical repository identity\n");
    f.git(["update-ref", outcomeRef, historical, previous]);
    return historical;
  };

  it.each(historicalIds)("records the canonical node identity with a $name CLI id", ({ id }) => {
    const f = fixture();
    f.save({ ...f.state(), repo: { ...f.state().repo, id } });
    const run = f.run();
    expect(run.status, run.output).toBe(0);
    expect(f.record().repo).toEqual(canonicalRepo);
    expect(f.record().phase).toBe("complete");
    expect(f.state().mutations).toBe(1);
  });

  it.each(historicalIds)(
    "recovers the historical $name identity after CLI shape drift without rewriting its evidence",
    ({ id, nextId }) => {
      const f = fixture();
      f.save({ ...f.state(), mode: "unapplied", repo: { ...f.state().repo, id } });
      const first = f.run();
      expect(first.status, first.output).toBe(1);
      f.recover();
      const repo = { ...canonicalRepo, id };
      const previous = retainRepository(f, repo);
      const bytes = f.git(["show", `${previous}:outcome.json`]);
      const attempt = f.record().attempt;
      const captures = f.captures();
      f.save({ ...f.state(), repo: { ...f.state().repo, id: nextId } });

      const observed = f.run();
      expect(observed.status, observed.output).toBe(1);
      expect(observed.output).toContain("prior dispatch unresolved");
      expect(f.git(["rev-parse", outcomeRef])).toBe(previous);
      expect(f.captures()).toEqual(captures);
      expect(f.state().mutations).toBe(1);
      expect(f.state().posts).toBe(0);
      f.recover();
      f.save({ ...f.state(), mode: "success" });

      const recovered = f.run(false, f.repo, "squash", previous);
      expect(recovered.status, recovered.output).toBe(0);
      expect(f.record()).toMatchObject({
        phase: "complete",
        recovery: { outcome: previous, attempt, actor: "fixture-operator" },
      });
      expect(f.record().repo).toEqual(repo);
      expect(f.git(["show", `${previous}:outcome.json`])).toBe(bytes);
      f.git(["merge-base", "--is-ancestor", previous, outcomeRef]);
      expect(f.state().mutations).toBe(2);
      expect(f.state().posts).toBe(1);
      expect(existsSync(f.worktree)).toBe(false);
    },
  );

  it.each(historicalIds)(
    "completes the historical $name receipt after CLI shape drift without another dispatch",
    ({ id, nextId }) => {
      const f = reconciledMergeAfterCleanup();
      const repo = { ...canonicalRepo, id };
      const previous = retainRepository(f, repo);
      const bytes = f.git(["show", `${previous}:outcome.json`]);
      f.save({ ...f.state(), repo: { ...f.state().repo, id: nextId } });

      const completed = f.complete(previous);
      expect(completed.status, completed.output).toBe(0);
      expect(f.record().phase).toBe("complete");
      expect(f.record().repo).toEqual(repo);
      expect(f.git(["show", `${previous}:outcome.json`])).toBe(bytes);
      f.git(["merge-base", "--is-ancestor", previous, outcomeRef]);
      expect(f.state().mutations).toBe(1);
      expect(f.state().posts).toBe(1);
      expect(existsSync(f.worktree)).toBe(false);
    },
  );

  it.each(
    [
      { name: "extra key", repo: { ...canonicalRepo, allow: true } },
      { name: "numeric string", repo: { ...canonicalRepo, id: "1103012935" } },
      { name: "unknown node id", repo: { ...canonicalRepo, id: "R_other" } },
      { name: "unknown numeric id", repo: { ...canonicalRepo, id: 1103012936 } },
      {
        name: "other repository",
        repo: {
          ...canonicalRepo,
          nameWithOwner: "fixture/other",
          url: "https://github.com/fixture/other",
        },
      },
    ].flatMap((fault) =>
      [false, true].map((completion) => ({ name: fault.name, repo: fault.repo, completion })),
    ),
  )(
    "refuses retained $name before side effects (completion=$completion)",
    ({ repo, completion }) => {
      const f = completion ? reconciledMergeAfterCleanup() : fixture();
      if (!completion) {
        f.save({ ...f.state(), mode: "unapplied" });
        expect(f.run().status).toBe(1);
        f.recover();
      }
      const previous = retainRepository(f, repo);
      const bytes = f.git(["show", `${previous}:outcome.json`]);
      const captures = completion ? [] : f.captures();
      f.save({ ...f.state(), mode: "success" });

      const result = completion ? f.complete(previous) : f.run(false, f.repo, "squash", previous);
      expect(result.status, result.output).toBe(1);
      expect(f.git(["rev-parse", outcomeRef])).toBe(previous);
      expect(f.git(["show", `${previous}:outcome.json`])).toBe(bytes);
      expect(f.state().mutations).toBe(1);
      expect(f.state().posts).toBe(0);
      expect(existsSync(f.worktree)).toBe(!completion);
      if (!completion) {
        expect(f.captures()).toEqual(captures);
        expect(f.git(["--git-dir=" + f.remote, "rev-parse", "topic"])).toBe(f.head);
      }
    },
  );

  it.each([
    { name: "missing numeric id", authority: { id: undefined } },
    { name: "numeric string", authority: { id: "1103012935" } },
    { name: "zero numeric id", authority: { id: 0 } },
    { name: "fractional numeric id", authority: { id: 1.5 } },
    { name: "missing node id", authority: { node_id: undefined } },
    { name: "empty node id", authority: { node_id: "" } },
    { name: "numeric node id", authority: { node_id: 1103012935 } },
    { name: "different name", authority: { full_name: "fixture/other" } },
    { name: "different host", authority: { html_url: "https://elsewhere.invalid/fixture/repo" } },
  ])("rejects $name in repository authority before recording intent", ({ authority }) => {
    const f = fixture();
    f.save({ ...f.state(), repoAuthority: { ...f.state().repoAuthority, ...authority } });
    const result = f.run();
    expect(result.status, result.output).toBe(1);
    expect(f.state().mutations).toBe(0);
    expect(f.state().posts).toBe(0);
    expect(() => f.record()).toThrow();
    expect(f.captures()).toEqual([]);
    expect(existsSync(f.worktree)).toBe(true);
  });

  it.each([false, true])("requires repository authority for completion=%s", (completion) => {
    const f = completion ? reconciledMergeAfterCleanup() : fixture();
    const previous = completion ? f.git(["rev-parse", outcomeRef]) : undefined;
    f.save({ ...f.state(), repoAuthorityUnavailable: true });
    const result = previous ? f.complete(previous) : f.run();
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain("repository metadata unavailable");
    expect(f.state().mutations).toBe(completion ? 1 : 0);
    expect(f.state().posts).toBe(0);
    if (previous) {
      expect(f.git(["rev-parse", outcomeRef])).toBe(previous);
    } else {
      expect(() => f.record()).toThrow();
    }
    expect(existsSync(f.worktree)).toBe(!completion);
  });
});
