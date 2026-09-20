import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect } from "vitest";
import { exitedDescendantReaper } from "./exited-descendant-reaper.test-support.js";

export function createProvisionOwnerFixture(
  directory: string,
  mode: "native" | "managed" = "native",
  files = 128,
) {
  const root = realpathSync(directory);
  const source = process.cwd();
  const canonical = join(root, "repo");
  const home = join(root, "home");
  const bin = join(root, "bin");
  for (const dir of [canonical, home, bin]) {
    mkdirSync(dir);
  }
  const env: NodeJS.ProcessEnv = {
    PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
    HOME: home,
    TMPDIR: root,
    XDG_CONFIG_HOME: join(home, ".config"),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_PARAMETERS: "'maintenance.auto=false' 'gc.auto=0'",
    GIT_ALLOW_PROTOCOL: "file",
    GIT_TERMINAL_PROMPT: "0",
    OPENCLAW_CONFIG_PATH: join(root, "config.json"),
  };
  writeFileSync(env.OPENCLAW_CONFIG_PATH!, '{"worktreeAcceleration":false}\n');
  const gh = join(bin, "gh");
  writeFileSync(
    gh,
    `#!/bin/sh
[ "$1" != auth ] || exit 1
[ "$1" = api ] && [ "$2" = graphql ] || exit 2
printf 'HTTP/2.0 200 OK\\r\\n\\r\\n{"data":{"viewer":{"login":"fixture"}}}\\n'
`,
  );
  chmodSync(gh, 0o755);
  env.OPENCLAW_GH_BIN = gh;
  function git(cwd: string, ...args: string[]) {
    const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
    }
    return result.stdout.trim();
  }
  git(canonical, "init", "-q", "-b", "main");
  git(canonical, "config", "user.name", "Provision Fixture");
  git(canonical, "config", "user.email", "fixture@example.invalid");
  git(canonical, "config", "core.hooksPath", "/dev/null");
  if (mode === "native") {
    git(canonical, "config", "extensions.worktreeConfig", "true");
  }
  writeFileSync(join(canonical, ".gitignore"), ".worktrees/\n.local/\n");
  mkdirSync(join(canonical, "src"));
  for (let i = 0; i < files; i++) {
    writeFileSync(join(canonical, "src", `file-${i}.txt`), `synthetic tracked file ${i}\n`);
  }
  git(canonical, "add", ".");
  git(canonical, "commit", "-qm", "test: synthetic provision input");
  const main = git(canonical, "rev-parse", "HEAD");
  git(canonical, "remote", "add", "origin", canonical);
  const worktree = join(canonical, ".worktrees", "pr-42");
  const script = `set -euo pipefail
canonical_repo_root="$1"
script_parent_dir="$2/scripts"
source "$script_parent_dir/lib/plain-gh.sh"
source "$script_parent_dir/pr-lib/worktree.sh"
source "$script_parent_dir/pr-lib/common.sh"
source "$script_parent_dir/pr-lib/operation-lock.sh"
if [ "$3" = recover ]; then
  recover_pr_operation_lock 42 "$4" --confirmed-no-running-tools
else
  acquire_pr_operation_lock 42
  begin_pr_operation_validation_phase
  enter_worktree 42
fi
`;
  return {
    root,
    canonical,
    worktree,
    home,
    env,
    main,
    git,
    run(action = "entry", owner = "", options: { holdExitedDescendants?: boolean } = {}) {
      const args = [
        resolve(source, "scripts/pr-lib/process-group-runner.mjs"),
        canonical,
        process.platform === "darwin" ? "/bin/bash" : "bash",
        "-c",
        script,
        "provision-owner-fixture",
        canonical,
        source,
        action,
        owner,
      ];
      if (options.holdExitedDescendants) {
        args.unshift("-c", exitedDescendantReaper, process.execPath);
      }
      return spawnSync(options.holdExitedDescendants ? "python3" : process.execPath, args, {
        cwd: canonical,
        env,
        encoding: "utf8",
      });
    },
  };
}

export function expectProvisionSeed(f: ReturnType<typeof createProvisionOwnerFixture>, pr = 42) {
  const worktree = join(f.canonical, ".worktrees", `pr-${pr}`);
  expect(f.git(worktree, "symbolic-ref", "HEAD")).toBe(`refs/heads/temp/pr-${pr}`);
  expect(f.git(worktree, "rev-parse", "HEAD")).toBe(f.main);
  expect(f.git(f.canonical, "rev-parse", `refs/heads/temp/pr-${pr}`)).toBe(f.main);
  return worktree;
}

export function expectProvisionLeaseReleased(f: ReturnType<typeof createProvisionOwnerFixture>) {
  const database = new DatabaseSync(
    join(f.canonical, ".local", "pr-state", "state", "openclaw.sqlite"),
    { readOnly: true },
  );
  try {
    expect(database.prepare("SELECT count(*) AS leases FROM state_leases").get()).toEqual({
      leases: 0,
    });
  } finally {
    database.close();
  }
}
