import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { createCommandTest, type CommandFixture } from "../helpers/command-fixture.js";

const it = createCommandTest().extend<{ f: Awaited<ReturnType<typeof fixture>> }>({
  f: async ({ command }, use) => {
    await command.lifetime.run(async () => use(await fixture(command)));
  },
});
const scripts = join(process.cwd(), "scripts");
const describePosix = process.platform === "win32" ? describe.skip : describe;
type Capture = "empty" | "populated" | "symlink";

async function fixture(command: CommandFixture) {
  const root = realpathSync(command.createTempDir("pr-worktree-evidence-"));
  const repo = join(root, "repo");
  const home = join(root, "home");
  mkdirSync(repo);
  mkdirSync(home);
  const env = {
    PATH: process.env.PATH,
    DEVELOPER_DIR: process.env.DEVELOPER_DIR,
    HOME: home,
    XDG_CONFIG_HOME: home,
    TMPDIR: root,
    LC_ALL: "C",
    TZ: "UTC0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TEMPLATE_DIR: home,
    GIT_CONFIG_PARAMETERS: "'core.hooksPath=/dev/null' 'commit.gpgSign=false'",
    GIT_ALLOW_PROTOCOL: "file",
    GIT_TERMINAL_PROMPT: "0",
    FIXTURE_REPO: repo,
    FIXTURE_ROOT: root,
    FIXTURE_SCRIPTS: scripts,
  };
  const git = async (args: string[], input?: string) => {
    const result = await command.run("git", args, { cwd: repo, env, input });
    const output = `git ${args.join(" ")}\n${result.stdout}${result.stderr}`;
    expect(result.error, output).toBeUndefined();
    expect(result.status, output).toBe(0);
    return result.stdout.trim();
  };
  await git(["init", "-q", "-b", "main"]);
  await git(["config", "user.name", "Evidence Fixture"]);
  await git(["config", "user.email", "fixture@example.invalid"]);
  writeFileSync(join(repo, ".gitignore"), ".local/\nnode_modules/\n");
  writeFileSync(join(repo, "tracked.txt"), "original\n");
  await git(["add", ".gitignore", "tracked.txt"]);
  await git(["commit", "-q", "-m", "Synthetic fixture"]);
  await git(["remote", "add", "origin", repo]);
  const head = await git(["rev-parse", "HEAD"]);
  const branches = () => git(["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/"]);
  const outcomes = () =>
    git(["for-each-ref", "--format=%(refname) %(objectname)", "refs/openclaw/pr-merge-outcomes/"]);
  const worktrees = () => git(["worktree", "list", "--porcelain"]);
  const add = async (
    pr: number,
    capture?: Capture,
    registered = true,
    captureName = "merge-output.log",
  ) => {
    const dir = join(repo, ".worktrees", `pr-${pr}`);
    if (registered) {
      await git(["worktree", "add", "-q", "-b", `temp/pr-${pr}`, dir]);
    } else {
      await git(["branch", `temp/pr-${pr}`]);
    }
    await git(["branch", `pr-${pr}`]);
    await git(["branch", `pr-${pr}-prep`]);
    mkdirSync(join(dir, ".local"), { recursive: true });
    writeFileSync(join(dir, ".local", "prep.env"), "synthetic metadata\n");
    if (capture === "symlink") {
      symlinkSync("missing-capture", join(dir, ".local", captureName));
    } else if (capture) {
      writeFileSync(
        join(dir, ".local", captureName),
        capture === "empty" ? "" : "Synthetic response\n",
      );
    }
    return dir;
  };
  const run = async (commands: string[], state = "CLOSED") => {
    const shell = join(root, "invoke.sh");
    writeFileSync(
      shell,
      `#!/usr/bin/env bash
set -euo pipefail
script_parent_dir="$FIXTURE_REPO"
source "$FIXTURE_SCRIPTS/pr-lib/worktree.sh"
source "$FIXTURE_SCRIPTS/pr-lib/operation-lock.sh"
source "$FIXTURE_SCRIPTS/pr-lib/common.sh"
source "$FIXTURE_SCRIPTS/pr-lib/merge-outcome.sh"
test "$(repo_root)" = "$FIXTURE_REPO"
unexpected_gh() { echo "Unexpected GitHub call: $*" >&2; exit 97; }
pr_gh() {
  [ "$#" = 7 ] && [ "$1 $2" = 'pr view' ] && [ "$4 $5 $6 $7" = '--json state --jq .state' ] || unexpected_gh "$@"
  git show-ref --verify --quiet "refs/openclaw/pr-operation-locks/$3" || exit 97
  printf '%s\\n' "$*" >> "$FIXTURE_ROOT/gh-calls"
  printf '%s\\n' "$FIXTURE_STATE"
}
pr_gh_plain() {
  [ "$*" = 'writer-login' ] || unexpected_gh "$@"
  printf 'fixture-user\\n'
}
trash() {
  case "$1" in "$FIXTURE_REPO"/.worktrees/pr-*|.worktrees/pr-*) ;; *) exit 97 ;; esac
  mkdir -p "$FIXTURE_ROOT/trash"
  mv "$1" "$FIXTURE_ROOT/trash/"
}
${commands.join("\n")}
`,
    );
    chmodSync(shell, 0o755);
    const result = await command.run(
      process.execPath,
      [join(scripts, "pr-lib/process-group-runner.mjs"), repo, shell],
      {
        cwd: repo,
        env: { ...env, FIXTURE_STATE: state },
        encoding: "utf8",
      },
    );
    expect(
      result.error,
      `${commands.join("; ")}\n${result.stdout}${result.stderr}`,
    ).toBeUndefined();
    return { ...result, output: result.stdout + result.stderr };
  };
  const record = async (pr: number, phase = "intent", preparedHead = head, localHead?: string) => {
    const value = {
      version: 1,
      repo: {
        id: "fixture-repo",
        nameWithOwner: "fixture/repo",
        url: "https://example.invalid/fixture/repo",
      },
      pr,
      prId: `fixture-pr-${pr}`,
      base: "main",
      head: preparedHead,
      ...(localHead ? { localHead } : {}),
      main: head,
      attempt: "11111111-1111-4111-8111-111111111111",
      method: "squash",
      route: "immediate",
      phase,
      accepted: false,
      landed: phase === "intent" ? null : head,
    };
    const file = join(root, "outcome-input.json");
    writeFileSync(file, JSON.stringify(value));
    const result = await run([
      `acquire_pr_operation_lock ${pr}`,
      `MERGE_OUTCOME_REF=refs/openclaw/pr-merge-outcomes/${pr}`,
      'MERGE_OUTCOME_OID=""',
      'merge_outcome_write "$(cat "$FIXTURE_ROOT/outcome-input.json")"',
      "release_pr_operation_lock",
    ]);
    expect(result.status, result.output).toBe(0);
    return `refs/openclaw/pr-merge-outcomes/${pr}`;
  };
  return { root, repo, env, head, git, add, run, record, branches, outcomes, worktrees };
}

