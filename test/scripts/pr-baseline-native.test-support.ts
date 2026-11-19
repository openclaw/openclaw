import { spawnSync, type SpawnSyncOptionsWithBufferEncoding } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, delimiter } from "node:path";
import { afterAll, expect } from "vitest";
import { copyTreeCloseOnExec } from "../helpers/close-on-exec-copy.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { validReview } from "./pr-review-artifact-fixture.js";
import { copyPrWrapperSources, linkPrWrapperDependencies } from "./pr-wrapper.test-support.js";

const cliFlags = (values: Record<string, string>) => Object.entries(values).flat();

export function reuseBaselineFixture<T extends object>(create: (root: string) => T) {
  const dirs = useAutoCleanupTempDirTracker(afterAll);
  const root = dirs.make("openclaw-pr-baseline-");
  const pristine = dirs.make("openclaw-pr-baseline-pristine-");
  let context: T;
  return () => {
    if (!context) {
      context = create(root);
      copyTreeCloseOnExec(root, pristine);
    }
    // Captured JavaScript state must stay read-only after setup. Registered
    // worktrees and evidence bind absolute paths, so restore the whole private root.
    rmSync(root, { recursive: true, force: true });
    copyTreeCloseOnExec(pristine, root);
    return context;
  };
}

export function failRestore(root: string, env: NodeJS.ProcessEnv) {
  const realGit = spawnSync("sh", ["-c", "command -v git"], {
    env,
    encoding: "utf8",
  }).stdout.trim();
  const path = join(root, "fail-restore");
  writeFileSync(
    path,
    `#!/bin/bash\nif [ "$1" = --literal-pathspecs ] && [ "$2" = restore ]; then exit 72; fi\nexec '${realGit}' "$@"\n`,
    { mode: 0o755 },
  );
  return { OPENCLAW_PR_GIT: path };
}

// Sign the exact requested bytes in a separate object store, never by splicing a signature.
export function signBaselineRequest(
  f: ReturnType<typeof createBaselineFixture>,
  requestArgs: string[],
) {
  const gitBytes = (
    cwd: string,
    args: string[],
    options: SpawnSyncOptionsWithBufferEncoding = {},
  ) => {
    const result = spawnSync("git", args, { cwd, env: f.env, ...options });
    expect(result.status, result.stderr.toString()).toBe(0);
    return result.stdout;
  };
  const pending = f.pass("prepare-baseline-signing-request", requestArgs);
  const oid = /Awaiting signature: request=([a-f0-9]{40})/u.exec(pending.stdout)![1]!;
  const requestPath = f.local(`prepare-baseline-signing.${oid}.json`);
  const requestBytes = readFileSync(requestPath);
  const request = JSON.parse(requestBytes.toString());
  const spool = join(f.root, "signer.git");
  mkdirSync(spool);
  f.git(spool, "init", "-q", "--bare");
  const unsigned = Buffer.from(request.unsignedCommit, "base64");
  const split = unsigned.indexOf("\n\n");
  const headers = unsigned.subarray(0, split).toString();
  const tree = /^tree ([a-f0-9]{40})$/mu.exec(headers)![1]!;
  const parents = [...headers.matchAll(/^parent ([a-f0-9]{40})$/gmu)].map((m) => m[1]!);
  const pack = gitBytes(f.worktree, ["pack-objects", "--stdout", "--revs"], {
    maxBuffer: 16 * 1024 * 1024,
    input: [tree, ...parents].join("\n") + "\n",
  });
  gitBytes(spool, ["index-pack", "--stdin"], { input: pack });
  const identity: NodeJS.ProcessEnv = {};
  for (const role of ["author", "committer"]) {
    const [, name, email, date] = new RegExp(`^${role} (.*) <([^>]*)> (.*)$`, "mu").exec(headers)!;
    identity[`GIT_${role.toUpperCase()}_NAME`] = name;
    identity[`GIT_${role.toUpperCase()}_EMAIL`] = email;
    identity[`GIT_${role.toUpperCase()}_DATE`] = date;
  }
  const sign = (key: string) => {
    const target = gitBytes(
      spool,
      [
        "-c",
        "gpg.format=ssh",
        "commit-tree",
        `-S${key}`,
        tree,
        ...parents.flatMap((parent) => ["-p", parent]),
      ],
      {
        env: { ...f.env, ...identity },
        input: unsigned.subarray(split + 2),
      },
    )
      .toString()
      .trim();
    return { target, bytes: gitBytes(spool, ["cat-file", "commit", target]) };
  };
  const signed = sign(f.key);
  const response = f.local("signed-commit");
  writeFileSync(response, signed.bytes);
  const bindingOid = gitBytes(f.worktree, ["hash-object", "--no-filters", "--stdin"], {
    input: Buffer.from(request.binding, "base64"),
  })
    .toString()
    .trim();
  return {
    requestPath,
    requestBytes,
    request,
    signed,
    response,
    args: ["--request", oid, "--signed-commit", response],
    identity,
    sign,
    bindingOid,
    message: unsigned.subarray(split + 2).toString(),
  };
}

