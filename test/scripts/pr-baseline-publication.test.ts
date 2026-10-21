import { spawnSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createBaselineFixture } from "./pr-baseline-native.test-support.js";

const dirs = useAutoCleanupTempDirTracker(afterAll);
const describePosix = process.platform === "win32" ? describe.skip : describe;

function fixture() {
  const f = createBaselineFixture(dirs.make("openclaw-pr-baseline-publication-"), 1);
  // Reproduce a correction rebased onto main, then reconciled with the original
  // hosted head as second parent. The inherited main commit is deliberately unsigned.
  f.git(f.repo, "commit", "--allow-empty", "--no-gpg-sign", "-qm", "test: inherited main");
  const baseline = f.git(f.repo, "rev-parse", "HEAD");
  const parents = [baseline, f.incoming].flatMap((parent) => ["-p", parent]);
  const reconciled = f.prepGit(
    "commit-tree",
    "-S",
    "HEAD^{tree}",
    ...parents,
    "-m",
    "fix: reconcile the reviewed correction",
  );
  f.prepGit("reset", "--hard", reconciled);
  f.approve();
  f.pass("prepare-baseline-refresh", ["--expected-head", reconciled, "--baseline", baseline]);
  f.approve();
  return { ...f, baseline };
}

function expectRefused(f: ReturnType<typeof fixture>) {
  const source = f.prepGit("rev-parse", "HEAD");
  f.preparePublication();
  const result = f.run("prepare-push");
  expect(result.status, result.stdout + result.stderr).not.toBe(0);
  expect(f.git(f.repo, "rev-parse", "topic")).toBe(f.incoming);
  expect(f.prepGit("rev-parse", "HEAD")).toBe(source);
  expect(existsSync(f.local("prepare-push-result.env"))).toBe(false);
  return result;
}

describePosix("baseline-bound publication signatures", () => {
  it("publishes the signed correction without trusting inherited first-parent main history", () => {
    const f = fixture();
    expect(
      spawnSync("git", ["verify-commit", f.baseline], { cwd: f.worktree, env: f.env }).status,
    ).not.toBe(0);
    expect(f.prepGit("rev-list", "--first-parent", `${f.incoming}..HEAD`)).toContain(f.baseline);
    const tree = f.prepGit("rev-parse", "HEAD^{tree}");
    const published = f.publish();
    expect(f.git(f.repo, "rev-parse", `${published}^{tree}`)).toBe(tree);
    expect(f.git(f.repo, "merge-base", f.incoming, published)).toBe(f.incoming);
  });

  it.each(["first", "side"])("rejects an unsigned task commit on the %s parent", (parent) => {
    const f = fixture();
    if (parent === "side") {
      f.prepGit("switch", "-qc", "unsigned-task", f.baseline);
    }
    writeFileSync(join(f.worktree, "docs/later.md"), "later task change\n");
    f.prepGit("add", "docs/later.md");
    f.prepGit("commit", "--no-gpg-sign", "-qm", "fix: unsigned task change");
    const unsigned = f.prepGit("rev-parse", "HEAD");
    if (parent === "side") {
      f.prepGit("switch", "-q", "pr-42-prep");
      f.prepGit("merge", "--no-ff", "-qm", "fix: merge the task change", unsigned);
      expect(f.prepGit("rev-list", "--first-parent", `${f.incoming}..HEAD`)).not.toContain(
        unsigned,
      );
    }
    f.approve();
    const result = expectRefused(f);
    expect(result.status).toBe(2);
    expect(result.stdout + result.stderr).toContain(
      "Refusing git-protocol PR branch push because it can publish unsigned commits.",
    );
  });

  it.each(["missing", "changed", "wrong-anchor", "unbound"])(
    "refuses %s baseline authority before either transport",
    (fault) => {
      const f = fixture();
      if (fault === "missing") {
        rmSync(f.local("prepare-baseline.json"));
      } else if (fault === "changed") {
        const binding = JSON.parse(f.readLocal("prepare-baseline.json").toString());
        binding.baselineHead = f.incoming;
        f.writeLocal("prepare-baseline.json", JSON.stringify(binding));
      } else {
        const context = f.readLocal("prep-context.env").toString();
        f.writeLocal(
          "prep-context.env",
          fault === "wrong-anchor"
            ? context.replace(
                /^PREP_BASELINE_REFRESH_HEAD=.*$/mu,
                `PREP_BASELINE_REFRESH_HEAD=${f.incoming}`,
              )
            : context.replace(/^PREP_BASELINE_REFRESH_(?:HEAD|OID)=.*\n/gmu, ""),
        );
      }
      const result = expectRefused(f);
      expect(result.stderr).not.toContain("Pushing PR branch");
      expect(result.stderr).not.toContain("GraphQL push cannot preserve merge ancestry");
    },
  );
});
