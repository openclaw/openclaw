import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  expectRetained,
  retainIntent,
  configuredFixture,
  expectExit,
  configureMerge,
  observeMerged,
} from "./pr-merge-assertions.test-support.js";
import { createMergeOutcomeFixtureHarness } from "./pr-merge-outcome.test-support.js";

const { fixture, expectNoProbeFetch, outcomeRef, describePosix, supportsNoLazyFetch } =
  createMergeOutcomeFixtureHarness();

describePosix("native merge outcome with real Git and supervised lock recovery", () => {
  it.each([
    { method: "squash", queue: false, comment: "Merged via squash." },
    { method: "merge", queue: false, comment: "Merged via merge commit." },
    { method: "rebase", queue: false, comment: "Merged via rebase." },
    { method: "squash", queue: true, comment: "Merged via merge queue (requested squash)." },
  ])("completes $method/queue=$queue across final main advance", ({ method, queue, comment }) => {
    const f = fixture(undefined, [["prefix\n"], ["after\n"]]);
    const main = f.advance("before\n");
    configureMerge(f, {
      landing: queue ? "rebase" : "requested",
      pr: { isMergeQueueEnabled: queue },
      observations: [
        {},
        {},
        ...(method === "squash" && !queue ? [] : [{}]),
        {},
        { advanceMain: true, advanceAfterRead: true },
      ],
    });
    expectExit(f.run(false, f.repo, method), 0);
    const state = f.state();
    const submissions = state.calls.filter((call) => call[1] === "pr" && call[2] === "merge");
    if (method === "squash" && !queue) {
      expect(submissions).toHaveLength(0);
      expect(state.graphqlMergePayloads).toEqual([
        {
          pullRequestId: "fixture-pr",
          expectedHeadOid: f.head,
          mergeMethod: "SQUASH",
          commitBody: "Fixture body\n",
        },
      ]);
    } else {
      expect(submissions).toHaveLength(1);
      expect(
        submissions[0]?.filter((arg) => ["--squash", "--merge", "--rebase"].includes(arg)),
      ).toEqual([`--${method}`]);
    }
    const landed = state.pr.mergeCommit!.oid;
    expect(state).toMatchObject({
      observationReads: method === "squash" && !queue ? 4 : 5,
      mutations: 1,
      posts: 1,
    });
    expect(state.mainAdvances).toHaveLength(2);
    expect(f.record()).toMatchObject({ phase: "complete", landed, head: f.head });

    expect(state.comments[0]!.body).toContain(comment);
    expect(state.comments[0]!.body).toContain(`/commit/${landed}`);
    expect(existsSync(f.worktree)).toBe(false);
    expect(() =>
      f.git(["--git-dir=" + f.remote, "rev-parse", "--verify", "refs/heads/topic"]),
    ).toThrow();
    f.git(["merge-base", "--is-ancestor", landed, outcomeRef]);
    f.git(["merge-base", "--is-ancestor", f.head, outcomeRef]);
    expect(f.git(["show", `${landed}:owner.txt`])).toBe("after");
    if (method === "rebase" || queue) {
      const rewritten = f.git(["rev-list", "--reverse", `${main}..${landed}`]).split("\n");
      expect(rewritten).toHaveLength(2);
      expect(rewritten.every((oid) => !f.sourceCommits.includes(oid))).toBe(true);
      expect(f.git(["show", `${landed}:sibling.txt`])).toBe("advanced");
      // The final parent is only the rewritten prefix, not the base of the series.
      expect(() => f.git(["merge-tree", "--write-tree", `${landed}^`, f.head])).toThrow();
      // The final observation advanced the remote again after its returned snapshot.
      f.git([
        "fetch",
        "--no-tags",
        "origin",
        f.git(["--git-dir=" + f.remote, "rev-parse", "main"]),
      ]);
      f.advance("before\n");
      expect(f.run().status).toBe(0);
      expect(f.state()).toMatchObject({ mutations: 1, posts: 1 });
    }
  });

  it.skipIf(!supportsNoLazyFetch)(
    "retains accepted intent across final main advance without replay",
    () => {
      const f = fixture(undefined, undefined, true);
      configureMerge(f, { mode: "pending", pr: { isMergeQueueEnabled: true } });
      const { previous, captures: capture } = retainIntent(f, 0);
      const landed = f.git(
        [
          "--git-dir=" + f.remote,
          "commit-tree",
          f.git(["rev-parse", `${f.head}^{tree}`]),
          "-p",
          f.base,
        ],
        "Remote-only landing after partial clone\n",
      );
      f.git(["--git-dir=" + f.remote, "update-ref", "refs/heads/main", landed]);
      expect(() => f.git(["--no-lazy-fetch", "cat-file", "-e", `${landed}^{commit}`])).toThrow();
      observeMerged(f, landed, {
        observationReads: 0,
        observations: [{}, { advanceMain: true, advanceAfterRead: true }],
        pr: { autoMergeRequest: null, isInMergeQueue: false },
      });
      const run = expectExit(f.run(), 0);
      expect(run.output).toContain("completion pending");
      expect(f.record()).toMatchObject({ phase: "merged", accepted: true, landed, main: f.base });
      expect(f.state()).toMatchObject({ observationReads: 2, mutations: 1, posts: 0 });
      expect(f.captures()).toEqual(capture);
      expect(existsSync(f.worktree)).toBe(true);
      expect(f.git(["--git-dir=" + f.remote, "rev-parse", "topic"])).toBe(f.head);
      f.git(["merge-base", "--is-ancestor", previous, outcomeRef]);
      f.git(["merge-base", "--is-ancestor", landed, outcomeRef]);
      const trace = f.trace();
      const explicitFetches = trace.filter(
        (event) =>
          event.event === "start" &&
          event.argv?.includes("fetch") &&
          event.argv.includes("https://github.com/fixture/repo"),
      );
      expect(explicitFetches.map((event) => event.argv!.at(-1))).toEqual([
        landed,
        f.state().mainAdvances[0],
      ]);
      expectNoProbeFetch(trace);
    },
  );

  it.each([
    "id",
    "head",
    "base",
    "state",
    "mergeCommit",
    "draft",
    "mergeable",
    "status",
    "auto",
    "queue",
    "queue-policy",
    "backward-main",
    "rewritten-main",
    "unrelated-main",
    "invalid",
    "unavailable",
    "missing-main",
  ])("preserves intent on final receipt %s drift", (fault) => {
    const f = configuredFixture(fixture, { mode: "pending", pr: { isMergeQueueEnabled: true } });
    const { previous: before, captures: capture } = retainIntent(f, 0);
    const landed = f.advance("after\n", "stable\n");
    const changes: Record<string, Record<string, unknown>> = {
      id: { id: "different-pr" },
      head: { headRefOid: f.base },
      base: { baseRefName: "release" },
      state: { state: "CLOSED", mergeCommit: null },
      mergeCommit: { mergeCommit: { oid: f.head } },
      draft: { isDraft: true },
      mergeable: { mergeable: "UNKNOWN" },
      status: { mergeStateStatus: "UNKNOWN" },
      auto: { autoMergeRequest: { mergeMethod: "MERGE" } },
      queue: { isInMergeQueue: true },
      "queue-policy": { isMergeQueueEnabled: false },
    };
    if (fault === "rewritten-main") {
      f.advance("after\n", "observed-main\n");
    }
    const step: ReturnType<typeof f.state>["observations"][number] = {
      advanceMain: true,
      pr: changes[fault],
    };
    if (fault.endsWith("-main")) {
      step.advanceMain = false;
      step.main =
        fault === "backward-main"
          ? f.base
          : f.commit(
              f.tree("after\n"),
              fault === "rewritten-main" ? [landed] : [],
              "Rewritten main\n",
            );
      if (fault === "missing-main") {
        // Advertise a syntactically valid tip whose object is unavailable remotely.
        step.reportedMain = "1".repeat(40);
        step.main = undefined;
      }
    }
    if (fault === "invalid") {
      step.invalid = true;
    }
    if (fault === "unavailable") {
      step.unavailable = true;
    }
    observeMerged(f, landed, {
      observationReads: 0,
      observations: [{}, step],
      pr: { autoMergeRequest: null, isInMergeQueue: false },
    });
    expectExit(f.run(), 1);
    expectRetained(f, before, capture);
    expect(f.state()).toMatchObject({ mutations: 1, posts: 0 });
    expect(existsSync(f.worktree)).toBe(true);
  });

  it.each(["OPEN", "CLOSED", "pending"])(
    "requires final snapshot stability for retained %s",
    (state) => {
      const f = configuredFixture(fixture, { mode: "pending", pr: { isMergeQueueEnabled: true } });
      const { previous: before } = retainIntent(f, 0);
      configureMerge(f, {
        pr: {
          state: state === "pending" ? "OPEN" : state,
          autoMergeRequest: state === "pending" ? { mergeMethod: "SQUASH" } : null,
          isInMergeQueue: state === "pending",
        },
        observations: [{}, { advanceMain: true }],
      });
      const run = expectExit(f.run(), 1);
      expect(run.output).toContain("PR or main changed during observation");
      expect(run.output).toContain(`Local outcome ref ${outcomeRef}: present`);
      expect(run.output).toContain("investigate; see scripts/AGENTS.md merge-outcome doctrine");
      expect(run.output).not.toContain("rerun merge-run; if the operation lock was retained");
      expect(f.git(["rev-parse", outcomeRef])).toBe(before);
      expect(f.state()).toMatchObject({ mutations: 1, posts: 0 });
    },
  );

  it
    .skipIf(!supportsNoLazyFetch)
    .each([
      "historical-main",
      "record-blob",
      "record-tree",
      "record-commit",
      "recovery-blob",
      "recovery-tree",
      "recovery-commit",
    ])("rejects missing local %s without promisor hydration", (fault) => {
    const f = fixture(undefined, undefined, true);
    const recovery = fault.startsWith("recovery-");
    configureMerge(f, {
      mode: recovery ? "unapplied" : "pending",
      pr: { isMergeQueueEnabled: !recovery },
    });
    expectExit(f.run(), recovery ? 1 : 0);
    f.recover();
    const capture = f.captures();
    let retained = outcomeRef;
    if (recovery) {
      // A successor retains the exact unaccepted intent; its provenance must
      // already be local, even when a promisor could supply the missing bytes.
      retained = f.git(["rev-parse", outcomeRef]);
      const original = f.record();
      const record = {
        ...original,
        recovery: {
          outcome: retained,
          attempt: original.attempt,
          actor: "fixture-operator",
          reason: "explicit-operator-recovery",
        },
      };
      const blob = f.git(["hash-object", "-w", "--stdin"], JSON.stringify(record));
      const tree = f.git(["mktree"], `100644 blob ${blob}\toutcome.json\n`);
      f.git(["update-ref", outcomeRef, f.commit(tree, [f.head, f.base, retained])]);
    }
    let missing: string;
    if (fault === "historical-main") {
      missing = f.git(
        [
          "--git-dir=" + f.remote,
          "commit-tree",
          f.git(["rev-parse", `${f.base}^{tree}`]),
          "-p",
          f.base,
        ],
        "Future remote main\n",
      );
      f.git(["--git-dir=" + f.remote, "update-ref", "refs/heads/main", missing]);
      const blob = f.git(
        ["hash-object", "-w", "--stdin"],
        JSON.stringify({ ...f.record(), main: missing }),
      );
      const tree = f.git(["mktree"], `100644 blob ${blob}\toutcome.json\n`);
      const record = f.git(
        ["hash-object", "-t", "commit", "-w", "--stdin"],
        `tree ${tree}\nparent ${f.head}\nparent ${missing}\nauthor Fixture <fixture@example.invalid> 1 +0000\ncommitter Fixture <fixture@example.invalid> 1 +0000\n\nRetained missing main\n`,
      );
      f.git(["update-ref", outcomeRef, record]);
    } else {
      missing = f.git([
        "rev-parse",
        retained +
          (fault.endsWith("-blob") ? ":outcome.json" : fault.endsWith("-tree") ? "^{tree}" : ""),
      ]);
      f.git(["push", "-q", "origin", `${outcomeRef}:refs/heads/retained-proof`]);
      rmSync(join(f.repo, ".git/objects", missing.slice(0, 2), missing.slice(2)));
    }
    expect(() => f.git(["--no-lazy-fetch", "cat-file", "-e", missing])).toThrow();
    const before = f.git(["rev-parse", outcomeRef]);
    const reads = f.state().observationReads;
    const run = f.run();
    expectNoProbeFetch(f.trace());
    expect(run.status, run.output).toBe(1);
    expect(f.state().observationReads).toBe(reads);
    expectRetained(f, before, capture);
    expect(existsSync(f.worktree)).toBe(true);
    expect(f.git(["--git-dir=" + f.remote, "rev-parse", "topic"])).toBe(f.head);
    expect(f.state()).toMatchObject({ mutations: 1, posts: 0 });
    expect(() => f.git(["--no-lazy-fetch", "cat-file", "-e", missing])).toThrow();
    // Removing an ancestor invalidates Git's negotiated "have" graph. Refetch
    // this synthetic hole without changing ordinary authoritative-main fetches.
    f.git([
      "fetch",
      ...(fault === "recovery-commit" ? ["--refetch"] : []),
      "--no-tags",
      "--no-write-fetch-head",
      "https://github.com/fixture/repo",
      missing,
    ]);
    f.git(["--no-lazy-fetch", "cat-file", "-e", missing]);
  });

  it("reconciles merged receipts before mergeability settles", () => {
    const f = fixture();
    const unknown = { pr: { mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" } };
    configureMerge(f, { observations: [{}, {}, unknown, unknown] });
    expectExit(f.run(), 0);
    expect(f.record().phase).toBe("complete");
    expect(f.state()).toMatchObject({ observationReads: 4, settlementSleeps: [] });
    expect(f.state()).toMatchObject({ mutations: 1, posts: 1 });
  });

  it.each(["rebase", "merge"])("rejects mismatched %s receipts before completion", (method) => {
    const f = fixture(undefined, [["prefix\n"], ["after\n"]]);
    f.advance("before\n");
    configureMerge(f, { landing: "mismatch" });
    expectExit(f.run(false, f.repo, method), 1);
    expect(f.record()).toMatchObject({ phase: "intent", landed: null });
    expect(f.state().posts).toBe(0);
    expect(existsSync(f.worktree)).toBe(true);
    expect(f.git(["--git-dir=" + f.remote, "rev-parse", "topic"])).toBe(f.head);
    f.recover();
    expect(f.run().status).toBe(1);
    expect(f.state().mutations).toBe(1);
  });

  it("rejects a cherry-picked prefix as the source fork base", () => {
    const f = fixture(undefined, [["after\n"], ["after\n", "reviewed\n"]]);
    const main = f.advance("after\n", "stable\n");
    expect(main).not.toBe(f.sourceCommits[0]);
    expect(f.git(["merge-base", main, f.head])).toBe(f.base);
    configureMerge(f, { mode: "unapplied" });
    expect(f.run(false, f.repo, "rebase").status).toBe(1);
    f.recover();
    const landed = f.advance("before\n", "reviewed\n");
    expect(f.git(["merge-tree", "--write-tree", `--merge-base=${main}`, landed, f.head])).toBe(
      f.git(["rev-parse", `${landed}^{tree}`]),
    );
    observeMerged(f, landed);
    expectExit(f.run(), 1);
    expect(f.record()).toMatchObject({ phase: "intent", landed: null });
    expect(f.state()).toMatchObject({ posts: 0, mutations: 1 });
  });

  it.each(["multiple", "missing"])("refuses a %s source fork base", (fault) => {
    const f = configuredFixture(fixture, { mode: "unapplied" });
    expect(f.run(false, f.repo, "rebase").status).toBe(1);
    f.recover();
    const other = f.commit(f.tree("before\n", "branch\n"), [f.base]);
    const head = f.commit(f.tree("after\n", "branch\n"), [f.head, other], "Source merge\n");
    const main = f.commit(
      f.tree("after\n", "branch\n"),
      fault === "multiple" ? [other, f.head] : [],
      "Main merge\n",
    );
    // A valid retained record with criss-cross (or unrelated) source/main history.
    const previous = f.git(["rev-parse", outcomeRef]);
    const record = { ...f.record(), head, localHead: head, main };
    const blob = f.git(["hash-object", "-w", "--stdin"], JSON.stringify(record));
    const tree = f.git(["mktree"], `100644 blob ${blob}\toutcome.json\n`);
    f.git(["update-ref", outcomeRef, f.commit(tree, [head, main, previous])]);
    const landed = f.commit(f.git(["rev-parse", `${head}^{tree}`]), [main]);
    f.git(["push", "-q", "--force", "origin", `${landed}:refs/heads/main`]);
    observeMerged(f, landed, { pr: { headRefOid: head } });
    const run = expectExit(f.run(), 1);
    expect(run.output).toContain("require one source fork base");
    expect(f.record()).toEqual(record);
    expect(f.state()).toMatchObject({ posts: 0, mutations: 1 });
  });

  it.each([false, true])("rejects an ancestral-head revert receipt with queue=%s", (queue) => {
    const f = configuredFixture(fixture, {
      mode: "unapplied",
      pr: { isMergeQueueEnabled: queue },
    });
    expect(f.run(false, f.repo, queue ? "merge" : "rebase").status).toBe(1);
    f.recover();
    f.git(["push", "-q", "origin", `${f.head}:refs/heads/main`]);
    const landed = f.advance("before\n");
    expect(f.git(["merge-tree", "--write-tree", landed, f.head])).toBe(
      f.git(["rev-parse", `${landed}^{tree}`]),
    );
    observeMerged(f, landed);
    expectExit(f.run(), 1);
    expect(f.record()).toMatchObject({ phase: "intent", landed: null });
    expect(f.state()).toMatchObject({ posts: 0, mutations: 1 });
    expect(existsSync(f.worktree)).toBe(true);
  });

  it("retains an empty-squash receipt after a later revert", () => {
    const f = configuredFixture(fixture, { mode: "unapplied" });
    expect(f.run().status).toBe(1);
    f.recover();
    const patch = f.advance("after\n", "stable\n");
    const landed = f.commit(f.git(["rev-parse", patch + "^{tree}"]), [patch], "Empty squash\n");
    f.git(["push", "-q", "origin", landed + ":refs/heads/main"]);
    observeMerged(f, landed);
    const confirmed = expectExit(f.run(), 0);
    expect(confirmed.output).toContain(
      "Warning: recorded squash has no net change at its landed parent",
    );
    expect(f.record()).toMatchObject({ phase: "merged", landed });
    const receipt = f.git(["rev-parse", outcomeRef]);
    const reverted = f.advance("before\n", "stable\n");
    const resumed = expectExit(f.run(), 0);
    expect(resumed.output).toContain(
      "Warning: recorded squash has no net change at its landed parent",
    );
    expect(f.git(["rev-parse", outcomeRef])).toBe(receipt);
    expect(f.git(["--git-dir=" + f.remote, "rev-parse", "main"])).toBe(reverted);
    expect(f.state()).toMatchObject({ mutations: 1, posts: 0 });
  });

  it.each(["unapplied", "applied-open"])(
    "retains %s uncertainty through missing worktree and receipt",
    (mode) => {
      const f = configuredFixture(fixture, { mode });
      expect(f.run().status).toBe(1);
      f.recover();
      f.git(["worktree", "remove", "--force", f.worktree]);
      expectExit(f.run(), 1);
      f.recover();
      const landed =
        mode === "unapplied"
          ? f.advance("after\n", "stable\n")
          : f.git(["--git-dir=" + f.remote, "rev-parse", "main"]);
      observeMerged(f, landed);
      const confirmed = expectExit(f.run(), 0);
      expect(f.state()).toMatchObject({ mutations: 1, posts: 0 });
      expect(confirmed.output).toContain("completion pending");
      expect(f.record().phase).toBe("merged");
    },
  );
});
