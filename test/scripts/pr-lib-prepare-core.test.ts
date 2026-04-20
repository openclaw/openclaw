import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createScriptTestHarness } from "./test-helpers.js";

const prepareCoreScriptPath = path.join(process.cwd(), "scripts", "pr-lib", "prepare-core.sh");
const worktreeScriptPath = path.join(process.cwd(), "scripts", "pr-lib", "worktree.sh");
const { createTempDir } = createScriptTestHarness();

function run(cwd: string, command: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    env: env ? { ...process.env, ...env } : process.env,
  }).trim();
}

function git(cwd: string, ...args: string[]): string {
  return run(cwd, "git", args);
}

function runPrepareCoreShell(cwd: string, body: string): string {
  return run(
    cwd,
    "bash",
    [
      "-lc",
      `
source "$OPENCLAW_PREPARE_CORE_SH"
${body}
`,
    ],
    {
      OPENCLAW_PREPARE_CORE_SH: prepareCoreScriptPath,
    },
  );
}

function runWorktreeShell(cwd: string, body: string, env?: NodeJS.ProcessEnv): string {
  return run(
    cwd,
    "bash",
    [
      "-lc",
      `
source "$OPENCLAW_WORKTREE_SH"
${body}
`,
    ],
    {
      OPENCLAW_WORKTREE_SH: worktreeScriptPath,
      ...env,
    },
  );
}

describe("scripts/pr-lib/prepare-core.sh", () => {
  it("resets PREP_REBASE_COUNT during prepare-init", () => {
    const repo = createTempDir("openclaw-pr-lib-prepare-init-");
    mkdirSync(path.join(repo, ".local"), { recursive: true });
    writeFileSync(path.join(repo, ".local", "review.md"), "# review\n", "utf8");
    writeFileSync(path.join(repo, ".local", "review.json"), "{}\n", "utf8");
    writeFileSync(path.join(repo, ".local", "pr-meta.env"), "PR_HEAD=feature\n", "utf8");
    writeFileSync(
      path.join(repo, ".local", "prep-context.env"),
      "PREP_REBASE_COUNT=2\nPREP_BRANCH=pr-123-prep\n",
      "utf8",
    );

    runPrepareCoreShell(
      repo,
      `
enter_worktree() { :; }
require_artifact() { [ -e "$1" ] || exit 1; }
pr_meta_json() { printf '%s\\n' '{"headRefName":"feature","headRefOid":"deadbeef"}'; }
git() {
  case "$1" in
    fetch|checkout)
      return 0
      ;;
    branch)
      if [ "$2" = "--show-current" ]; then
        printf 'pr-123-prep\\n'
        return 0
      fi
      ;;
  esac
  echo "unexpected git invocation: $*" >&2
  exit 1
}
prepare_init 123 false
`,
    );

    const prepContext = readFileSync(path.join(repo, ".local", "prep-context.env"), "utf8");
    expect(prepContext).toContain("PREP_REBASE_COUNT=0");
  });

  it("allows an additional sync rebase only when --force is used", () => {
    expect(
      runPrepareCoreShell(
        process.cwd(),
        'if prepare_sync_rebase_allowed 1 false; then printf "allowed"; else printf "blocked"; fi',
      ),
    ).toBe("blocked");
    expect(
      runPrepareCoreShell(
        process.cwd(),
        'if prepare_sync_rebase_allowed 1 true; then printf "allowed"; else printf "blocked"; fi',
      ),
    ).toBe("allowed");
  });
});

describe("scripts/pr-lib/worktree.sh", () => {
  it("force-cleans only the targeted PR worktree", () => {
    const root = createTempDir("openclaw-pr-lib-worktree-root-");
    const worktreeDir = path.join(root, ".worktrees", "pr-123");
    mkdirSync(worktreeDir, { recursive: true });

    git(worktreeDir, "init", "-q", "--initial-branch=main");
    git(worktreeDir, "config", "user.email", "test@example.com");
    git(worktreeDir, "config", "user.name", "Test User");
    writeFileSync(path.join(worktreeDir, "tracked.txt"), "seed\n", "utf8");
    git(worktreeDir, "add", "tracked.txt");
    git(worktreeDir, "commit", "-qm", "seed");

    writeFileSync(path.join(worktreeDir, "tracked.txt"), "dirty\n", "utf8");
    writeFileSync(path.join(worktreeDir, "untracked.txt"), "remove me\n", "utf8");
    mkdirSync(path.join(worktreeDir, ".local"), { recursive: true });
    writeFileSync(path.join(worktreeDir, ".local", "pr-meta.env"), "KEEP=1\n", "utf8");

    runWorktreeShell(
      root,
      `
repo_root() { printf '%s\\n' "$TEST_REPO_ROOT"; }
clean_pr_worktree_state "$TEST_REPO_ROOT/.worktrees/pr-123"
`,
      { TEST_REPO_ROOT: root },
    );

    expect(readFileSync(path.join(worktreeDir, "tracked.txt"), "utf8")).toBe("seed\n");
    expect(existsSync(path.join(worktreeDir, "untracked.txt"))).toBe(false);
    expect(readFileSync(path.join(worktreeDir, ".local", "pr-meta.env"), "utf8")).toBe("KEEP=1\n");
  });
});
