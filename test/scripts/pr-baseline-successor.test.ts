import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createBaselineFixture } from "./pr-baseline-native.test-support.js";

const dirs = useAutoCleanupTempDirTracker(afterAll);
const describePosix = process.platform === "win32" ? describe.skip : describe;
const fixture = () => createBaselineFixture(dirs.make("openclaw-pr-successor-"));

describePosix("native successor source admission entry", () => {
  let f: ReturnType<typeof fixture>;
  beforeAll(() => {
    f = fixture();
  });
  it("admits two reviewed successors while preserving signed ancestry, all sixteen resolutions and proof", () => {
    writeFileSync(f.local("gates-build.log"), "original proof bytes\n");
    const initial = f.advanceMain("initial upstream");
    f.pass("prepare-baseline-refresh", f.manifest(initial));
    const initialHead = f.git(f.worktree, "rev-parse", "HEAD");
    const initialBinding = readFileSync(f.local("prepare-baseline.json"));
    const archives = () =>
      Object.fromEntries(
        readdirSync(join(f.worktree, ".local"))
          .filter((n) => n.startsWith("prep-evidence."))
          .flatMap((dir) =>
            readdirSync(f.local(dir)).map((name) => [
              `${dir}/${name}`,
              readFileSync(f.local(`${dir}/${name}`)).toString("base64"),
            ]),
          ),
      );
    const retained = archives();
    expect(JSON.parse(initialBinding.toString()).resolutions).toHaveLength(16);
    writeFileSync(join(f.worktree, "docs/later-fixup.md"), "reviewed post-refresh correction\n");
    f.git(f.worktree, "add", "docs/later-fixup.md");
    f.git(f.worktree, "commit", "-qm", "fix: reviewed post-refresh correction");
    f.approve();
    for (const label of ["second upstream", "third upstream"]) {
      const prior = f.git(f.worktree, "rev-parse", "HEAD");
      const baseline = f.advanceMain(label, [f.product[0]!]);
      const args = f.successor(baseline);
      f.pass("prepare-baseline-successor", args);
      f.git(f.worktree, "verify-commit", "HEAD");
      expect(f.git(f.worktree, "show", "-s", "--format=%P", "HEAD")).toBe(`${prior} ${baseline}`);
      expect(archives()).toMatchObject(retained);
      expect(f.git(f.worktree, "show", "HEAD:docs/later-fixup.md")).toBe(
        "reviewed post-refresh correction",
      );
      expect(f.git(f.worktree, "merge-base", initialHead, "HEAD")).toBe(initialHead);
      f.approve();
      const rejected = f.run("prepare-baseline-refresh", f.manifest(baseline, []));
      expect(rejected.status).not.toBe(0);
      expect(rejected.stderr).toContain("already bound baseline refresh source");
      expect(rejected.stderr).toContain("Released the operation lock for PR #42");
      expect(f.git(f.repo, "for-each-ref", "refs/openclaw/pr-operation-locks")).toBe("");
    }
    expect(archives()).toMatchObject(retained);
  });
  it.each(["branch", "closed", "head", "work", "branch-after-live", "closed-after-live"])(
    "preserves transition custody when %s authority changes during replay",
    (scenario) => {
      const scenarioFixture = fixture();
      scenarioFixture.pass(
        "prepare-baseline-refresh",
        scenarioFixture.manifest(scenarioFixture.advanceMain("initial upstream")),
      );
      scenarioFixture.approve();
      const source = scenarioFixture.git(scenarioFixture.worktree, "rev-parse", "HEAD");
      const before = Object.fromEntries(
        ["prepare-baseline.json", "prep-context.env", "correction-review.json", "review.json"].map(
          (name) => [name, readFileSync(scenarioFixture.local(name))],
        ),
      );
      const product = scenarioFixture.product.map((name) =>
        readFileSync(join(scenarioFixture.worktree, name)),
      );
      scenarioFixture.git(scenarioFixture.worktree, "branch", "foreign-preparation", source);
      const baseline = scenarioFixture.advanceMain("next upstream", [scenarioFixture.product[0]!]);
      const hook = scenarioFixture.local("late-authority.mjs");
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
      const result = scenarioFixture.run(
        "prepare-baseline-successor",
        scenarioFixture.successor(baseline),
        {
          NODE_OPTIONS: "--import=" + hook,
          FIXTURE_DRIFT: scenario,
          FIXTURE_SOURCE: source,
          FIXTURE_BASELINE: baseline,
          FIXTURE_WORKTREE: scenarioFixture.worktree,
        },
      );
      if (scenario.endsWith("-after-live")) {
        // An actor changing authority during post-observation proof must never
        // receive a successful ref move (or partial writes on a foreign branch).
        // With replay completed first, this late proof window no longer exists.
        const fired = existsSync(scenarioFixture.local("drift-fired"));
        if (fired) {
          expect(
            scenarioFixture.git(scenarioFixture.worktree, "rev-parse", "refs/heads/pr-42-prep"),
          ).toBe(source);
          for (const [name, bytes] of Object.entries(before)) {
            expect(readFileSync(scenarioFixture.local(name))).toEqual(bytes);
          }
          expect(
            scenarioFixture.product.map((name) =>
              readFileSync(join(scenarioFixture.worktree, name)),
            ),
          ).toEqual(product);
        } else {
          expect(result.status, result.stdout + result.stderr).toBe(0);
          expect(scenarioFixture.git(scenarioFixture.worktree, "status", "--porcelain")).toBe("");
          expect(existsSync(scenarioFixture.local("review-transition.json"))).toBe(false);
        }
        return;
      }
      expect(existsSync(scenarioFixture.local("drift-fired"))).toBe(true);
      expect(result.status, result.stdout + result.stderr).not.toBe(0);
      expect(
        scenarioFixture.git(scenarioFixture.worktree, "rev-parse", "refs/heads/pr-42-prep"),
      ).toBe(source);
      expect(readFileSync(scenarioFixture.local("review.json"))).toEqual(before["review.json"]);
      const journal = readFileSync(scenarioFixture.local("review-transition.json"));
      if (scenario === "branch" || scenario === "work") {
        expect(
          scenarioFixture.git(scenarioFixture.worktree, "symbolic-ref", "--short", "HEAD"),
        ).toBe(scenario === "branch" ? "foreign-preparation" : "pr-42-prep");
        expect(scenarioFixture.git(scenarioFixture.worktree, "status", "--porcelain")).toBe(
          scenario === "branch" ? "" : "M docs/fix-0.md",
        );
        for (const [name, bytes] of Object.entries(before)) {
          expect(readFileSync(scenarioFixture.local(name))).toEqual(bytes);
        }
        expect(
          scenarioFixture.product.map((name) => readFileSync(join(scenarioFixture.worktree, name))),
        ).toEqual(
          scenario === "work" ? [Buffer.from("foreign work"), ...product.slice(1)] : product,
        );
      } else {
        // Refusal after installation retains the admitted target, not a fake
        // rollback or a success-shaped missing journal.
        const admitted = JSON.parse(journal.toString());
        expect(scenarioFixture.git(scenarioFixture.worktree, "write-tree")).toBe(
          scenarioFixture.git(scenarioFixture.worktree, "rev-parse", admitted.target + "^{tree}"),
        );
        expect(existsSync(scenarioFixture.local("correction-review.json"))).toBe(false);
        expect(readFileSync(scenarioFixture.local("prepare-baseline.json"))).toEqual(
          Buffer.from(admitted.binding, "base64"),
        );
      }
      expect(readFileSync(scenarioFixture.local("review-transition.json"))).toEqual(journal);
    },
  );
});
