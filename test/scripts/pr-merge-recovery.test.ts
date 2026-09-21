import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createMergeOutcomeFixtureHarness } from "./pr-merge-outcome.test-support.js";

const { fixture, outcomeRef, describePosix } = createMergeOutcomeFixtureHarness();

describePosix("native merge outcome with real Git and supervised lock recovery", () => {
  it("reconciles uncertain dispatch without the body and accepts a body only for explicit recovery", () => {
    const f = fixture();
    const body = join(f.repo, "body.md");
    writeFileSync(body, "First message");
    f.save({ ...f.state(), mode: "unapplied" });
    const first = f.run(false, f.repo, "squash", "", "", body);
    expect(first.status, first.output).not.toBe(0);
    const previous = f.git(["rev-parse", outcomeRef]);
    rmSync(body);
    f.recover();
    const resumed = f.run(false, f.repo, "squash", "", "", body);
    expect(resumed.status, resumed.output).not.toBe(0);
    expect(resumed.output).not.toContain("Cannot prepare merge body");
    expect(f.state().mutations).toBe(1);
    expect(f.git(["rev-parse", outcomeRef])).toBe(previous);
    f.recover();
    writeFileSync(body, "Corrected retry message");
    f.save({ ...f.state(), mode: "success" });
    const recovered = f.run(false, f.repo, "squash", previous, "", body);
    expect(recovered.status, recovered.output).toBe(0);
    expect(f.state().mergeBody).toBe("Corrected retry message");
    expect(f.state().mutations).toBe(2);
  });

  it.each([
    { replacement: false, reviewHead: "current", forwardMain: false },
    { replacement: true, reviewHead: "current", forwardMain: false },
    { replacement: true, reviewHead: "previous", forwardMain: false },
    { replacement: false, reviewHead: "current", forwardMain: true },
    { replacement: true, reviewHead: "current", forwardMain: true },
  ])(
    "operator recovery preserves evidence and consumes one exact attempt (replacement=$replacement, review=$reviewHead, forward main=$forwardMain)",
    ({ replacement, reviewHead, forwardMain }) => {
      const f = fixture();
      f.save({ ...f.state(), mode: "unapplied" });
      expect(f.run().status).toBe(1);
      const previous = f.git(["rev-parse", outcomeRef]);
      const previousRecord = f.record();
      if (replacement) {
        // Configure the byte-filter sentinel without adding unpublished work.
        writeFileSync(join(f.repo, ".git/info/attributes"), "*.log text eol=lf\n");
        const capture = join(f.worktree, ".local", f.captures()[0]![0]);
        writeFileSync(capture, readFileSync(capture, "utf8") + "Capture byte sentinel\r\n");
      }
      const captures = f.captures();
      expect(captures).toHaveLength(1);
      f.recover();
      const approvedHead = replacement ? f.replacePreparedHead() : f.head;
      if (replacement) {
        expect(() => f.git(["merge-tree", "--write-tree", `${approvedHead}^`, f.head])).toThrow();
      }
      // Same-head recovery keeps its disk capture; replacement also proves retention after cleanup.
      const next = f.state();
      next.mode = "success";
      next.comment = replacement ? "success" : "rejected";
      if (forwardMain) {
        const parent = f.git(["--git-dir=" + f.remote, "rev-parse", "main"]);
        const main = f.commit(
          f.git(["rev-parse", `${parent}^{tree}`]),
          [parent],
          "Admission advance\n",
        );
        next.observations = [{}, { main }, {}, { advanceMain: true, advanceAfterRead: true }];
      }
      if (reviewHead === "previous") {
        next.issueComments[0]!.body = next.issueComments[0]!.body.replace(approvedHead, f.head);
      }
      f.save(next);
      const recovered = f.run(false, f.repo, "squash", previous, replacement ? approvedHead : "");
      expect(recovered.status, recovered.output).toBe(replacement ? 0 : 1);
      expect(f.state().mutations, recovered.output).toBe(2);
      expect(f.state().mainAdvances).toHaveLength(forwardMain ? 2 : 0);
      expect(f.record()).toMatchObject({
        phase: replacement ? "complete" : "commenting",
        head: approvedHead,
        clawsweeperReview: { reviewedSha: reviewHead === "previous" ? f.head : approvedHead },
        recovery: {
          outcome: previous,
          attempt: previousRecord.attempt,
          actor: "fixture-operator",
          reason: "explicit-operator-recovery",
          ...(replacement ? { replacementHead: approvedHead } : {}),
        },
      });
      expect(f.git(["show", `${f.record().landed}:owner.txt`])).toBe(
        replacement ? "reviewed replacement" : "after",
      );
      expect(JSON.parse(f.git(["show", `${previous}:outcome.json`]))).toEqual(previousRecord);
      f.git(["merge-base", "--is-ancestor", previous, outcomeRef]);
      const successor = f
        .git(["rev-list", "--ancestry-path", "--reverse", `${previous}..${outcomeRef}`])
        .split("\n")[0]!;
      for (const [name, contents] of captures) {
        if (replacement) {
          expect(f.git(["rev-parse", `${successor}:${name}`])).toBe(
            f.git(["hash-object", "--stdin"], contents),
          );
        } else {
          expect(readFileSync(join(f.worktree, ".local", name), "utf8")).toBe(contents);
        }
      }
      if (!replacement) {
        expect(f.captures()).toHaveLength(2);
      }
      const dispatches = f.state().graphqlMergePayloads;
      expect(dispatches).toHaveLength(2);
      expect(dispatches[1]!.expectedHeadOid).toBe(approvedHead);
      f.recover();
      const resumed = f.run();
      expect(resumed.status, resumed.output).toBe(0);
      const replay = f.run(false, f.repo, "squash", previous, replacement ? approvedHead : "");
      expect(replay.status, replay.output).toBe(1);
      expect(f.state().mutations).toBe(2);
      expect(f.state().posts).toBe(1);
      if (!replacement) {
        f.git(["worktree", "remove", "--force", f.worktree]);
      }
      for (const ref of [
        "refs/heads/topic",
        "refs/heads/pr-123",
        "refs/heads/pr-123-prep",
        "refs/remotes/origin/topic",
      ]) {
        f.git(["update-ref", "-d", ref]);
      }
      f.git(["reflog", "expire", "--expire=now", "--all"]);
      f.git(["gc", "--prune=now"]);
      for (const oid of [previous, previousRecord.head, previousRecord.main, approvedHead]) {
        f.git(["cat-file", "-e", `${oid}^{commit}`]);
      }
      expect(JSON.parse(f.git(["show", `${previous}:outcome.json`]))).toEqual(previousRecord);
      if (replacement) {
        for (const [name, contents] of captures) {
          expect(f.git(["rev-parse", `${successor}:${name}`])).toBe(
            f.git(["hash-object", "--stdin"], contents),
          );
        }
      }
    },
  );

  it.each(
    [
      "stale-outcome",
      "accepted",
      "auto-route",
      "queue-route",
      "admin-route",
      "review",
      "checks",
      "pending",
      "current-queue",
      "current-admin",
      "prepared-head",
      "method",
      "operator",
      "successor",
      "no-net-change",
      "wrong-pr",
      "wrong-repo",
      "current-auto",
      "current-queued",
    ].flatMap((fault) => [false, true].map((replacement) => ({ fault, replacement }))),
  )(
    "operator recovery refuses $fault without another dispatch (replacement=$replacement)",
    ({ fault, replacement }) => {
      const f = fixture();
      const initial = f.state();
      initial.mode = fault === "accepted" ? "pending" : "unapplied";
      if (fault === "auto-route") {
        initial.pr.mergeStateStatus = "BEHIND";
      }
      if (fault === "queue-route") {
        initial.pr.isMergeQueueEnabled = true;
      }
      if (fault === "admin-route") {
        initial.admin = true;
        initial.gates = "fail";
      }
      f.save(initial);
      const first = f.run(fault === "auto-route");
      expect(first.status, first.output).toBe(fault === "accepted" ? 0 : 1);
      const previous = f.git(["rev-parse", outcomeRef]);
      const captures = f.captures();
      f.recover();
      const approvedHead = replacement ? f.replacePreparedHead() : "";
      const next = f.state();
      next.mode = "success";
      next.admin = false;
      next.gates = "pass";
      next.pr.autoMergeRequest = null;
      next.pr.isInMergeQueue = false;
      next.pr.isMergeQueueEnabled = false;
      next.pr.mergeStateStatus = "CLEAN";
      if (fault === "wrong-pr") {
        next.pr.id = "other-pr";
      }
      if (fault === "wrong-repo") {
        next.repoAuthority.node_id = "other-repo";
      }
      if (fault === "current-auto") {
        next.pr.autoMergeRequest = { mergeMethod: "SQUASH" };
      }
      if (fault === "current-queued") {
        next.pr.isInMergeQueue = true;
      }
      if (fault === "review") {
        next.review = false;
      }
      if (fault === "checks") {
        next.gates = "fail";
      }
      if (fault === "pending") {
        next.gates = "pending";
      }
      if (fault === "current-queue") {
        next.pr.isMergeQueueEnabled = true;
      }
      if (fault === "current-admin") {
        next.admin = true;
        next.gates = "fail";
      }
      if (fault === "operator") {
        next.operator = "";
      }
      if (fault === "successor") {
        next.crash = "successor";
      }
      if (fault === "no-net-change") {
        f.advance(replacement ? "reviewed replacement\n" : "after\n", "stable\n");
      }
      if (fault === "prepared-head") {
        next.pr.headRefOid = f.base;
        f.git(["-C", f.worktree, "checkout", "--detach", f.base]);
        writeFileSync(
          join(f.worktree, ".local/prep.env"),
          `PREP_HEAD_SHA=${f.base}\nLOCAL_PREP_HEAD_SHA=${f.base}\nPREP_MAINLINE_BASE_SHA=${f.base}\n`,
        );
      }
      f.save(next);
      const result = f.run(
        false,
        f.repo,
        fault === "method" ? "merge" : "squash",
        fault === "stale-outcome" ? f.base : previous,
        approvedHead,
      );
      expect(result.status, result.output).toBe(1);
      expect(f.state().mutations, result.output).toBe(1);
      expect(f.state().posts).toBe(0);
      expect(f.captures()).toEqual(captures);
      if (fault === "successor") {
        expect(f.git(["cat-file", "blob", outcomeRef])).toBe("successor");
      } else {
        expect(f.git(["rev-parse", outcomeRef])).toBe(previous);
      }
    },
  );

  it.each([
    "missing-approval",
    "wrong-approval",
    "malformed-approval",
    "review-json",
    "meta-head",
    "prep-context",
    "prep-head",
    "gate-head",
    "missing-context",
    "pending-gate",
    "ci-proof",
    "expired-clawsweeper",
    "head-during-checks",
    "prep.env",
    "gates.env",
    "review.json",
  ])("replacement recovery refuses stale or unapproved evidence: %s", (fault) => {
    const f = fixture();
    f.save({ ...f.state(), mode: "unapplied" });
    expect(f.run().status).toBe(1);
    const previous = f.git(["rev-parse", outcomeRef]);
    const captures = f.captures();
    f.recover();
    const approvedHead = f.replacePreparedHead();
    const next = f.state();
    next.mode = "success";
    if (fault === "ci-proof") {
      next.ciExit = 15;
    }
    if (fault === "expired-clawsweeper") {
      const expired = new Date(Date.now() - 13 * 60 * 60_000).toISOString();
      next.issueComments[0]!.body = next.issueComments[0]!.body.replace(
        /reviewed_at=\S+/u,
        `reviewed_at=${expired}`,
      );
    }
    if (fault === "head-during-checks") {
      next.duringChecks = { head: f.head };
    }
    if (["prep.env", "gates.env", "review.json"].includes(fault)) {
      next.duringChecks = { artifact: fault };
    }
    f.save(next);
    const staleArtifact: Record<string, string> = {
      "review-json": "review.json",
      "meta-head": "pr-meta.env",
      "prep-context": "prep-context.env",
      "prep-head": "prep.env",
      "gate-head": "gates.env",
    };
    if (staleArtifact[fault]) {
      const file = join(f.worktree, ".local", staleArtifact[fault]);
      writeFileSync(file, readFileSync(file, "utf8").replaceAll(approvedHead, f.head));
    }
    if (fault === "missing-context") {
      rmSync(join(f.worktree, ".local/prep-context.env"));
    }
    if (fault === "pending-gate") {
      const file = join(f.worktree, ".local/gates.env");
      writeFileSync(
        file,
        readFileSync(file, "utf8").replace(
          "GATES_MODE=full",
          "GATES_MODE=remote_crabbox_aws_pending",
        ),
      );
    }
    const approval =
      fault === "missing-approval"
        ? ""
        : fault === "wrong-approval"
          ? f.head
          : fault === "malformed-approval"
            ? "HEAD"
            : approvedHead;
    const run = f.run(false, f.repo, "squash", previous, approval);
    expect(run.status, run.output).toBe(fault === "malformed-approval" ? 2 : 1);
    expect(f.state().mutations, run.output).toBe(1);
    expect(f.state().posts).toBe(0);
    expect(f.git(["rev-parse", outcomeRef])).toBe(previous);
    expect(f.captures()).toEqual(captures);
  });

  it.each([false, true])(
    "does not overwrite or read a capture symlink (target exists=%s)",
    (exists) => {
      const f = fixture();
      const target = join(f.root, "capture-target");
      if (exists) {
        writeFileSync(target, "existing capture sentinel\n");
      }
      f.save({ ...f.state(), crash: "capture" });
      const run = f.run();
      expect(run.status, run.output).toBe(1);
      expect(f.state().mutations).toBe(0);
      expect(f.state().posts).toBe(0);
      expect(f.record()).toMatchObject({ phase: "intent", accepted: false });
      expect(run.output).not.toContain("existing capture sentinel");
      expect(existsSync(target)).toBe(exists);
      if (exists) {
        expect(readFileSync(target, "utf8")).toBe("existing capture sentinel\n");
      }
      f.recover();
      expect(f.run().status).toBe(1);
      expect(f.state().mutations).toBe(0);
    },
  );
});