// This fixture owns a real canonical wrapper, registered PR checkout, signing key,
// local Git remote, and credential-free GitHub adapter. No owner entry is mocked.
export function createBaselineFixture(
  root: string,
  productCount = 16,
  incomingSeverity: "IMPORTANT" | "BLOCKER" = "IMPORTANT",
) {
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
  const commit = (cwd: string, message: string) => git(cwd, "commit", "-qam", message);
  const writeProduct = (cwd: string, paths: string[], content: string) => {
    for (const path of paths) {
      writeFileSync(join(cwd, path), content);
    }
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
  writeProduct(repo, product, "base\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "test: canonical fixture");
  const base = git(repo, "rev-parse", "HEAD");
  git(repo, "remote", "add", "origin", repo);
  git(repo, "switch", "-qc", "topic");
  writeProduct(repo, product, "broken\n");
  commit(repo, "test: incoming fixture");
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
} else if (args[0] === 'api' && args[1] === 'graphql') {
 if (!args.some(arg => arg.startsWith('query=query('))) { console.error('Unexpected fixture GraphQL mutation'); process.exit(99); }
 const live = path.join(root,'.local','merge-live.json');
 const pullRequest = fs.existsSync(live) ? JSON.parse(fs.readFileSync(live,'utf8')) : {
  id:'PR_fixture',number:42,url:'https://github.com/fixture/repo/pull/42',state:'OPEN',
  headRefOid:git('rev-parse','topic'),baseRefName:'main',isDraft:false,mergeCommit:null,
  autoMergeRequest:null,isInMergeQueue:false,isMergeQueueEnabled:false,
  mergeable:'MERGEABLE',mergeStateStatus:'CLEAN'};
 if (args.includes('--include')) process.stdout.write('HTTP/2.0 200 OK\\r\\n\\r\\n');
 console.log(JSON.stringify({data:{repository:{id:'R_fixture',databaseId:1,
  nameWithOwner:'fixture/repo',url:'https://github.com/fixture/repo',
  ref:{target:{oid:git('rev-parse','main')}},pullRequest}}}));
} else if (args.includes('repos/fixture/repo/pulls/42')) {
 const overrides = path.join(root,'.local','live.json');
 console.log(JSON.stringify({number:42,node_id:'PR_fixture',html_url:'https://github.com/fixture/repo/pull/42',state:'open',draft:false,
  user:{login:'fixture'},base:{ref:'main',sha:git('rev-parse','main'),repo},
  head:{ref:'topic',sha:git('rev-parse','topic'),repo}, changed_files:${productCount},
  ...(fs.existsSync(overrides) ? JSON.parse(fs.readFileSync(overrides,'utf8')) : {})}));
} else if (args.some(a => a.startsWith('repos/fixture/repo/collaborators/'))) {
 console.log('{"permission":"write"}');
} else if (args.some(a => a.startsWith('repos/fixture/repo/pulls/42/files?'))) {
 console.log(JSON.stringify([${JSON.stringify(product)}.map(filename => ({filename,status:'modified',additions:1,deletions:0}))]));
} else { console.error('Unexpected fixture GitHub request: '+JSON.stringify(args)); process.exit(99); }
`,
    { mode: 0o755 },
  );
  const repository = {
    id: "R_fixture",
    nameWithOwner: "fixture/repo",
    url: "https://github.com/fixture/repo",
  };
  const meta = {
    number: 42,
    headRefOid: incoming,
    headRefName: "topic",
    baseRefName: "main",
    baseRefOid: base,
    url: "https://github.com/fixture/repo/pull/42",
    state: "OPEN",
    isCrossRepository: false,
    baseRepository: { ...repository, databaseId: 1 },
    headRepository: { ...repository, name: "repo" },
    headRepositoryOwner: { login: "fixture", is_bot: false },
    files: product.map((path) => ({ path })),
  };
  const local = (name: string) => join(worktree, ".local", name);
  const prepGit = (...args: string[]) => git(worktree, ...args);
  const readLocal = (name: string) => readFileSync(local(name));
  const writeLocal = (name: string, bytes: string | Uint8Array) =>
    writeFileSync(local(name), bytes);
  const snapshot = (names: string[]) =>
    Object.fromEntries(names.map((name) => [name, readLocal(name)]));
  const expectSnapshot = (files: Record<string, Buffer>) => {
    for (const [name, bytes] of Object.entries(files)) {
      expect(readLocal(name)).toEqual(bytes);
    }
  };
  const expectAbsent = (...names: string[]) => {
    for (const name of names) {
      expect(existsSync(local(name)), name).toBe(false);
    }
  };
  writeLocal("pr-meta.json", JSON.stringify(meta));
  writeLocal(
    "pr-meta.env",
    `PR_NUMBER=42\nPR_HEAD=topic\nPR_HEAD_SHA=${incoming}\nPR_HEAD_REPO_URL=https://github.com/fixture/repo\n`,
  );
  writeLocal("review-mode.env", "REVIEW_MODE=pr\n");
  const review = validReview(incoming);
  review.recommendation = "NEEDS WORK";
  review.issueValidation.status = "valid";
  review.findings.push({
    id: "I1",
    severity: incomingSeverity,
    title: "Broken behavior",
    area: product[0]!,
    fix: "Repair behavior",
  });
  writeLocal("review.json", JSON.stringify(review));
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
  writeProduct(worktree, product, "corrected\n");
  commit(worktree, "fix: fixture correction");
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
    writeProduct(repo, changed, `${label}\n`);
    commit(repo, `test: ${label}`);
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
    const entry = (revision: string, path: string) => {
      const [mode, , oid] = git(worktree, "ls-tree", revision, "--", path).split(/\s/u);
      return { mode, oid };
    };
    const bytes = Buffer.from(`resolved against ${baseline}\n`);
    writeLocal("resolution.txt", bytes);
    writeLocal(
      "resolutions.json",
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
    return cliFlags({
      "--expected-head": source,
      "--baseline": baseline,
      "--resolutions": local("resolutions.json"),
    });
  };
  const successor = (baseline: string) => [
    ...manifest(baseline, [product[0]!]),
    ...cliFlags({
      "--expected-tree": prepGit("rev-parse", "HEAD^{tree}"),
      "--expected-review": prepGit("hash-object", "--no-filters", local("correction-review.json")),
      "--predecessor-head": /^PREP_BASELINE_REFRESH_HEAD=([a-f0-9]{40})$/mu.exec(
        readLocal("prep-context.env").toString(),
      )![1]!,
      "--predecessor-binding": prepGit(
        "hash-object",
        "--no-filters",
        local("prepare-baseline.json"),
      ),
    }),
  ];
  return {
    root,
    env,
    key,
    signers,
    repo,
    worktree,
    local,
    prepGit,
    readLocal,
    writeLocal,
    snapshot,
    expectSnapshot,
    expectAbsent,
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
