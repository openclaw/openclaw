import { existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { applyFault, configureMerge, expectExit } from "./pr-merge-assertions.test-support.js";
import { createMergeOutcomeFixtureHarness } from "./pr-merge-outcome.test-support.js";

const { fixture, createLegacyRefusal, outcomeRef, describePosix } =
  createMergeOutcomeFixtureHarness();

function legacyFixture(recover = false) {
  const f = fixture(),
    legacy = createLegacyRefusal(f);
  configureMerge(f, { mode: recover ? "unapplied" : "success" });
  const approvedHead = f.replacePreparedHead();
  const run = (head = approvedHead) =>
    f.run(false, f.repo, "squash", legacy.oid, head, "", "", legacy.directory);
  return { f, legacy, approvedHead, run };
}

describePosix("native merge outcome with real Git and supervised lock recovery", () => {
  it.each([false, true])("retains legacy evidence (recovery=%s)", (recover) => {
    const { f, legacy, approvedHead, run } = legacyFixture(recover);
    expectExit(run(), recover ? 1 : 0);
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
      configureMerge(f, { mode: "success" });
      expectExit(f.run(false, f.repo, "squash", previous));
      expect(f.record()).toMatchObject({
        phase: "complete",
        head: approvedHead,
        recovery: { outcome: previous, attempt: previousRecord.attempt },
      });
      f.git(["merge-base", "--is-ancestor", previous, outcomeRef]);
    }
    expectExit(f.run());
    expect(f.state().mutations).toBe(recover ? 2 : 1);
    expectExit(run(), 1);
    expect(f.state().mutations).toBe(recover ? 2 : 1);
    if (recover) {
      for (const branch of ["topic", "pr-123", "pr-123-prep"]) {
        f.git(["update-ref", "-d", `refs/heads/${branch}`]);
      }
      f.git(["update-ref", "-d", "refs/remotes/origin/topic"]);
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
  });

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
  ])("refuses legacy %s without dispatch", (fault) => {
    const { f, legacy, approvedHead, run } = legacyFixture();
    const next = f.state();
    const capture = join(f.worktree, ".local/merge-output.log");
    applyFault(fault, {
      timeout: () => {
        const text = "502 after dispatch\n";
        writeFileSync(capture, text);
        writeFileSync(join(legacy.directory, "merge-output.log"), text);
        legacy.oid = f.git(["hash-object", "--no-filters", capture]);
      },
      "extra-capture": () => writeFileSync(join(f.worktree, ".local/merge-output.other.log"), ""),
      "wrong-hash": () => Object.assign(legacy, { oid: f.base }),
      "missing-proof": () => rmSync(join(legacy.directory, "prep.md")),
      symlink: () => {
        rmSync(capture);
        symlinkSync(join(legacy.directory, "merge-output.log"), capture);
      },
      queue: () => Object.assign(next.pr, { isMergeQueueEnabled: true }),
      "ci-proof": () => Object.assign(next, { ciExit: 15 }),
      "changed-capture": () =>
        Object.assign(next, { duringChecks: { artifact: "merge-output.log" } }),
    });
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
    f.save(next);
    const result = run(fault === "no-head" ? "" : approvedHead);
    expect(result.status, result.output).not.toBe(0);
    expect(f.state(), result.output).toMatchObject({ mutations: 0, posts: 0 });
    expect(existsSync(capture)).toBe(true);
    expect(() => f.git(["rev-parse", "--verify", outcomeRef])).toThrow();
  });
});
