import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, delimiter } from "node:path";
import { expect } from "vitest";
import { validReview } from "./pr-review-artifact-fixture.js";
import { copyPrWrapperSources, linkPrWrapperDependencies } from "./pr-wrapper.test-support.js";

// This fixture owns a real canonical wrapper, registered PR checkout, signing key,
// local Git remote, and credential-free GitHub adapter. No owner entry is mocked.
export function createBaselineFixture(root: string, productCount = 16) {
  const repo = join(root, "repo");
  const home = join(root, "home");
  const bin = join(root, "bin");
  for (const dir of [repo, home, bin]) {
    mkdirSync(dir);
  }
  // Baseline operations require these at preflight but must not run builds or searches.
  for (const command of ["rg", "pnpm"]) {
    writeFileSync(
      join(bin, command),
      `#!/bin/sh\necho 'Unexpected fixture command: ${command}' >&2\nexit 99\n`,
      { mode: 0o755 },
    );
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
  const product = Array.from({ length: productCount }, (_, i) => `docs/fix-${i}.md`);
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
  head:{ref:'topic',sha:git('rev-parse','topic'),repo}, changed_files:${productCount},
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
  writeFileSync(
    local("pr-meta.env"),
    `PR_NUMBER=42\nPR_HEAD=topic\nPR_HEAD_SHA=${incoming}\nPR_HEAD_REPO_URL=https://github.com/fixture/repo\n`,
  );
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
  const preparePublication = () => {
    git(repo, "config", `url.${repo}.insteadOf`, "https://github.com/fixture/repo.git");
    const head = git(worktree, "rev-parse", "HEAD");
    const stamp = spawnSync(
      process.platform === "darwin" ? "/bin/bash" : "bash",
      [
        "-c",
        'source "$1"; write_gates_env_stamp 42 true false github_pending "" "" "$2" "" "" "" ""',
        "fixture-gates",
        join(repo, "scripts/pr-lib/gates.sh"),
        head,
      ],
      { cwd: worktree, env, encoding: "utf8" },
    );
    expect(stamp.status, stamp.stderr).toBe(0);
    return head;
  };
  const publish = () => {
    const hosted = git(repo, "rev-parse", "topic");
    const head = preparePublication();
    pass("prepare-push");
    expect(git(repo, "rev-parse", "topic")).toBe(head);
    expect(readFileSync(local("prepare-push-result.env"), "utf8")).toContain(
      `PUSHED_FROM_SHA=${hosted}`,
    );
    return head;
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
    root,
    env,
    key,
    signers,
    repo,
    worktree,
    local,
    git,
    pass,
    run,
    approve,
    advanceMain,
    preparePublication,
    publish,
    manifest,
    successor,
    product,
    incoming,
    meta,
  };
}