function evidence(dir: string, captureName = "merge-output.log") {
  const capture = join(dir, ".local", captureName);
  const stat = lstatSync(capture);
  return {
    inode: stat.ino,
    mode: stat.mode,
    mtime: stat.mtimeMs,
    contents: stat.isSymbolicLink() ? readlinkSync(capture) : readFileSync(capture, "utf8"),
    metadata: readFileSync(join(dir, ".local/prep.env"), "utf8"),
  };
}

async function preserve(...readers: Array<() => unknown>) {
  const snapshot = () => Promise.all(readers.map((read) => read()));
  const before = await snapshot();
  return async () => expect(await snapshot()).toEqual(before);
}

describePosix("native worktree cleanup preserves merge evidence", () => {
  it("collects an open PR's failed template clone without deleting its seed or template", async ({
    f,
  }) => {
    const template = join(f.repo, ".worktrees/.templates/26a40edd-06f1-43d2-ad5a-a95722f4bd2d");
    await f.git(["worktree", "add", "--detach", template, f.head]);
    await f.git(["branch", "temp/pr-910001"]);
    const clone = join(f.repo, ".worktrees/pr-910001");
    cpSync(template, clone, { recursive: true });
    const before = await f.branches();
    const dry = await f.run(["gc_pr_worktrees true 910001"], "OPEN");
    expect(dry.status, dry.output).toBe(0);
    expect(dry.output).toContain("would remove .worktrees/pr-910001 (failed template clone)");
    expect(existsSync(clone)).toBe(true);
    const removed = await f.run(["gc_pr_worktrees false 910001"], "OPEN");
    expect(removed.status, removed.output).toBe(0);
    expect(existsSync(clone)).toBe(false);
    expect(await f.git(["-C", template, "rev-parse", "HEAD"])).toBe(f.head);
    expect(await f.branches()).toBe(before);
    expect(existsSync(join(f.root, "gh-calls"))).toBe(false);
  });

  it("scopes dry-run and removal without observing siblings", async ({ f }) => {
    const selected = await f.add(910001);
    const sibling = await f.add(910002);
    const unchanged = await preserve(f.branches, f.worktrees);
    const dry = await f.run(["gc_pr_worktrees true 910001"], "MERGED");
    expect(dry.status, dry.output).toBe(0);
    expect(dry.output).toContain("would remove .worktrees/pr-910001");
    expect(dry.output).not.toContain("pr-910002");
    await unchanged();
    const actual = await f.run(["gc_pr_worktrees false 910001"], "MERGED");
    expect(actual.status, actual.output).toBe(0);
    expect(existsSync(selected)).toBe(false);
    expect(existsSync(sibling)).toBe(true);
    expect(await f.worktrees()).toContain(`worktree ${sibling}\n`);
    for (const branch of ["temp/pr-910002", "pr-910002", "pr-910002-prep"]) {
      expect(await f.branches()).toContain(`refs/heads/${branch} ${f.head}`);
    }
    expect(readFileSync(join(f.root, "gh-calls"), "utf8")).not.toContain("910002");
  });

  it.for(["", ".local/nested"])(
    "defers removal while the parent session holds cwd %s, then removes after release",
    async (subdirectory, { f, command }) => {
      const dir = await f.add(910001);
      const cwd = join(dir, subdirectory);
      mkdirSync(cwd, { recursive: true });
      mkdirSync(dir + "-sibling");
      const result = await command.run(
        process.execPath,
        [
          "-e",
          `
const { spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const [repo, target, scripts] = process.argv.slice(1);
const remove = () => spawnSync(process.platform === "darwin" ? "/bin/bash" : "bash", [
  "-c", 'set -euo pipefail; canonical_repo_root="$FIXTURE_REPO"; source "$1/pr-lib/worktree.sh"; source "$1/pr-lib/common.sh"; remove_worktree_if_present "$2"',
  "cleanup", scripts, target,
], { cwd: repo, encoding: "utf8" });
const held = remove();
const preserved = existsSync(target);
// Match the incident: the cleanup child ran elsewhere, then the live parent spawns again.
const next = spawnSync(process.execPath, ["-e", "process.stdout.write(process.cwd())"], {
  encoding: "utf8",
});
process.chdir(target + "-sibling");
const released = preserved ? remove() : null;
process.stdout.write(JSON.stringify({
  held: { status: held.status, stderr: held.stderr }, preserved,
  next: { status: next.status, stdout: next.stdout },
  released: released && { status: released.status, stderr: released.stderr },
}));
`,
          f.repo,
          dir,
          scripts,
        ],
        { cwd, env: f.env },
      );
      expect(result.status, result.stdout + result.stderr).toBe(0);
      const observation = JSON.parse(result.stdout);
      expect(observation.held.status, observation.held.stderr).not.toBe(0);
      expect(observation.held.stderr).toContain("live process");
      expect(observation).toMatchObject({
        preserved: true,
        next: { status: 0, stdout: cwd },
        released: { status: 0 },
      });
      expect(existsSync(dir)).toBe(false);
      expect(await f.worktrees()).not.toContain(`worktree ${dir}\n`);
    },
  );

  it.for(["", " 910001"])("retains dirty work and local branches (%s)", async (scope, { f }) => {
    const file = "unpublished.txt";
    const dir = await f.add(910001);
    writeFileSync(join(dir, file), "unpublished work\n");
    const unchanged = await preserve(f.branches, f.worktrees);
    const dry = await f.run([`gc_pr_worktrees true${scope}`], "MERGED");
    expect(dry.status, dry.output).toBe(scope ? 1 : 0);
    expect(dry.output).not.toContain("would remove .worktrees/pr-910001");
    await unchanged();
    const result = await f.run([`gc_pr_worktrees false${scope}`], "MERGED");
    expect(result.status, result.output).toBe(scope ? 1 : 0);
    expect(existsSync(join(dir, file)), result.output).toBe(true);
    expect(readFileSync(join(dir, file), "utf8")).toBe("unpublished work\n");
    await unchanged();
    expect(result.output).toContain("cleanup incomplete");
  });

  it.for(["intent", "advanced", "configured"])(
    "deletes only published or completed-receipt branch tips (%s)",
    async (receipt, { f }) => {
      await f.add(910001);
      const tree = await f.git(["rev-parse", "HEAD^{tree}"]);
      const prepared = await f.git(["commit-tree", tree, "-p", f.head], "Reviewed source\n");
      await f.record(910001, receipt === "intent" ? "intent" : "complete", prepared);
      const tip =
        receipt !== "intent"
          ? await f.git(["commit-tree", tree, "-p", prepared], "Unpublished follow-up\n")
          : prepared;
      await f.git(["update-ref", "refs/heads/pr-910001-prep", tip]);
      if (receipt === "configured") {
        await f.git(["update-ref", "refs/heads/published", tip]);
        await f.git(["update-ref", "refs/remotes/origin/published", f.head]);
        await f.git(["config", "branch.pr-910001-prep.remote", "origin"]);
        await f.git(["config", "branch.pr-910001-prep.merge", "refs/heads/published"]);
      }
      const outcomes = await f.outcomes();
      const result = await f.run(["gc_pr_worktrees false"], "MERGED");
      expect(result.status, result.output).toBe(0);
      expect(await f.outcomes()).toBe(outcomes);
      expect(await f.branches(), result.output).toContain(`refs/heads/pr-910001-prep ${tip}`);
      expect(result.output).toContain("cleanup incomplete");
    },
  );

  it.for(["merge-output.log", "merge-output.11111111-1111-4111-8111-111111111111.log"])(
    "preserves registered captures during dry-run and actual GC for %s",
    async (captureName, { f }) => {
      const protectedDirs: string[] = [];
      for (const [index, shape] of (["empty", "populated", "symlink"] as const).entries()) {
        protectedDirs.push(await f.add(910001 + index, shape, true, captureName));
      }
      const eligible = await f.add(910009);
      const before = protectedDirs.map((dir) => evidence(dir, captureName));
      const unchanged = await preserve(f.branches, f.worktrees);
      const dry = await f.run(["gc_pr_worktrees true"]);
      expect(dry.status, dry.output).toBe(0);
      expect.soft(dry.output).toContain("would remove .worktrees/pr-910009");
      for (const pr of [910001, 910002, 910003]) {
        expect.soft(dry.output).not.toContain(`would remove .worktrees/pr-${pr}`);
      }
      await unchanged();
      const actual = await f.run(["gc_pr_worktrees false"]);
      expect(actual.status, actual.output).toBe(0);
      // Check the original path first: moving evidence to Trash also violates recovery.
      for (const [index, dir] of protectedDirs.entries()) {
        expect(evidence(dir, captureName)).toEqual(before[index]);
        expect.soft(actual.output).not.toContain(`removed .worktrees/pr-${910001 + index}`);
        expect.soft(await f.worktrees()).toContain(`worktree ${dir}\n`);
        for (const branch of [
          `temp/pr-${910001 + index}`,
          `pr-${910001 + index}`,
          `pr-${910001 + index}-prep`,
        ]) {
          expect.soft(await f.branches()).toContain(`refs/heads/${branch} ${f.head}`);
        }
      }
      expect(actual.output).toContain("reconcile the earlier request manually");
      expect(existsSync(eligible)).toBe(false);
      expect(actual.output).toContain("removed .worktrees/pr-910009");
      expect(await f.outcomes()).toBe("");
      expect(
        await f.git(["for-each-ref", "--format=%(refname)", "refs/openclaw/pr-operation-locks/"]),
      ).toBe("");
      expect(existsSync(join(f.root, "trash"))).toBe(false);
    },
  );

  it.for(["entry", "removal"])(
    "refuses %s without changing worktree evidence or branches",
    async (operation, { f }) => {
      const dir = await f.add(910001, operation === "entry" ? "empty" : "populated");
      if (operation === "entry") {
        const gitdir = readFileSync(join(dir, ".git"), "utf8").trim().slice(8);
        writeFileSync(join(gitdir, "gitdir"), `${dir}-missing/.git\n`);
        rmSync(join(dir, ".git"));
      }
      const before = evidence(dir);
      const unchanged = await preserve(f.branches, f.worktrees);
      const result = await f.run([
        "acquire_pr_operation_lock 910001",
        "begin_pr_operation_validation_phase",
        `${operation === "entry" ? "enter_worktree 910001 false" : 'remove_worktree_if_present ".worktrees/pr-910001"'} || exit $?`,
        "echo unexpected-completion",
      ]);
      expect(evidence(dir)).toEqual(before);
      await unchanged();
      expect(result.status, result.output).not.toBe(0);
      expect(result.output).not.toContain("unexpected-completion");
      if (operation === "entry") {
        expect(result.output).toContain(
          "Refusing PR worktree cleanup: unregistered or ambiguous PR worktree; scripts/pr refuses to mutate the shared canonical checkout",
        );
        expect(await f.outcomes()).toBe("");
      }
      expect(existsSync(join(f.root, "trash"))).toBe(false);
    },
  );

  it.for(["corrupt", "symbolic", "wrong-pr", "unretained", "local-tree", "orphan"])(
    "refuses GC with %s outcome",
    async (fault, { f }) => {
      const dir = await f.add(910001, "populated", fault !== "orphan");
      const localHead =
        fault === "local-tree"
          ? await f.git(
              ["commit-tree", await f.git(["mktree"], ""), "-p", f.head],
              "Different local tree\n",
            )
          : undefined;
      const ref = await f.record(
        910001,
        fault === "orphan" ? "complete" : "intent",
        f.head,
        localHead,
      );
      if (fault === "corrupt") {
        await f.git(["update-ref", ref, await f.git(["hash-object", "-w", "--stdin"], "bad")]);
      }
      if (fault === "symbolic") {
        await f.git(["update-ref", "refs/fixture/retained", await f.git(["rev-parse", ref])]);
        await f.git(["symbolic-ref", ref, "refs/fixture/retained"]);
      }
      if (fault === "wrong-pr") {
        const other = await f.record(910002);
        await f.git(["update-ref", ref, await f.git(["rev-parse", other])]);
      }
      if (fault === "unretained") {
        const tree = await f.git(["rev-parse", `${ref}^{tree}`]);
        await f.git([
          "update-ref",
          ref,
          await f.git(["commit-tree", tree], "Unretained fixture\n"),
        ]);
      }
      const unchanged = await preserve(() => evidence(dir), f.branches, f.outcomes);
      const result = await f.run(["gc_pr_worktrees false"]);
      expect(result.status, result.output).toBe(0);
      await unchanged();
      if (fault === "orphan") {
        expect(result.output).toContain("cleanup incomplete");
        expect(result.output).not.toContain("removed .worktrees/pr-910001");
        expect(existsSync(join(f.root, "trash"))).toBe(false);
      } else {
        expect(result.output).toContain("No merged/closed PR worktrees removed.");
        expect(result.output).toContain("reconcile the earlier request manually");
      }
    },
  );
});
