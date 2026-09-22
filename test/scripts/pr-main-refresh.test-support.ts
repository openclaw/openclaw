import { spawnSync } from "node:child_process";
import {
  chmodSync,
  constants as fsConstants,
  cpSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { copyPrWrapperSources, linkPrWrapperDependencies } from "./pr-wrapper.test-support.js";

const templateDirs = useAutoCleanupTempDirTracker(afterAll);
const fixtureTemplates = new Map<boolean, ReturnType<typeof createMainRefreshTemplate>>();

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

function createFixtureGit(root: string) {
  const home = join(root, "home");
  mkdirSync(home);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    TMPDIR: root,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    // The source template is copied immediately after commits; a detached
    // repack must not remove loose objects while that copy is reading them.
    GIT_CONFIG_PARAMETERS: "'maintenance.auto=false' 'gc.auto=0'",
    GIT_ALLOW_PROTOCOL: "file",
    GIT_TERMINAL_PROMPT: "0",
    XDG_CONFIG_HOME: join(home, ".config"),
  };
  const realGit = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
  function git(cwd: string, ...args: string[]) {
    const result = spawnSync(realGit, args, { cwd, env, encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
    }
    return result.stdout.trim();
  }
  return { env, realGit, git };
}

function createMainRefreshTemplate(directory: string, perWorktreeConfig: boolean) {
  const root = realpathSync(directory);
  const canonical = join(root, "canonical");
  const origin = join(root, "origin.git");
  const { git } = createFixtureGit(root);
  git(root, "init", "--bare", "-b", "main", origin);
  git(root, "init", "-b", "main", canonical);
  git(canonical, "config", "user.name", "OpenClaw Test");
  git(canonical, "config", "user.email", "test@example.invalid");
  git(canonical, "config", "core.hooksPath", "/dev/null");
  if (perWorktreeConfig) {
    git(canonical, "config", "extensions.worktreeConfig", "true");
  }
  copyPrWrapperSources(canonical);
  cpSync(join(process.cwd(), ".github", "workflows"), join(canonical, ".github", "workflows"), {
    recursive: true,
  });
  writeFileSync(join(canonical, "package.json"), '{"type":"module"}\n');
  cpSync(join(process.cwd(), "tsconfig.json"), join(canonical, "tsconfig.json"));
  writeFileSync(join(canonical, ".gitignore"), ".worktrees/\n.local/\nnode_modules\n");
  mkdirSync(join(canonical, "src"), { recursive: true });
  writeFileSync(join(canonical, "src", "subject.ts"), "export const subject = 'base';\n");
  git(canonical, "add", ".");
  git(canonical, "commit", "-qm", "test: trusted native wrapper");
  const main = git(canonical, "rev-parse", "HEAD");
  git(canonical, "remote", "add", "origin", "../origin.git");
  git(canonical, "push", "origin", "main");
  git(canonical, "checkout", "-qb", "topic");
  writeFileSync(join(canonical, "src", "subject.ts"), "export const subject = 'reviewed';\n");
  git(canonical, "commit", "-qam", "test: reviewed change");
  const head = git(canonical, "rev-parse", "HEAD");
  git(canonical, "commit", "--allow-empty", "-qm", "test: different commit with identical tree");
  const sameTreeHead = git(canonical, "rev-parse", "HEAD");
  git(canonical, "update-ref", "refs/heads/topic", head);
  git(canonical, "push", "origin", "topic", `${head}:refs/pull/42/head`);
  git(canonical, "checkout", "-q", "main");
  writeFileSync(join(canonical, "src", "subject.ts"), "export const subject = 'main moved';\n");
  git(canonical, "commit", "-qam", "test: main movement");
  const movedMain = git(canonical, "rev-parse", "HEAD");
  git(canonical, "commit", "--allow-empty", "-qm", "test: publication checkpoint movement");
  const gateMain = git(canonical, "rev-parse", "HEAD");
  git(canonical, "push", "origin", `${gateMain}:refs/heads/gate-movement`);
  git(canonical, "push", "origin", `${movedMain}:refs/heads/movement`);
  git(canonical, "checkout", "--detach", main);
  // Pack private checkout copies, retaining unreferenced objects such as sameTreeHead.
  // Leave origin loose so filtered-fetch fixtures keep their original transport behavior.
  git(canonical, "repack", "-ad", "--keep-unreachable");
  return { canonical, origin, main, head, sameTreeHead, movedMain, gateMain };
}

// Keep the complete wrapper/lock/entry/gate owners. Command resolution, Git
// transport faults, and GitHub responses are synthetic.
export function createMainRefreshFixture(
  directory: string,
  options: {
    perWorktreeConfig?: boolean;
    partialCloneFilter?: string;
    precreateWorktree?: boolean;
  } = {},
) {
  // Existing regression fixtures retain worktreeConfig; acceleration starts with
  // a distinct pristine fixture, never a shared-config reset after sparse use.
  const perWorktreeConfig = options.perWorktreeConfig !== false;
  let template = fixtureTemplates.get(perWorktreeConfig);
  if (!template) {
    template = createMainRefreshTemplate(
      templateDirs.make("openclaw-pr-main-refresh-template-"),
      perWorktreeConfig,
    );
    fixtureTemplates.set(perWorktreeConfig, template);
  }
  const root = realpathSync(directory);
  const canonical = join(root, "canonical");
  const origin = join(root, "origin.git");
  const worktree = join(canonical, ".worktrees", "pr-42");
  const bin = join(root, "bin");
  mkdirSync(bin);
  const { env, realGit, git } = createFixtureGit(root);
  const { main, head, sameTreeHead, movedMain, gateMain } = template;
  const copyOptions = { recursive: true, mode: fsConstants.COPYFILE_FICLONE };
  cpSync(template.origin, origin, copyOptions);
  if (options.partialCloneFilter) {
    git(origin, "config", "uploadpack.allowFilter", "true");
    git(
      root,
      "clone",
      `--filter=${options.partialCloneFilter}`,
      pathToFileURL(origin).href,
      canonical,
    );
    git(canonical, "config", "user.name", "OpenClaw Test");
    git(canonical, "config", "user.email", "test@example.invalid");
    git(canonical, "config", "core.hooksPath", "/dev/null");
    if (perWorktreeConfig) {
      git(canonical, "config", "extensions.worktreeConfig", "true");
    }
  } else {
    // Copy complete object stores (including sameTreeHead), never shared refs or
    // hardlinks. Create worktrees afterward so their absolute back-links stay local.
    cpSync(template.canonical, canonical, copyOptions);
  }
  git(canonical, "remote", "set-url", "origin", origin);
  git(canonical, "config", `url.${origin}.insteadOf`, "https://github.com/fixture/repo");
  git(
    canonical,
    "config",
    "--add",
    `url.${origin}.insteadOf`,
    "https://github.com/fixture/repo.git",
  );
  linkPrWrapperDependencies(canonical);
  const local = join(worktree, ".local");
  const metadata = {
    id: "fixture-pr",
    number: 42,
    title: "Synthetic reviewed change",
    url: "https://github.com/fixture/repo/pull/42",
    state: "OPEN",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    mergeCommit: null,
    autoMergeRequest: null,
    isInMergeQueue: false,
    isMergeQueueEnabled: false,
    isDraft: false,
    isCrossRepository: false,
    author: { login: "fixture" },
    baseRefName: "main",
    baseRefOid: main,
    baseRepository: {
      id: "fixture-repo",
      databaseId: 123,
      nameWithOwner: "fixture/repo",
      url: "https://github.com/fixture/repo",
    },
    headRefName: "topic",
    headRefOid: head,
    headRepository: { name: "repo", nameWithOwner: "fixture/repo", url: origin },
    headRepositoryOwner: { login: "fixture", is_bot: false },
    changedFiles: 1,
    additions: 1,
    deletions: 1,
    files: [{ path: "src/subject.ts", additions: 1, deletions: 1, changeType: "MODIFIED" }],
  };
  mkdirSync(join(canonical, ".worktrees"), { recursive: true });
  if (options.precreateWorktree !== false) {
    git(canonical, "worktree", "add", "--detach", worktree, head);
    mkdirSync(local);
    writeFileSync(join(local, "pr-meta.json"), JSON.stringify(metadata));
    writeFileSync(
      join(local, "pr-meta.env"),
      `PR_NUMBER=42\nPR_URL=https://example.invalid/pr/42\nPR_AUTHOR=fixture\nPR_BASE=main\nPR_HEAD=topic\nPR_HEAD_SHA=${head}\nPR_HEAD_REPO_URL=${origin}\n`,
    );
    writeFileSync(join(local, "review-mode.env"), "REVIEW_MODE=pr\n");
    writeFileSync(
      join(local, "review.md"),
      [
        `Review artifact for PR #42 at ${head}`,
        ..."ABCDEFGHIJ".split("").map((letter) => `${letter}) Synthetic evidence.`),
      ].join("\n"),
    );
    writeFileSync(
      join(local, "review.json"),
      JSON.stringify({
        pr: { number: 42, headSha: head },
        recommendation: "READY FOR /prepare-pr",
        findings: [],
        nitSweep: { performed: true, status: "none", summary: "No optional nits." },
        behavioralSweep: {
          performed: true,
          status: "pass",
          summary: "Synthetic tooling fixture.",
          silentDropRisk: "none",
          branches: [
            {
              path: "src/subject.ts",
              decision: "synthetic change",
              outcome: "reviewed fixture value",
            },
          ],
        },
        issueValidation: {
          performed: true,
          source: "pr_body",
          status: "valid",
          summary: "Synthetic fixture.",
        },
        tests: { ran: ["synthetic local proof"], gaps: [], result: "pass" },
        docs: "not_applicable",
        changelog: "not_required",
      }),
    );
  }
  const controlFile = join(root, "control.json");
  const eventsFile = join(root, "events.jsonl");
  const control = {
    metadata,
    authorPermission: "write",
    failFetch: false,
    failPrFetch: false,
    prIdentityDriftAfterFetch: "" as "" | "oid" | "branch" | "repository",
    wrongPrFetch: false,
    failDetach: false,
    failFetchAt: 0,
    pauseFetchAt: 0,
    failAuth: false,
    writerRateLimited: false,
    moveAfterFirstFetch: false,
    moveAtGate: false,
    moveAtChecks: false,
    moveAtCi: false,
    moveSharedAfterFetch: false,
    remoteOnlyBase: "",
    hostedCi: "scheduled" as
      | "scheduled"
      | "release"
      | "missing"
      | "stale"
      | "failed"
      | "wrong-head"
      | "unmarked"
      | "wrong-workflow"
      | "scheduled-failure"
      | "api-error",
    requiredChecks: "pass" as "pass" | "fail" | "pending" | "api-error" | "missing-gate",
    requiredCheckRows: undefined as
      | Array<{ name: string; bucket: string; state: string }>
      | undefined,
    reviewComments: [
      {
        id: 1,
        body: `<!-- clawsweeper-review-version item=42 reviewed_at=${new Date().toISOString()} sha=${head} source_revision=${"b".repeat(64)} lease_owner=github-run-1 lease_comment_id=1 v=1 -->

<!-- clawsweeper-review item=42 -->`,
        user: { id: 274271284, login: "clawsweeper[bot]", type: "Bot" },
      },
    ],
  };
  writeFileSync(controlFile, JSON.stringify(control));
  writeFileSync(eventsFile, "");
  const prelude = `#!${process.execPath}
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';

const controlFile = ${JSON.stringify(controlFile)};
const eventsFile = ${JSON.stringify(eventsFile)};
const control = JSON.parse(readFileSync(controlFile, 'utf8'));
const args = process.argv.slice(2);
const git = ${JSON.stringify(realGit)};
const origin = ${JSON.stringify(origin)};
const canonical = ${JSON.stringify(canonical)};
const movedMain = ${JSON.stringify(movedMain)};

function event(value) {
  appendFileSync(eventsFile, JSON.stringify(value) + '\\n');
}

function runGit(args, input) {
  const result = spawnSync(git, args, { encoding: 'utf8', input });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}
`;
  const instrumentedGit = join(bin, "git-instrumented.mjs");
  writeFileSync(
    instrumentedGit,
    prelude +
      `
event({ kind: 'git-runtime', args });
const prFetch = args.includes('fetch') && args.some(arg =>
  arg.startsWith('pull/42/head') ||
  arg.replace(/^\\+/, '').split(':')[0] === control.metadata.headRefOid
);
if ((control.failPrFetch && prFetch) ||
    (control.failDetach && args[0] === 'checkout' && args[1] === '--detach')) {
  console.error('fatal: injected prepare handoff failure');
  process.exit(73);
}
const mainFetch = args.includes('fetch') && args.some(arg =>
  arg === 'main' || arg.startsWith('+refs/heads/main:') || arg === 'refs/heads/main'
);
if (mainFetch) {
  event({ kind: 'main-fetch', cwd: process.cwd(), args });
  const count = readFileSync(eventsFile, 'utf8').trim().split('\\n')
    .filter(line => JSON.parse(line).kind === 'main-fetch').length;
  if (control.failFetch || control.failFetchAt === count) {
    console.error('fatal: injected main fetch failure');
    process.exit(128);
  }
  if (control.pauseFetchAt === count) {
    args.splice(args.indexOf('fetch') + 1, 0,
      ${JSON.stringify(`--upload-pack=${join(root, "hold-upload-pack")}`)});
  }
}
if (args.some(arg => ['merge-base', 'diff', 'checkout', 'update-ref'].includes(arg))) {
  event({ kind: 'git-decision', args });
}
if (args.includes('push')) {
  const cleanup = ['push', '--force-with-lease=refs/heads/topic:' + control.metadata.headRefOid,
    'https://github.com/fixture/repo.git', ':refs/heads/topic'];
  if (JSON.stringify(args) !== JSON.stringify(cleanup)) {
    event({ kind: 'unexpected-push', args });
    process.exit(98);
  }
  event({ kind: 'leased-cleanup', args });
}
const result = spawnSync(git, args, { stdio: 'inherit' });
if (prFetch && result.status === 0) {
  const prefix = args.slice(0, args.indexOf('fetch'));
  const destination = args.at(-1).split(':')[1];
  if (control.wrongPrFetch && destination) {
    runGit([...prefix, 'update-ref', destination.startsWith('refs/') ? destination : 'refs/heads/' + destination,
      ${JSON.stringify(sameTreeHead)}]);
  }
  if (control.prIdentityDriftAfterFetch === 'oid') {
    control.metadata.headRefOid = ${JSON.stringify(sameTreeHead)};
  } else if (control.prIdentityDriftAfterFetch === 'branch') {
    control.metadata.headRefName = 'renamed';
  } else if (control.prIdentityDriftAfterFetch === 'repository') {
    control.metadata.headRepository.nameWithOwner = 'fixture/replacement';
  }
  if (control.prIdentityDriftAfterFetch) writeFileSync(controlFile, JSON.stringify(control));
}
if (mainFetch && result.status === 0) {
  const prefix = args.slice(0, args.indexOf('fetch'));
  const destination = args.at(-1).split(':')[1] || 'FETCH_HEAD';
  const fetched = runGit([...prefix, 'rev-parse', destination]);
  if (control.moveSharedAfterFetch) {
    runGit(['-C', canonical, 'update-ref', 'refs/remotes/origin/main', movedMain]);
  }
  if (control.moveAfterFirstFetch) {
    runGit(['-C', origin, 'update-ref', 'refs/heads/main', movedMain]);
    control.moveAfterFirstFetch = false;
    writeFileSync(controlFile, JSON.stringify(control));
  }
  event({
    kind: 'fetched',
    sha: fetched,
    shared: spawnSync(git, ['-C', canonical, 'rev-parse', '--verify', 'refs/remotes/origin/main'],
      { encoding: 'utf8' }).stdout.trim(),
  });
}
process.exit(result.status ?? 1);
`,
  );
  // Only stateful faults need Node. Record observation-only decisions in the
  // shell so repeated diff/ref guards do not boot another runtime for real Git.
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh
instrument=false
decision=false
for arg in "$@"; do
  case "$arg" in
    fetch|checkout|push) instrument=true ;;
    merge-base|diff|update-ref) decision=true ;;
  esac
