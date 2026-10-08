import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, delimiter } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { validReview } from "./pr-review-artifact-fixture.js";
import { copyPrWrapperSources, linkPrWrapperDependencies } from "./pr-wrapper.test-support.js";

const dirs = useAutoCleanupTempDirTracker(afterAll);
const describePosix = process.platform === "win32" ? describe.skip : describe;

// This fixture owns a real canonical wrapper, registered PR checkout, signing key,
// local Git remote, and credential-free GitHub adapter. No owner entry is mocked.
function fixture() {
  const root = dirs.make("openclaw-pr-successor-");
  const repo = join(root, "repo");
  const home = join(root, "home");
  const bin = join(root, "bin");
  for (const dir of [repo, home, bin]) {
    mkdirSync(dir);
  }
  const env = {
    PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
    HOME: home,
    TMPDIR: root,
    XDG_CONFIG_HOME: join(home, ".config"),
    GH_CONFIG_DIR: join(home, "gh"),
    GH_REPO: "github.com/fixture/repo",
    OPENCLAW_GH_BIN: join(bin, "gh"),
    FIXTURE_REPO: repo,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_PARAMETERS: "'maintenance.auto=false' 'gc.auto=0'",
    GIT_ALLOW_PROTOCOL: "file",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  const git = (cwd: string, ...args: string[]) => {
    const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  const key = join(root, "key");
  expect(
    spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key], { env }).status,
  ).toBe(0);
  const signers = join(root, "signers");
  writeFileSync(signers, `fixture@example.invalid ${readFileSync(`${key}.pub`, "utf8")}`);
  copyPrWrapperSources(repo);
  linkPrWrapperDependencies(repo);
  git(repo, "init", "-q", "-b", "main");
  for (const [name, value] of Object.entries({
    "core.hooksPath": "/dev/null",
    "gpg.format": "ssh",
    "user.signingKey": key,
    "gpg.ssh.allowedSignersFile": signers,
    "commit.gpgSign": "true",
  })) {
    git(repo, "config", name, value);
  }
  writeFileSync(join(repo, ".gitignore"), ".worktrees/\n.local/\nnode_modules/\n");
  mkdirSync(join(repo, "docs"), { recursive: true });
  const product = Array.from({ length: 16 }, (_, i) => `docs/fix-${i}.md`);
  for (const path of product) {
    writeFileSync(join(repo, path), "base\n");
  }
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "test: canonical fixture");
  const base = git(repo, "rev-parse", "HEAD");
  git(repo, "remote", "add", "origin", repo);
  git(repo, "switch", "-qc", "topic");
  for (const path of product) {
    writeFileSync(join(repo, path), "broken\n");
  }
  git(repo, "commit", "-qam", "test: incoming fixture");
  const incoming = git(repo, "rev-parse", "HEAD");
  git(repo, "switch", "-q", "main");
  const worktree = join(repo, ".worktrees", "pr-42");
  git(repo, "worktree", "add", "-q", "-b", "pr-42-prep", worktree, incoming);
  mkdirSync(join(worktree, ".local"));
  writeFileSync(
    join(bin, "gh"),
    `#!/usr/bin/env node
const fs = require('node:fs'), cp = require('node:child_process'), path = require('node:path');
const root = process.env.FIXTURE_REPO;
const git = (...args) => cp.execFileSync('git', ['-C',root,...args], {encoding:'utf8'}).trim();
const repo = {id:1,node_id:'R_fixture',full_name:'fixture/repo',name:'repo',html_url:'https://github.com/fixture/repo',owner:{login:'fixture'}};
const args = process.argv.slice(2);
if (args[0] === 'auth') process.exit(1);
if (args[0] === 'api' && args[1] === 'user') {
 console.log('HTTP/2.0 200 OK\\r\\n\\r\\n{"login":"fixture"}');
} else if (args.includes('repos/fixture/repo/pulls/42')) {
 const overrides = path.join(root,'.local','live.json');
 console.log(JSON.stringify({number:42,node_id:'PR_fixture',html_url:'https://github.com/fixture/repo/pull/42',state:'open',draft:false,
  user:{login:'fixture'},base:{ref:'main',sha:git('rev-parse','main'),repo},
  head:{ref:'topic',sha:git('rev-parse','topic'),repo}, changed_files:16,
  ...(fs.existsSync(overrides) ? JSON.parse(fs.readFileSync(overrides,'utf8')) : {})}));
} else if (args.some(a => a.startsWith('repos/fixture/repo/collaborators/'))) {
 console.log('{"permission":"write"}');
} else { console.error('Unexpected fixture GitHub request: '+JSON.stringify(args)); process.exit(99); }
`,
    { mode: 0o755 },
  );
  const meta = {
    number: 42,
    headRefOid: incoming,
    headRefName: "topic",
    baseRefName: "main",
    baseRefOid: base,
    url: "https://github.com/fixture/repo/pull/42",
    state: "OPEN",
    isCrossRepository: false,
    baseRepository: {
      id: "R_fixture",
      databaseId: 1,
      nameWithOwner: "fixture/repo",
      url: "https://github.com/fixture/repo",
    },
    headRepository: {
      id: "R_fixture",
      name: "repo",
      nameWithOwner: "fixture/repo",
      url: "https://github.com/fixture/repo",
    },
    headRepositoryOwner: { login: "fixture", is_bot: false },
    files: product.map((path) => ({ path })),
  };
  const local = (name: string) => join(worktree, ".local", name);
  writeFileSync(local("pr-meta.json"), JSON.stringify(meta));
  writeFileSync(local("pr-meta.env"), `PR_NUMBER=42\nPR_HEAD=topic\nPR_HEAD_SHA=${incoming}\n`);
  writeFileSync(local("review-mode.env"), "REVIEW_MODE=pr\n");
  const review = validReview(incoming);
  review.recommendation = "NEEDS WORK";
  review.issueValidation.status = "valid";
  review.findings.push({
    id: "I1",
    severity: "IMPORTANT",
    title: "Broken behavior",
    area: product[0]!,
    fix: "Repair behavior",
  });
  writeFileSync(local("review.json"), JSON.stringify(review));
  const run = (command: string, args: string[] = [], extra: NodeJS.ProcessEnv = {}) =>
    spawnSync(join(repo, "scripts/pr"), [command, "42", ...args], {
      cwd: repo,
      env: { ...env, ...extra },
      encoding: "utf8",
    });
  const pass = (command: string, args: string[] = []) => {
    const result = run(command, args);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    return result;
  };
  pass("prepare-correction-init");
  for (const path of product) {
    writeFileSync(join(worktree, path), "corrected\n");
  }
  git(worktree, "commit", "-qam", "fix: fixture correction");
  const approve = () => {
    pass("prepare-correction-review-init");
    const file = local("correction-review.json");
    const candidateReview = JSON.parse(readFileSync(file, "utf8"));
    Object.assign(candidateReview, validReview(git(worktree, "rev-parse", "HEAD")));
    candidateReview.recommendation = "READY FOR /prepare-pr";
    candidateReview.issueValidation.status = "valid";
    candidateReview.correction.resolvedFindings[0].resolution =
      "Verified the corrected fixture behavior.";
    writeFileSync(file, JSON.stringify(candidateReview));
  };
  approve();
  const advanceMain = (label: string, changed = product) => {
    for (const path of changed) {
      writeFileSync(join(repo, path), `${label}\n`);
    }
    git(repo, "commit", "-qam", `test: ${label}`);
    return git(repo, "rev-parse", "HEAD");
  };
  const manifest = (baseline: string, changed = product) => {
    const source = git(worktree, "rev-parse", "HEAD");
    const fork = git(worktree, "merge-base", source, baseline);
    const entry = (commit: string, path: string) => {
      const [mode, , oid] = git(worktree, "ls-tree", commit, "--", path).split(/\s/u);
      return { mode, oid };
    };
    const bytes = Buffer.from(`resolved against ${baseline}\n`);
    writeFileSync(local("resolution.txt"), bytes);
    writeFileSync(
      local("resolutions.json"),
      JSON.stringify({
        version: 1,
        pr: 42,
        sourceHead: source,
        baselineHead: baseline,
        forkBase: fork,
        resolutions: changed.map((path) => ({
          path,
          base: entry(fork, path),
          source: entry(source, path),
          baseline: entry(baseline, path),
          resolved: {
            mode: "100644",
            file: "resolution.txt",
            sha256: createHash("sha256").update(bytes).digest("hex"),
          },
        })),
      }),
    );
    return [
      "--expected-head",
      source,
      "--baseline",
      baseline,
      "--resolutions",
      local("resolutions.json"),
    ];
  };
  const successor = (baseline: string) => [
    ...manifest(baseline, [product[0]!]),
    "--expected-tree",
    git(worktree, "rev-parse", "HEAD^{tree}"),
    "--expected-review",
    git(worktree, "hash-object", "--no-filters", local("correction-review.json")),
    "--predecessor-head",
    /^PREP_BASELINE_REFRESH_HEAD=([a-f0-9]{40})$/mu.exec(
      readFileSync(local("prep-context.env"), "utf8"),
    )![1]!,
    "--predecessor-binding",
    git(worktree, "hash-object", "--no-filters", local("prepare-baseline.json")),
  ];
  return {
    repo,
    worktree,
    local,
    git,
    pass,
    run,
    approve,
    advanceMain,
    manifest,
    successor,
    product,
  };
}

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
      const lock = f.git(f.repo, "rev-parse", "refs/openclaw/pr-operation-locks/42");
      f.pass("lock-recover", [lock, "--confirmed-no-running-tools"]);
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
