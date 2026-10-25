import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createBaselineFixture } from "./pr-baseline-native.test-support.js";

const dirs = useAutoCleanupTempDirTracker(afterAll);
const describePosix = process.platform === "win32" ? describe.skip : describe;
const fixture = () => createBaselineFixture(dirs.make("openclaw-pr-successor-"));

describePosix("native successor source admission entry", () => {
  it("admits two reviewed successors while preserving signed ancestry, resolutions and proof", () => {
    const f = fixture();
    f.writeLocal("gates-build.log", "original proof bytes\n");
    const initial = f.advanceMain("initial upstream");
    f.pass("prepare-baseline-refresh", f.manifest(initial));
    const initialHead = f.prepGit("rev-parse", "HEAD");
    const retained = f.snapshot(
      readdirSync(join(f.worktree, ".local"))
        .filter((n) => n.startsWith("prep-evidence."))
        .flatMap((dir) => readdirSync(f.local(dir)).map((name) => `${dir}/${name}`)),
    );
    writeFileSync(join(f.worktree, "docs/later-fixup.md"), "reviewed post-refresh correction\n");
    f.prepGit("add", "docs/later-fixup.md");
    f.prepGit("commit", "-qm", "fix: reviewed post-refresh correction");
    f.approve();
    f.publish();
    for (const label of ["second upstream", "third upstream"]) {
      const prior = f.prepGit("rev-parse", "HEAD");
      const baseline = f.advanceMain(label, [f.product[0]!]);
      const args = f.successor(baseline);
      f.pass("prepare-baseline-successor", args);
      f.prepGit("verify-commit", "HEAD");
      expect(f.prepGit("show", "-s", "--format=%P", "HEAD")).toBe(`${prior} ${baseline}`);
      f.expectSnapshot(retained);
      expect(f.prepGit("show", "HEAD:docs/later-fixup.md")).toBe(
        "reviewed post-refresh correction",
      );
      expect(f.prepGit("merge-base", initialHead, "HEAD")).toBe(initialHead);
      f.approve();
      const rejected = f.run("prepare-baseline-refresh", f.manifest(baseline, []));
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain("already bound baseline refresh source");
      expect(rejected.stderr).toContain("Released the operation lock for PR #42");
      expect(f.git(f.repo, "for-each-ref", "refs/openclaw/pr-operation-locks")).toBe("");
    }
    f.expectSnapshot(retained);
    f.publish();
  });
  it.each(["branch", "closed", "head", "work", "branch-after-live", "closed-after-live"])(
    "preserves transition custody when %s authority changes during replay",
    (scenario) => {
      const f = fixture();
      f.pass("prepare-baseline-refresh", f.manifest(f.advanceMain("initial upstream")));
      f.approve();
      const source = f.prepGit("rev-parse", "HEAD");
      const before = f.snapshot([
        "prepare-baseline.json",
        "prep-context.env",
        "correction-review.json",
        "review.json",
      ]);
      const product = f.product.map((name) => readFileSync(join(f.worktree, name)));
      f.prepGit("branch", "foreign-preparation", source);
      const baseline = f.advanceMain("next upstream", [f.product[0]!]);
      const hook = f.local("late-authority.mjs");
      writeFileSync(
        hook,
        `
import fs from 'node:fs';
import cp from 'node:child_process';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
const phase = process.argv[1]?.endsWith('/baseline-refresh.mjs') ? process.argv[2] : '';
const scenario = process.env.FIXTURE_DRIFT;
const run = cp.execFileSync;
const late = scenario.endsWith('-after-live');
let predecessorVerifications = 0;
const local = process.env.FIXTURE_WORKTREE + '/.local/';
if (late && process.argv[1]?.endsWith('/gh')) {
  const write = process.stdout.write;
  process.stdout.write = function(chunk, ...rest) {
    const result = write.call(this, chunk, ...rest);
    if (fs.existsSync(local + 'review-transition.json') && String(chunk).includes('PR_fixture')) {
      const journal = JSON.parse(fs.readFileSync(local + 'review-transition.json'));
      const restored = run('git', ['-C', process.env.FIXTURE_WORKTREE, 'write-tree']).toString().trim() ===
        run('git', ['-C', process.env.FIXTURE_WORKTREE, 'rev-parse', journal.target + '^{tree}']).toString().trim();
      fs.writeFileSync(local + 'live-window', JSON.stringify({restored}));
    }
    return result;
  };
}
cp.execFileSync = function(file, args, ...rest) {
  const result = run.call(this, file, args, ...rest);
  if (['validate-transition', 'install-transition'].includes(phase) &&
      args?.[0] === 'verify-commit' && args[1] === process.env.FIXTURE_SOURCE &&
      !fs.existsSync('.local/drift-fired')) {
    predecessorVerifications++;
    const journal = JSON.parse(fs.readFileSync('.local/review-transition.json'));
    const installed = fs.readFileSync('.local/prepare-baseline.json').equals(Buffer.from(journal.binding, 'base64'));
    // Exercise the predecessor replay before installation, and the final replay
    // after restoration. No timers or artificial production wait points.
    const window = fs.existsSync(local + 'live-window') ? JSON.parse(fs.readFileSync(local + 'live-window')) : null;
    const branch = scenario.startsWith('branch');
    const trigger = late
      ? window && (branch ? !installed && phase === 'install-transition' && predecessorVerifications === 2 : window.restored)
      : (branch || scenario === 'work' ? !installed : installed);
    if (trigger) {
      if (branch) run('git', ['checkout', '-q', 'foreign-preparation']);
      else if (scenario === 'work') fs.writeFileSync('docs/fix-0.md', 'foreign work');
      else {
        fs.mkdirSync(path.join(process.env.FIXTURE_REPO, '.local'), {recursive:true});
        const drift = scenario.startsWith('closed') ? {state:'closed'} : {head:{
          ref:'topic', sha:process.env.FIXTURE_BASELINE, repo:{id:1,node_id:'R_fixture',
          full_name:'fixture/repo',name:'repo',html_url:'https://github.com/fixture/repo',owner:{login:'fixture'}}}};
        fs.writeFileSync(path.join(process.env.FIXTURE_REPO, '.local/live.json'), JSON.stringify(drift));
      }
      fs.writeFileSync('.local/drift-fired', phase);
    }
  }
  return result;
};
syncBuiltinESMExports();
`,
      );
      const result = f.run("prepare-baseline-successor", f.successor(baseline), {
        NODE_OPTIONS: "--import=" + hook,
        FIXTURE_DRIFT: scenario,
        FIXTURE_SOURCE: source,
        FIXTURE_BASELINE: baseline,
        FIXTURE_WORKTREE: f.worktree,
      });
      if (scenario.endsWith("-after-live")) {
        // An actor changing authority during post-observation proof must never
        // receive a successful ref move (or partial writes on a foreign branch).
        // With replay completed first, this late proof window no longer exists.
        const fired = existsSync(f.local("drift-fired"));
        if (fired) {
          expect(f.prepGit("rev-parse", "refs/heads/pr-42-prep")).toBe(source);
          f.expectSnapshot(before);
          expect(f.product.map((name) => readFileSync(join(f.worktree, name)))).toEqual(product);
        } else {
          expect(result.status, result.stdout + result.stderr).toBe(0);
          expect(f.prepGit("status", "--porcelain")).toBe("");
          expect(existsSync(f.local("review-transition.json"))).toBe(false);
        }
        return;
      }
      expect(existsSync(f.local("drift-fired"))).toBe(true);
      expect(result.status, result.stdout + result.stderr).not.toBe(0);
      expect(f.prepGit("rev-parse", "refs/heads/pr-42-prep")).toBe(source);
      expect(f.readLocal("review.json")).toEqual(before["review.json"]);
      const journal = f.readLocal("review-transition.json");
      if (scenario === "branch" || scenario === "work") {
        expect(f.prepGit("symbolic-ref", "--short", "HEAD")).toBe(
          scenario === "branch" ? "foreign-preparation" : "pr-42-prep",
        );
        expect(f.prepGit("status", "--porcelain")).toBe(
          scenario === "branch" ? "" : "M docs/fix-0.md",
        );
        f.expectSnapshot(before);
        expect(f.product.map((name) => readFileSync(join(f.worktree, name)))).toEqual(
          scenario === "work" ? [Buffer.from("foreign work"), ...product.slice(1)] : product,
        );
      } else {
        // Refusal after installation retains the admitted target, not a fake
        // rollback or a success-shaped missing journal.
        const admitted = JSON.parse(journal.toString());
        expect(f.prepGit("write-tree")).toBe(f.prepGit("rev-parse", admitted.target + "^{tree}"));
        expect(existsSync(f.local("correction-review.json"))).toBe(false);
        expect(f.readLocal("prepare-baseline.json")).toEqual(
          Buffer.from(admitted.binding, "base64"),
        );
      }
    },
  );
});
