import { spawnSync } from "node:child_process";
import {
  constants as fsConstants,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import type { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const repoRoot = process.cwd();
type PublisherTempDirs = ReturnType<typeof useAutoCleanupTempDirTracker>;

function artifactFiles(directory: string) {
  return {
    read: (name: string) => readFileSync(join(directory, name), "utf8"),
    write: (name: string, text: string) => writeFileSync(join(directory, name), text),
    exists: (name: string) => existsSync(join(directory, name)),
  };
}

function sanitizedEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.OPENCLAW_PR_GATES_REMOTE;
  delete env.OPENCLAW_TESTBOX;
  delete env.OPENCLAW_TEST_PROJECTS_PARALLEL;
  delete env.OPENCLAW_VITEST_MAX_WORKERS;
  return { ...env, ...overrides };
}

export function runGatesBash(
  script: string,
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    sourcePrepareCore?: boolean;
    sourcePush?: boolean;
    gatesOnly?: boolean;
  } = {},
) {
  const sources = [
    "common",
    "gates",
    ...(options.gatesOnly ? [] : ["review"]),
    ...(options.sourcePush ? ["worktree", "push"] : []),
    ...(options.sourcePrepareCore ? ["prepare-core"] : []),
  ];
  const setup = options.gatesOnly
    ? []
    : ["mark_pr_operation_side_effects_started() { :; }", "require_prepared_review() { :; }"];
  if (!options.sourcePrepareCore && !options.gatesOnly) {
    setup.push("refresh_prep_branch_for_reviewed_head() { :; }");
  }
  return spawnSync(
    process.platform === "darwin" ? "/bin/bash" : "bash",
    [
      "-c",
      [
        "set -euo pipefail",
        `script_parent_dir='${repoRoot}/scripts'`,
        ...sources.map((name) => `source '${repoRoot}/scripts/pr-lib/${name}.sh'`),
        ...setup,
        script,
      ].join("\n"),
    ],
    { cwd: options.cwd ?? repoRoot, encoding: "utf8", env: sanitizedEnv(options.env) },
  );
}

