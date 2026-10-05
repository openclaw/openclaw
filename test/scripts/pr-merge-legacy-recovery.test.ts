import { existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createMergeOutcomeFixtureHarness } from "./pr-merge-outcome.test-support.js";

const { fixture, createLegacyRefusal, outcomeRef, describePosix } =
  createMergeOutcomeFixtureHarness();

describePosix("native merge outcome with real Git and supervised lock recovery", () => {
  it.each([false, true])(
    "retains qualified legacy evidence with successor recovery=%s",
    (recover) => {
      const f = fixture();
      const legacy = createLegacyRefusal(f);
      const approvedHead = f.replacePreparedHead();
      if (recover) {
        f.save({ ...f.state(), mode: "unapplied" });
      }
      const run = f.run(
        false,
        f.repo,
        "squash",
        legacy.oid,
        approvedHead,
        "",
        "",
        legacy.directory,
      );
      expect(run.status, run.output).toBe(recover ? 1 : 0);
      expect(f.state().mutations).toBe(1);
      const previous = f.git(["rev-parse", outcomeRef]);
      const previousRecord = f.record();
      expect(previousRecord).toMatchObject({
        phase: recover ? "intent" : "complete",
        head: approvedHead,
        legacyRefusal: {
          actor: "fixture-operator",
          kind: "gh-2.98-pre-dispatch-refusal",
          head: f.head,
          preparedBase: f.base,
        },
      });
      expect(previousRecord).not.toHaveProperty("recovery");
      if (recover) {
        f.recover();
        f.save({ ...f.state(), mode: "success" });
        const recovered = f.run(false, f.repo, "squash", previous);
        expect(recovered.status, recovered.output).toBe(0);
        expect(f.record()).toMatchObject({
          phase: "complete",
          head: approvedHead,
          recovery: { outcome: previous, attempt: previousRecord.attempt },
        });
        f.git(["merge-base", "--is-ancestor", previous, outcomeRef]);
      }
      expect(f.run().status).toBe(0);
      expect(f.state().mutations).toBe(recover ? 2 : 1);
      const replay = f.run(
        false,
        f.repo,
        "squash",
        legacy.oid,
        approvedHead,
        "",
        "",
        legacy.directory,
      );
      expect(replay.status, replay.output).toBe(1);
      expect(f.state().mutations).toBe(recover ? 2 : 1);
      if (recover) {
        for (const ref of [
          "refs/heads/topic",
          "refs/heads/pr-123",
          "refs/heads/pr-123-prep",
          "refs/remotes/origin/topic",
        ]) {
          f.git(["update-ref", "-d", ref]);
        }
        rmSync(legacy.directory, { recursive: true });
        f.git(["reflog", "expire", "--expire=now", "--all"]);
        f.git(["gc", "--prune=now"]);
        for (const oid of [previous, f.head, f.base, approvedHead]) {
          f.git(["cat-file", "-e", `${oid}^{commit}`]);
        }
        expect(JSON.parse(f.git(["show", `${previous}:outcome.json`]))).toEqual(previousRecord);
      }
      for (const [name, contents] of Object.entries(legacy.files)) {
        const oid = f.git(["rev-parse", `${previous}:legacy-refusal/${name}`]);
        expect(oid).toBe(f.git(["hash-object", "--stdin"], contents));
        f.git(["cat-file", "-e", `${oid}^{blob}`]);
      }
    },
  );

  it.each([
    "timeout",
    "extra-capture",
    "wrong-hash",
    "wrong-pr",
    "wrong-base",
    "missing-proof",
    "symlink",
    "queue",
    "ci-proof",
    "changed-capture",
    "no-head",
  ])("legacy refusal recovery refuses %s without losing evidence or dispatching", (fault) => {
    const f = fixture();
    const legacy = createLegacyRefusal(f);
    const approvedHead = f.replacePreparedHead();
    const next = f.state();
    const capture = join(f.worktree, ".local/merge-output.log");
    if (fault === "timeout") {
      const text = "502 after dispatch\n";
      writeFileSync(capture, text);
      writeFileSync(join(legacy.directory, "merge-output.log"), text);
      legacy.oid = f.git(["hash-object", "--no-filters", capture]);
    }
    if (fault === "extra-capture") {
      writeFileSync(join(f.worktree, ".local/merge-output.other.log"), "");
    }
    if (fault === "wrong-hash") {
      legacy.oid = f.base;
    }
    if (fault === "wrong-pr" || fault === "wrong-base") {
      const path = join(legacy.directory, "prep.env");
      writeFileSync(
        path,
        readFileSync(path, "utf8").replace(
          fault === "wrong-pr" ? "PR_NUMBER=123" : f.base,
          fault === "wrong-pr" ? "PR_NUMBER=456" : "not-a-sha",
        ),
      );
    }
    if (fault === "missing-proof") {
      rmSync(join(legacy.directory, "prep.md"));
    }
    if (fault === "symlink") {
      rmSync(capture);
      symlinkSync(join(legacy.directory, "merge-output.log"), capture);
    }
    if (fault === "queue") {
      next.pr.isMergeQueueEnabled = true;
    }
    if (fault === "ci-proof") {
      next.ciExit = 15;
    }
    if (fault === "changed-capture") {
      next.duringChecks = { artifact: "merge-output.log" };
    }
    f.save(next);
    const run = f.run(
      false,
      f.repo,
      "squash",
      legacy.oid,
      fault === "no-head" ? "" : approvedHead,
      "",
      "",
      legacy.directory,
    );
    expect(run.status, run.output).not.toBe(0);
    expect(f.state().mutations, run.output).toBe(0);
    expect(f.state().posts).toBe(0);
    expect(existsSync(capture)).toBe(true);
    expect(() => f.git(["rev-parse", "--verify", outcomeRef])).toThrow();
  });
});