done
if [ "$instrument" = true ]; then
  exec ${shellQuote(process.execPath)} ${shellQuote(instrumentedGit)} "$@"
fi
if [ "$decision" = true ]; then
  jq -cn --args '{kind:"git-decision",args:$ARGS.positional}' -- "$@" >> ${shellQuote(eventsFile)} || exit
fi
exec ${shellQuote(realGit)} "$@"
`,
  );
  writeFileSync(
    join(bin, "gh"),
    prelude +
      `
event({ kind: 'gh', args });
if (args[0] === 'browse') {
  console.log('https://github.com/fixture/repo');
  process.exit(0);
}
const repositoryLocatorRequest = JSON.stringify(args) === JSON.stringify(['api', '--hostname', 'github.com', 'repos/fixture/repo']);
if (repositoryLocatorRequest) {
  // Locator metadata cannot satisfy the separate fresh repository-ID binding.
  console.log(JSON.stringify({ full_name: 'fixture/repo', html_url: 'https://github.com/fixture/repo' }));
  process.exit(0);
}
if (args[0] === 'api' && args.includes('repos/fixture/repo') &&
    JSON.stringify(args.filter(arg => arg !== '--include')) !== JSON.stringify(['api', '--hostname', 'github.com', 'repos/fixture/repo', '-H', 'Cache-Control: max-age=0'])) {
  throw new Error('Unexpected authoritative repository request');
}
let value;
if (args[0] === 'auth') process.exit(1);
if (args[0] === 'pr' && args[1] === 'view') {
  value = control.metadata;
} else if (args[0] === 'pr' && args[1] === 'merge' && args.includes('--auto')) {
  if (args[2] !== '42' || !args.includes('--squash') ||
      args[args.indexOf('--match-head-commit') + 1] !== control.metadata.headRefOid) {
    throw new Error('Unpinned synthetic auto-merge');
  }
  control.metadata.autoMergeRequest = { mergeMethod: 'SQUASH' };
  writeFileSync(controlFile, JSON.stringify(control));
  value = {};
} else if (args[0] === 'api' && args.includes('graphql') && args.includes('--input')) {
  const payload = JSON.parse(readFileSync(0, 'utf8'));
  const input = payload.variables.input;
  if (input.expectedHeadOid !== control.metadata.headRefOid || input.pullRequestId !== control.metadata.id ||
      input.mergeMethod !== 'SQUASH' || Object.hasOwn(input, 'commitHeadline')) {
    throw new Error('Unpinned synthetic merge');
  }
  const parent = runGit(['-C', origin, 'rev-parse', 'refs/heads/main']);
  const tree = runGit(['-C', origin, 'merge-tree', '--write-tree', parent, control.metadata.headRefOid]);
  const body = input.commitBody;
  const landed = runGit(['-C', origin, '-c', 'user.name=Fixture', '-c',
    'user.email=fixture@example.invalid', 'commit-tree', tree, '-p', parent], 'Fixture squash\\n\\n' + body);
  runGit(['-C', origin, 'update-ref', 'refs/heads/main', landed, parent]);
  control.metadata.state = 'MERGED';
  control.metadata.mergeCommit = { oid: landed };
  writeFileSync(controlFile, JSON.stringify(control));
  value = {};
} else if (args[0] === 'pr' && args[1] === 'checks') {
  if (control.moveAtChecks) {
    runGit(['-C', origin, 'update-ref', 'refs/heads/main', movedMain]);
  }
  event({ kind: 'required-checks' });
  if (control.requiredChecks === 'api-error') {
    console.error('GitHub API unavailable');
    process.exit(1);
  }
  value = [{ name: 'openclaw/ci-gate', bucket: 'pass', state: 'SUCCESS' }];
  if (control.requiredChecks === 'missing-gate') value = [];
  if (control.requiredChecks === 'pending') {
    value[0] = { name: 'openclaw/ci-gate', bucket: 'pending', state: 'IN_PROGRESS' };
    process.exitCode = 8;
  }
  if (control.requiredChecks === 'fail') value.push({
    name: 'independent required check', bucket: control.requiredChecks,
    state: 'FAILURE',
  });
  if (control.requiredCheckRows) value = control.requiredCheckRows;
} else if (args[0] === 'repo' && args[1] === 'view') {
  value = { id: 'fixture-repo', nameWithOwner: 'fixture/repo', url: 'https://github.com/fixture/repo' };
} else if (args[0] === 'run' && args[1] === 'view') {
  if (control.moveAtCi) {
    runGit(['-C', origin, 'update-ref', 'refs/heads/main', movedMain]);
  }
  event({ kind: 'ci-completed' });
  value = control.hostedCi === 'scheduled'
    ? { status: 'completed', conclusion: 'success' }
    : { status: 'in_progress', conclusion: null };
} else if (args[0] === 'run' && args[1] === 'list') {
  value = [];
} else if (args[0] === 'api') {
  const endpoint = args.find((arg, index) => index > 0 &&
    (arg === 'graphql' || arg === 'user' || arg === 'rate_limit' || arg === 'users/fixture' || arg.startsWith('repos/')));
  if (endpoint === 'rate_limit') {
    value = { resources: {
      graphql: { remaining: 0, limit: 5000, reset: 1893456000 },
      core: { remaining: 4999, limit: 5000, reset: 1893459600 },
    } };
  } else if (endpoint === 'user') {
    if (control.failAuth) process.exit(1);
    if (!args.includes('--include')) throw new Error('Writer identity requires response headers');
    if (control.writerRateLimited) {
      process.stdout.write('HTTP/2.0 403 Forbidden\\nX-RateLimit-Resource: core\\r\\nX-RateLimit-Remaining: 0\\r\\n\\r\\n');
      console.log(JSON.stringify({ message: 'API rate limit exceeded for synthetic writer' }));
      process.exit(1);
    }
    value = { login: 'fixture' };
  } else if (endpoint === 'graphql') {
    if (control.failAuth) process.exit(1);
    if (args.some(arg => arg.includes('viewer{login}'))) {
      if (control.writerRateLimited) {
        process.stdout.write('HTTP/2.0 403 Forbidden\\nX-RateLimit-Resource: graphql\\nX-RateLimit-Remaining: 0\\n\\n');
        console.log(JSON.stringify({ errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded for synthetic writer' }] }));
        process.exit(1);
      }
      value = { data: { viewer: { login: 'fixture' } } };
    } else if (args.some(arg => arg.includes('addComment('))) {
      value = { data: { addComment: { commentEdge: { node: { url: 'https://example.invalid/pr/42#completion' } } } } };
    } else if (args.some(arg => arg.includes('viewerMergeBodyText'))) {
      value = { data: { repository: { pullRequest: {
        headRefOid: control.metadata.headRefOid,
        author: { ...control.metadata.author, __typename: 'User' },
        isMergeQueueEnabled: control.metadata.isMergeQueueEnabled,
        viewerMergeHeadlineText: 'Fixture merge headline',
        viewerMergeBodyText: 'Reviewed fixture body',
      } } } };
    } else if (args.some(arg => arg.includes('ref(qualifiedName:'))) {
      value = { data: { repository: {
        id: 'fixture-repo', databaseId: 123, nameWithOwner: 'fixture/repo', url: 'https://github.com/fixture/repo',
        ref: { target: { oid: runGit(['-C', origin, 'rev-parse', 'refs/heads/main']) } },
        pullRequest: control.metadata,
      } } };
    } else {
      throw new Error('Unexpected GraphQL request');
    }
  } else if (endpoint === 'repos/fixture/repo') {
    value = {
      id: 123, node_id: 'fixture-repo', full_name: 'fixture/repo',
      html_url: 'https://github.com/fixture/repo',
      permissions: { admin: true },
    };
  } else if (endpoint === 'repos/fixture/repo/branches/main/protection') {
    // Hosted CI fixtures retain GraphQL through explicit classic branch protection.
    value = {};
  } else if (endpoint === 'repos/fixture/repo/git/ref/heads/main') {
    value = { ref: 'refs/heads/main', object: { type: 'commit',
      sha: runGit(['-C', origin, 'rev-parse', 'refs/heads/main']) } };
  } else if (endpoint === 'repos/fixture/repo/commits/${head}') {
    const [name, email] = runGit(['-C', origin, 'show', '-s', '--format=%an%n%ae', ${JSON.stringify(head)}]).split('\\n');
    value = { commit: { author: { name, email } }, author: { ...control.metadata.author, type: 'User' } };
  } else if (endpoint.startsWith('repos/fixture/repo/commits?')) {
    const query = new URL(endpoint, 'https://github.com').searchParams;
    const commits = runGit(['-C', origin, 'rev-list', '--max-count=' + query.get('per_page'), query.get('sha')]).split('\\n');
    value = commits.map(oid => {
      const [name, email] = runGit(['-C', origin, 'show', '-s', '--format=%an%n%ae', oid + '^{commit}']).split('\\n');
      return { sha: oid, commit: { author: { name, email } },
        author: oid === ${JSON.stringify(head)} ? { ...control.metadata.author, type: 'User' } : null };
    });
  } else if (endpoint === 'users/fixture') {
    value = { id: 123 };
  } else if (endpoint?.includes('/commits/') && endpoint.includes('/check-runs?')) {
    value = [{ check_runs: [] }];
  } else if (endpoint?.includes('/commits/') && endpoint.includes('/status?')) {
    value = [{ statuses: [] }];
  } else if (new RegExp('^repos/fixture/repo/commits/[0-9a-f]{40}$').test(endpoint)) {
    const [name, email] = runGit(['-C', origin, 'show', '-s', '--format=%an%n%ae',
      endpoint.split('/').at(-1) + '^{commit}']).split('\\n');
    // Synthetic Git authors have no linked GitHub account.
    value = { commit: { author: { name, email } }, author: null };
  } else if (endpoint === 'repos/fixture/repo/collaborators/fixture/permission') {
    if (control.authorPermission === 'error') process.exit(1);
    value = { permission: control.authorPermission };
  } else if (endpoint.startsWith('repos/fixture/repo/commits/')) {
    const oid = endpoint.slice('repos/fixture/repo/commits/'.length);
    if (!/^[0-9a-f]{40}$/.test(oid)) throw new Error('Invalid synthetic commit identity');
    const [name, email] = runGit(['-C', origin, 'show', '-s', '--format=%an%n%ae', oid]).split('\\n');
    value = {
      commit: { author: { name, email } },
      author: { login: control.metadata.author.login, type: 'User' },
    };
  } else if (endpoint.startsWith('repos/fixture/repo/issues/42/comments')) {
    if (args.includes('POST')) {
      value = { html_url: 'https://example.invalid/pr/42#completion' };
    } else {
      event({ kind: 'review-comments' });
      value = [control.reviewComments];
    }
  } else if (endpoint === 'repos/fixture/repo/pulls/' + control.metadata.number + '/files?per_page=100') {
    value = [control.metadata.files.map(file => ({
      filename: file.path, additions: file.additions, deletions: file.deletions,
      status: file.changeType === 'DELETED' ? 'removed' : file.changeType.toLowerCase(),
    }))];
  } else if (endpoint === 'repos/fixture/repo/pulls/' + control.metadata.number) {
    const baseSha = control.remoteOnlyBase || control.metadata.baseRefOid;
    value = {
      number: control.metadata.number,
      node_id: control.metadata.id,
      title: control.metadata.title,
      state: control.metadata.state === 'OPEN' ? 'open' : 'closed',
      merged: control.metadata.state === 'MERGED',
      merge_commit_sha: control.metadata.mergeCommit?.oid ?? null,
      auto_merge: control.metadata.autoMergeRequest
        ? { merge_method: control.metadata.autoMergeRequest.mergeMethod.toLowerCase() } : null,
      merged_at: control.metadata.state === 'MERGED' ? '2026-01-01T00:00:00Z' : null,
      draft: control.metadata.isDraft,
      user: control.metadata.author,
      html_url: control.metadata.url,
      body: control.metadata.body,
      labels: control.metadata.labels,
      assignees: control.metadata.assignees,
      changed_files: control.metadata.changedFiles,
      additions: control.metadata.additions,
      deletions: control.metadata.deletions,
      mergeable: control.metadata.mergeable === 'MERGEABLE' ? true : control.metadata.mergeable === 'CONFLICTING' ? false : null,
      mergeable_state: control.metadata.mergeStateStatus.toLowerCase(),
      head: { sha: control.metadata.headRefOid, ref: control.metadata.headRefName, repo: {
        id: 123, full_name: control.metadata.headRepository.nameWithOwner,
        name: control.metadata.headRepository.name, html_url: control.metadata.headRepository.url,
        owner: control.metadata.headRepositoryOwner,
      } },
      base: { ref: control.metadata.baseRefName, sha: baseSha, repo: {
        id: control.metadata.isCrossRepository ? 456 : 123,
        node_id: 'fixture-repo', full_name: 'fixture/repo', html_url: 'https://github.com/fixture/repo',
      } },
    };
  } else if (endpoint.endsWith('/actions/workflows/ci.yml/runs')) {
    event({ kind: 'ci-watched' });
    value = { workflow_runs: [{ id: 1, conclusion: null }] };
  } else if (endpoint.includes('/actions/runs/1/attempts/1/jobs?')) {
    value = { total_count: 2, jobs: ['macos-node', 'macos-swift'].map(name => ({
      name, run_id: 1, run_attempt: 1, status: 'queued', conclusion: null,
      runner_id: null, steps: [],
    })) };
  } else if (endpoint === 'repos/fixture/repo/actions/runs/1') {
    value = { run_attempt: 1, status: 'in_progress', conclusion: null };
  } else if (/^repos\\/(fixture\\/repo|openclaw\\/openclaw)\\/actions\\/runs\\?/.test(endpoint)) {
    if (control.remoteOnlyBase && !control.remoteOnlyBaseMoved) {
      runGit(['-C', origin, 'update-ref', 'refs/heads/main', control.remoteOnlyBase]);
      const localObject = spawnSync(git, ['-C', canonical, 'cat-file', '-e', control.remoteOnlyBase]);
      event({ kind: 'remote-only-base', sha: control.remoteOnlyBase, localObject: localObject.status === 0 });
      control.remoteOnlyBaseMoved = true;
      writeFileSync(controlFile, JSON.stringify(control));
    }
    if (control.moveAtGate) {
      runGit(['-C', origin, 'update-ref', 'refs/heads/main', ${JSON.stringify(gateMain)}]);
    }
    event({ kind: 'hosted-gate' });
    if (control.hostedCi === 'api-error') throw new Error('Hosted API unavailable');
    const workflows = [
      'CI', 'Blacksmith Testbox', 'Blacksmith ARM Testbox',
      'Blacksmith Build Artifacts Testbox', 'Workflow Sanity',
    ];
    value = {
      total_count: workflows.length,
      workflow_runs: workflows.map((name, index) => ({
        id: index + 1,
        name,
        event: 'pull_request',
        head_sha: control.metadata.headRefOid,
        status: 'completed',
        conclusion: 'success',
        updated_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
      })),
    };
    if (control.hostedCi !== 'scheduled') {
      Object.assign(value.workflow_runs[0], {
        status: control.hostedCi === 'scheduled-failure' ? 'completed' : 'in_progress',
        conclusion: control.hostedCi === 'scheduled-failure' ? 'failure' : null,
      });
      if (control.hostedCi !== 'missing') value.workflow_runs.push({
        id: 6, run_number: 6, name: 'CI', event: 'workflow_dispatch',
        head_sha: control.hostedCi === 'wrong-head' ? ${JSON.stringify(main)} : control.metadata.headRefOid,
        path: control.hostedCi === 'wrong-workflow' ? '.github/workflows/other.yml' : '.github/workflows/ci.yml',
        display_title: control.hostedCi === 'unmarked' ? 'CI' : 'CI release gate ' + control.metadata.headRefOid,
        status: 'completed', conclusion: control.hostedCi === 'failed' ? 'failure' : 'success',
        updated_at: new Date(Date.now() - (control.hostedCi === 'stale' ? 25 * 3600_000 : 0)).toISOString(),
        created_at: new Date().toISOString(),
      });
      value.total_count = value.workflow_runs.length;
    }
  } else {
    throw new Error('Unexpected GitHub API endpoint ' + endpoint);
  }
} else {
  throw new Error('Unexpected GitHub command ' + args.join(' '));
}
const jqIndex = args.indexOf('--jq');
if (args.includes('--include')) process.stdout.write('HTTP/2.0 200 OK\\n\\n');
if (jqIndex >= 0) {
  const result = spawnSync('jq', ['-r', args[jqIndex + 1]], {
    input: JSON.stringify(value),
    encoding: 'utf8',
  });
  process.stdout.write(result.stdout);
  process.exit(result.status ?? 1);
}
console.log(JSON.stringify(value));
    `,
  );
  writeFileSync(
    join(bin, "rg"),
    `#!/bin/sh
exec grep "$@"
`,
  );
  for (const command of ["git", "gh", "rg"]) {
    chmodSync(join(bin, command), 0o755);
  }
  env.PATH = `${bin}${delimiter}${env.PATH ?? ""}`;
  env.OPENCLAW_GH_BIN = join(bin, "gh");
  env.GH_REPO = "fixture/repo";
  env.OPENCLAW_TESTBOX = "1";
  // Advance only the real watcher's polling clock, so a stuck CI fixture
  // reaches its normal deadline without an hour-long regression test.
  const clock = join(root, "watch-clock.mjs");
  writeFileSync(
    clock,
    `
import { syncBuiltinESMExports } from 'node:module';
import timers from 'node:timers/promises';
if (process.argv[1]?.endsWith('/watch-pr-ci.mts')) {
  const realNow = Date.now;
  let waited = 0;
  Date.now = () => realNow() + waited;
  timers.setTimeout = async milliseconds => { waited += milliseconds; };
  syncBuiltinESMExports();
}
`,
  );
  return {
    root,
    canonical,
    origin,
    worktree,
    local,
    head,
    sameTreeHead,
    main,
    movedMain,
    gateMain,
    env,
    git,
    metadata,
    seedPreparedMerge() {
      // Merge-only cases need prepared inputs, not another prepare/gates/push run.
      // Preparation lifecycle cases still create these artifacts through the wrapper.
      git(worktree, "checkout", "-B", "pr-42-prep", head);
      git(worktree, "update-ref", "refs/heads/pr-42", head);
      writeFileSync(
        join(local, "prep-context.env"),
        `PR_NUMBER=42\nPR_HEAD=topic\nPR_HEAD_SHA_BEFORE=${head}\nPREP_BRANCH=pr-42-prep\nPR_AUTHOR_ACCESS_AT_PREP=maintainer\n`,
      );
      writeFileSync(
        join(local, "prep.env"),
        `PR_NUMBER=42\nPR_AUTHOR=fixture\nPR_URL=https://github.com/fixture/repo/pull/42\nPR_HEAD=topic\nPR_HEAD_SHA_BEFORE=${head}\nPREP_HEAD_SHA=${head}\nLOCAL_PREP_HEAD_SHA=${head}\nPREP_MAINLINE_BASE_SHA=${main}\nPREP_REPLACED_HOSTED_ANCESTRY=false\nPREP_AUTHOR_ACCESS=maintainer\n`,
      );
      writeFileSync(
        join(local, "gates.env"),
        `PR_NUMBER=42\nDOCS_ONLY=false\nCHANGELOG_REQUIRED=false\nGATES_MODE=hosted_exact_or_recent_parent\nHOSTED_GATES_TARGET_HEAD_SHA=${head}\nLAST_VERIFIED_HEAD_SHA=${head}\n`,
      );
      writeFileSync(join(local, "prep.md"), "Prepared synthetic merge fixture.\n");
    },
    configure(update: Partial<typeof control>) {
      Object.assign(control, update);
      if (control.hostedCi === "scheduled") {
        delete env.NODE_OPTIONS;
      } else {
        env.NODE_OPTIONS = `--import=${clock}`;
      }
      writeFileSync(controlFile, JSON.stringify(control));
    },
    events() {
      return readFileSync(eventsFile, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(
          (
            line,
          ): {
            kind: string;
            sha?: string;
            shared?: string;
            args?: string[];
            localObject?: boolean;
          } => JSON.parse(line),
        );
    },
    run(command: string | string[], bash = "bash", from = canonical) {
      const args = typeof command === "string" ? [command, "42"] : command;
      return spawnSync(bash, [join(from, "scripts", "pr"), ...args], {
        cwd: from,
        env,
        encoding: "utf8",
      });
    },
    shell(command: string, shellOptions: { supervised?: boolean } = {}) {
      // Sourced helpers bypass the entrypoint's Darwin heredoc protection.
      const bash = process.platform === "darwin" ? "/bin/bash" : "bash";
      const args = [
        "-c",
        `set -euo pipefail\nscript_parent_dir="$1/scripts"\nsource "$script_parent_dir/lib/plain-gh.sh"\nfor library in worktree operation-lock common changelog gates push review prepare-core merge; do source "$script_parent_dir/pr-lib/$library.sh"; done\n${command}`,
        "fixture",
        canonical,
      ];
      return spawnSync(
        shellOptions.supervised ? process.execPath : bash,
        shellOptions.supervised
          ? [join(canonical, "scripts/pr-lib/process-group-runner.mjs"), canonical, bash, ...args]
          : args,
        { cwd: canonical, env, encoding: "utf8" },
      );
    },
  };
}
