import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createMergeOutcomeFixtureHarness } from "./pr-merge-outcome.test-support.js";

const { fixture, expectNoProbeFetch, outcomeRef, describePosix, supportsNoLazyFetch } =
  createMergeOutcomeFixtureHarness();

describePosix("native merge outcome with real Git and supervised lock recovery", () => {
  it.each([
    { method: "squash", queue: false, comment: "Merged via squash." },
    { method: "merge", queue: false, comment: "Merged via merge commit." },
    { method: "rebase", queue: false, comment: "Merged via rebase." },
    { method: "squash", queue: true, comment: "Merged via merge queue (requested squash)." },
  ])(
    "completes $method/queue=$queue with forward main during final receipt observation",
    ({ method, queue, comment }) => {
      const f = fixture(undefined, [["prefix\n"], ["after\n"]]);
      f.advance("before\n");
      f.save({
        ...f.state(),
        landing: queue ? "rebase" : "requested",
        pr: { ...f.state().pr, isMergeQueueEnabled: queue },
        observations: [
          {},
          {},
          ...(method === "squash" && !queue ? [] : [{}]),
          {},
          { advanceMain: true, advanceAfterRead: true },
        ],
      });
      const run = f.run(false, f.repo, method);
      expect(run.status, run.output).toBe(0);
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
      expect(state.observationReads).toBe(method === "squash" && !queue ? 4 : 5);
      expect(state.mainAdvances).toHaveLength(2);
      expect(f.record()).toMatchObject({ phase: "complete", landed, head: f.head });
      expect(state.mutations).toBe(1);
      expect(state.posts).toBe(1);
      expect(state.comments[0]!.body).toContain(comment);
      expect(state.comments[0]!.body).toContain(`/commit/${landed}`);
      expect(existsSync(f.worktree)).toBe(false);
      expect(() =>
        f.git(["--git-dir=" + f.remote, "rev-parse", "--verify", "refs/heads/topic"]),
      ).toThrow();
      f.git(["merge-base", "--is-ancestor", landed, outcomeRef]);
      f.git(["merge-base", "--is-ancestor", f.head, outcomeRef]);
      expect(f.git(["show", `${landed}:owner.txt`])).toBe("after");
    },
  );

  it.skipIf(!supportsNoLazyFetch)(
    "recovers accepted intent with forward main during final receipt observation without replaying completion",
    () => {
      const f = fixture(undefined, undefined, true);
      f.save({ ...f.state(), mode: "pending", pr: { ...f.state().pr, isMergeQueueEnabled: true } });
      const pending = f.run();
      expect(pending.status, pending.output).toBe(0);
      const previous = f.git(["rev-parse", outcomeRef]);
      const capture = f.captures();
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
      f.save({
        ...f.state(),
        observationReads: 0,
        pr: {
          ...f.state().pr,
          state: "MERGED",
          mergeCommit: { oid: landed },
          autoMergeRequest: null,
          isInMergeQueue: false,
        },
        observations: [{}, { advanceMain: true, advanceAfterRead: true }],
      });
      const run = f.run();
      expect(run.status, run.output).toBe(0);
      expect(run.output).toContain("completion pending");
      expect(f.record()).toMatchObject({ phase: "merged", accepted: true, landed, main: f.base });
      expect(f.state().observationReads).toBe(2);
      expect(f.state().mutations).toBe(1);
      expect(f.state().posts).toBe(0);
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
  ])("rejects %s drift during final receipt observation without overwriting intent", (fault) => {
    const f = fixture();
    f.save({ ...f.state(), mode: "pending", pr: { ...f.state().pr, isMergeQueueEnabled: true } });
    expect(f.run().status).toBe(0);
    const before = f.git(["rev-parse", outcomeRef]);
    const capture = f.captures();
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
    f.save({
      ...f.state(),
      observationReads: 0,
      pr: {
        ...f.state().pr,
        state: "MERGED",
        mergeCommit: { oid: landed },
        autoMergeRequest: null,
        isInMergeQueue: false,
      },
      observations: [{}, step],
    });
    const run = f.run();
    expect(run.status, run.output).toBe(1);
    expect(f.git(["rev-parse", outcomeRef])).toBe(before);
    expect(f.captures()).toEqual(capture);
    expect(f.state().mutations).toBe(1);
    expect(f.state().posts).toBe(0);
    expect(existsSync(f.worktree)).toBe(true);
  });

  it.each(["OPEN", "CLOSED", "pending"])(
    "keeps full snapshot stability for retained %s during final observation",
    (state) => {
      const f = fixture();
      f.save({ ...f.state(), mode: "pending", pr: { ...f.state().pr, isMergeQueueEnabled: true } });
      expect(f.run().status).toBe(0);
      const before = f.git(["rev-parse", outcomeRef]);
      f.save({
        ...f.state(),
        pr: {
          ...f.state().pr,
          state: state === "pending" ? "OPEN" : state,
          autoMergeRequest: state === "pending" ? { mergeMethod: "SQUASH" } : null,
          isInMergeQueue: state === "pending",
        },
        observations: [{}, { advanceMain: true }],
      });
      const run = f.run();
      expect(run.status, run.output).toBe(1);
      expect(run.output).toContain("PR or main changed during observation");
      expect(run.output).toContain(`Local outcome ref ${outcomeRef}: present`);
      expect(run.output).toContain("investigate; see scripts/AGENTS.md merge-outcome doctrine");
      expect(run.output).not.toContain("lock-recover, then rerun merge-run");
      expect(f.git(["rev-parse", outcomeRef])).toBe(before);
      expect(f.state().mutations).toBe(1);
      expect(f.state().posts).toBe(0);
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
    f.save({
      ...f.state(),
      mode: recovery ? "unapplied" : "pending",
      pr: { ...f.state().pr, isMergeQueueEnabled: !recovery },
    });
    const initial = f.run();
    expect(initial.status, initial.output).toBe(recovery ? 1 : 0);
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
    expect(f.git(["rev-parse", outcomeRef])).toBe(before);
    expect(f.captures()).toEqual(capture);
    expect(existsSync(f.worktree)).toBe(true);
    expect(f.git(["--git-dir=" + f.remote, "rev-parse", "topic"])).toBe(f.head);
    expect(f.state().mutations).toBe(1);
    expect(f.state().posts).toBe(0);
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

  it("reconciles a merged receipt without waiting for terminal mergeability", () => {
    const f = fixture();
    const unknown = { pr: { mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" } };
    f.save({ ...f.state(), observations: [{}, {}, unknown, unknown] });
    const run = f.run();
    expect(run.status, run.output).toBe(0);
    expect(f.record().phase).toBe("complete");
    expect(f.state().observationReads).toBe(4);
    expect(f.state().settlementSleeps).toEqual([]);
    expect(f.state().mutations).toBe(1);
    expect(f.state().posts).toBe(1);
  });

  it.each([false, true])("confirms a real multi-commit rebase with queue=%s", (queue) => {
    const f = fixture(undefined, [["prefix\n"], ["after\n"]]);
    const main = f.advance("before\n");
    f.save({
      ...f.state(),
      landing: "rebase",
      pr: { ...f.state().pr, isMergeQueueEnabled: queue },
    });
    const run = f.run(false, f.repo, queue ? "squash" : "rebase");
    const landed = f.state().pr.mergeCommit!.oid;
    const rewritten = f.git(["rev-list", "--reverse", `${main}..${landed}`]).split("\n");
    expect(rewritten).toHaveLength(2);
    expect(rewritten.every((oid) => !f.sourceCommits.includes(oid))).toBe(true);
    expect(f.git(["show", `${landed}:owner.txt`])).toBe("after");
    expect(f.git(["show", `${landed}:sibling.txt`])).toBe("advanced");
    // The final parent is only the rewritten prefix, not the base of the series.
    expect(() => f.git(["merge-tree", "--write-tree", `${landed}^`, f.head])).toThrow();
    expect(run.status, run.output).toBe(0);
    expect(f.record()).toMatchObject({ landed, phase: "complete" });
    f.advance("before\n");
    expect(f.run().status).toBe(0);
    expect(f.state().mutations).toBe(1);
    expect(f.state().posts).toBe(1);
  });

  it.each(["rebase", "merge"])(
    "rejects a mismatched %s receipt before comment or cleanup",
    (method) => {
      const f = fixture(undefined, [["prefix\n"], ["after\n"]]);
      f.advance("before\n");
      f.save({ ...f.state(), landing: "mismatch" });
      const run = f.run(false, f.repo, method);
      expect(run.status, run.output).toBe(1);
      expect(f.record()).toMatchObject({ phase: "intent", landed: null });
      expect(f.state().posts).toBe(0);
      expect(existsSync(f.worktree)).toBe(true);
      expect(f.git(["--git-dir=" + f.remote, "rev-parse", "topic"])).toBe(f.head);
      f.recover();
      expect(f.run().status).toBe(1);
      expect(f.state().mutations).toBe(1);
    },
  );

  it("checks the source fork base even when recorded main contains a cherry-picked prefix", () => {
    const f = fixture(undefined, [["after\n"], ["after\n", "reviewed\n"]]);
    const main = f.advance("after\n", "stable\n");
    expect(main).not.toBe(f.sourceCommits[0]);
    expect(f.git(["merge-base", main, f.head])).toBe(f.base);
    f.save({ ...f.state(), mode: "unapplied" });
    expect(f.run(false, f.repo, "rebase").status).toBe(1);
    f.recover();
    const landed = f.advance("before\n", "reviewed\n");
    expect(f.git(["merge-tree", "--write-tree", `--merge-base=${main}`, landed, f.head])).toBe(
      f.git(["rev-parse", `${landed}^{tree}`]),
    );
    f.save({
      ...f.state(),
      pr: { ...f.state().pr, state: "MERGED", mergeCommit: { oid: landed } },
    });
    const run = f.run();
    expect(run.status, run.output).toBe(1);
    expect(f.record()).toMatchObject({ phase: "intent", landed: null });
    expect(f.state().posts).toBe(0);
    expect(f.state().mutations).toBe(1);
  });

  it.each(["multiple", "missing"])("refuses a %s source fork base", (fault) => {
    const f = fixture();
    f.save({ ...f.state(), mode: "unapplied" });
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
    f.save({
      ...f.state(),
      pr: { ...f.state().pr, headRefOid: head, state: "MERGED", mergeCommit: { oid: landed } },
    });
    const run = f.run();
    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain("require one source fork base");
    expect(f.record()).toEqual(record);
    expect(f.state().posts).toBe(0);
    expect(f.state().mutations).toBe(1);
  });

  it.each([false, true])("rejects an ancestral-head revert receipt with queue=%s", (queue) => {
    const f = fixture();
    f.save({
      ...f.state(),
      mode: "unapplied",
      pr: { ...f.state().pr, isMergeQueueEnabled: queue },
    });
    expect(f.run(false, f.repo, queue ? "merge" : "rebase").status).toBe(1);
    f.recover();
    f.git(["push", "-q", "origin", `${f.head}:refs/heads/main`]);
    const landed = f.advance("before\n");
    expect(f.git(["merge-tree", "--write-tree", landed, f.head])).toBe(
      f.git(["rev-parse", `${landed}^{tree}`]),
    );
    f.save({
      ...f.state(),
      pr: { ...f.state().pr, state: "MERGED", mergeCommit: { oid: landed } },
    });
    const run = f.run();
    expect(run.status, run.output).toBe(1);
    expect(f.record()).toMatchObject({ phase: "intent", landed: null });
    expect(f.state().posts).toBe(0);
    expect(f.state().mutations).toBe(1);
    expect(existsSync(f.worktree)).toBe(true);
  });

  it("warns on a recorded empty squash and preserves its receipt after a later revert", () => {
    const f = fixture();
    f.save({ ...f.state(), mode: "unapplied" });
    expect(f.run().status).toBe(1);
    f.recover();
    const patch = f.advance("after\n", "stable\n");
    const landed = f.commit(f.git(["rev-parse", patch + "^{tree}"]), [patch], "Empty squash\n");
    f.git(["push", "-q", "origin", landed + ":refs/heads/main"]);
    f.save({
      ...f.state(),
      pr: { ...f.state().pr, state: "MERGED", mergeCommit: { oid: landed } },
    });
    const confirmed = f.run();
    expect(confirmed.status, confirmed.output).toBe(0);
    expect(confirmed.output).toContain(
      "Warning: recorded squash has no net change at its landed parent",
    );
    expect(f.record()).toMatchObject({ phase: "merged", landed });
    const receipt = f.git(["rev-parse", outcomeRef]);
    const reverted = f.advance("before\n", "stable\n");
    const resumed = f.run();
    expect(resumed.status, resumed.output).toBe(0);
    expect(resumed.output).toContain(
      "Warning: recorded squash has no net change at its landed parent",
    );
    expect(f.git(["rev-parse", outcomeRef])).toBe(receipt);
    expect(f.git(["--git-dir=" + f.remote, "rev-parse", "main"])).toBe(reverted);
    expect(f.state().mutations).toBe(1);
    expect(f.state().posts).toBe(0);
  });

  it.each(["unapplied", "applied-open"])(
    "keeps %s uncertainty through missing prep/worktree and eventual receipt",
    (mode) => {
      const f = fixture();
      f.save({ ...f.state(), mode });
      expect(f.run().status).toBe(1);
      f.recover();
      f.git(["worktree", "remove", "--force", f.worktree]);
      const unknown = f.run();
      expect(unknown.status, unknown.output).toBe(1);
      f.recover();
      const landed =
        mode === "unapplied"
          ? f.advance("after\n", "stable\n")
          : f.git(["--git-dir=" + f.remote, "rev-parse", "main"]);
      f.save({
        ...f.state(),
        pr: { ...f.state().pr, state: "MERGED", mergeCommit: { oid: landed } },
      });
      const confirmed = f.run();
      expect(confirmed.status, confirmed.output).toBe(0);
      expect(f.state().mutations).toBe(1);
      expect(f.state().posts).toBe(0);
      expect(confirmed.output).toContain("completion pending");
      expect(f.record().phase).toBe("merged");
    },
  );

  it.skipIf(!supportsNoLazyFetch)(
    "fetches immutable authoritative main explicitly without probe hydration",
    () => {
      const f = fixture(undefined, undefined, true);
      f.save({ ...f.state(), mode: "unapplied" });
      expect(f.run().status).toBe(1);
      f.recover();
      const landed = f.git(
        [
          "--git-dir=" + f.remote,
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          "commit-tree",
          f.git(["rev-parse", f.head + "^{tree}"]),
          "-p",
          f.base,
        ],
        "Remote-only landing\n",
      );
      f.git(["--git-dir=" + f.remote, "update-ref", "refs/heads/main", landed]);
      expect(() => f.git(["--no-lazy-fetch", "cat-file", "-e", landed])).toThrow();
      f.save({
        ...f.state(),
        pr: { ...f.state().pr, state: "MERGED", mergeCommit: { oid: landed } },
      });
      const retry = f.run();
      expectNoProbeFetch(f.trace());
      expect(retry.status, retry.output).toBe(0);
      f.git(["cat-file", "-e", landed]);
      expect(f.state().mutations).toBe(1);
    },
  );
});