function createPublisherGit(repoDir: string) {
  const env = sanitizedEnv({
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ALLOW_PROTOCOL: "file",
    GIT_TERMINAL_PROMPT: "0",
    OPENCLAW_ALLOW_UNSIGNED_GIT_PUSH: "1",
    OPENCLAW_PR_PUSH_MODE: "git",
  });
  function git(...args: string[]) {
    const result = spawnSync("git", args, { cwd: repoDir, env, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  }
  return { env, git };
}

function createPublisherRepo(tempDirs: PublisherTempDirs) {
  const root = tempDirs.make("openclaw-pr-publication-template-");
  const repoDir = join(root, "repo");
  const remote = join(root, "remote.git");
  mkdirSync(repoDir);
  const { env, git } = createPublisherGit(repoDir);
  // A detached maintenance process must not mutate the seed while cases copy it.
  env.GIT_CONFIG_PARAMETERS =
    `${env.GIT_CONFIG_PARAMETERS ?? ""} 'maintenance.auto=false' 'gc.auto=0'`.trim();
  git("init", "-q", "-b", "prep");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  function commit(name: string, empty = false) {
    if (!empty) {
      writeFileSync(join(repoDir, `${name}.txt`), `${name}\n`);
      git("add", ".");
    }
    git("commit", "-qm", name, ...(empty ? ["--allow-empty"] : []));
    return git("rev-parse", "HEAD");
  }
  const base = commit("base", true);
  const source = commit("reviewed");
  const candidate = commit("fixup");
  const sameTree = git("commit-tree", `${candidate}^{tree}`, "-p", source, "-m", "foreign");
  const advance = git("commit-tree", `${source}^{tree}`, "-p", source, "-m", "foreign advance");
  git("init", "-q", "--bare", remote);
  git("remote", "add", "origin", "../remote.git");
  git("push", "-q", "origin", `${candidate}:refs/heads/objects`, `${source}:refs/heads/topic`);
  git("--git-dir", remote, "symbolic-ref", "refs/pull/4242/head", "refs/heads/topic");
  const local = join(repoDir, ".local");
  mkdirSync(local);
  const observation = {
    number: 4242,
    url: "https://github.com/fixture/repo/pull/4242",
    state: "OPEN",
    baseRefName: "main",
    baseRepository: {
      id: "R_fixture",
      databaseId: 1,
      nameWithOwner: "fixture/repo",
      url: "https://github.com/fixture/repo",
    },
    headRefName: "topic",
    headRefOid: source,
    headRepository: { nameWithOwner: "fixture/repo" },
    headRepositoryOwner: { login: "fixture" },
    isCrossRepository: false,
  };
  const { write } = artifactFiles(local);
  write("pr-meta.json", JSON.stringify(observation));
  write("remote-observation.json", JSON.stringify(observation));
  write("github-reads", "");
  write("pr-meta.env", `PR_NUMBER=4242\nPR_AUTHOR=fixture\nPR_HEAD=topic\nPR_HEAD_SHA=${source}\n`);
  write(
    "prep-context.env",
    `PR_NUMBER=4242\nPR_HEAD=topic\nPR_HEAD_SHA_BEFORE=${source}\nPREP_BRANCH=prep\nPREP_STARTED_AT=2026-09-07T00:00:00Z\n`,
  );
  write("gates.env", `PR_NUMBER=4242\nGATES_MODE=full\nLAST_VERIFIED_HEAD_SHA=${candidate}\n`);
  write("prep.md", "# Prepare\n");
  write("events", "");
  return {
    ...artifactFiles(local),
    repoDir,
    remote,
    local,
    env,
    git,
    base,
    source,
    candidate,
    sameTree,
    advance,
    observation,
  };
}

export function createPublisherRepoFactory(dirs: {
  cases: PublisherTempDirs;
  templates: PublisherTempDirs;
}) {
  let template: ReturnType<typeof createPublisherRepo> | undefined;
  return () => {
    template ??= createPublisherRepo(dirs.templates);
    const root = dirs.cases.make("openclaw-pr-publication-");
    const repoDir = join(root, "repo");
    const remote = join(root, "remote.git");
    const copyOptions = { recursive: true, mode: fsConstants.COPYFILE_FICLONE };
    // The sibling-relative origin follows the copy; Git state is never shared.
    cpSync(template.repoDir, repoDir, copyOptions);
    cpSync(template.remote, remote, copyOptions);
    const { env, git } = createPublisherGit(repoDir);
    return {
      ...template,
      ...artifactFiles(join(repoDir, ".local")),
      repoDir,
      remote,
      local: join(repoDir, ".local"),
      env,
      git,
      observation: structuredClone(template.observation),
    };
  };
}

export function runPublisher(
  f: ReturnType<typeof createPublisherRepo>,
  command = "prepare_sync_head 4242",
  setup: string[] = [],
) {
  return runGatesBash(
    [
      `remote='${f.remote}'`,
      'repo_root() { printf "%s\\n" "$PWD"; }',
      `enter_worktree() { PR_MAIN_SHA=${f.base}; }`,
      'resolve_head_push_url() { printf "%s\\n" "$remote"; }',
      'resolve_contributor_coauthor_email() { printf "fixture@example.invalid\\n"; }',
      'remote_head() { command git --git-dir="$remote" rev-parse refs/heads/topic; }',
      "pr_gh() {",
      '  echo "$*" >> .local/github-reads',
      '  case "$*" in',
      '    *headRepository*) jq -c --arg sha "$(remote_head)" ".headRefOid = \\$sha" .local/remote-observation.json;;',
      '    *headRefName*) printf \'{"headRefName":"topic"}\\n\';;',
      "    *headRefOid*) remote_head;;",
      '    *) echo "unexpected GitHub request" >&2; return 98;;',
      "  esac",
      "}",
      "run_prepare_push_retry_gates() { echo retry-gates >> .local/events; }",
      "pr_git() {",
      '  case "$1" in',
      '    push|rebase) echo "$1" >> .local/events;;',
      "  esac",
      '  command git "$@"',
      "}",
      "pr_gh_plain() {",
      "  echo graphql >> .local/events",
      "  local expected hosted",
      '  test "$4" != "-" && test -f "$4" || return 1',
      '  expected=$(jq -r .variables.input.expectedHeadOid "$4") || return $?',
      '  test "$expected" = "$(remote_head)" || return 75',
      '  hosted=$(command git commit-tree HEAD^{tree} -p "$expected" -m "Hosted verified commit")',
      '  command git push -q "$remote" "$hosted:refs/heads/topic" || return $?',
      '  printf \'{"data":{"createCommitOnBranch":{"commit":{"oid":"%s"}}}}\\n\' "$hosted"',
      "}",
      ...setup,
      command,
    ].join("\n"),
    { cwd: f.repoDir, env: f.env, sourcePrepareCore: true, sourcePush: true },
  );
}
