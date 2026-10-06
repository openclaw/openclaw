import {
  chmodSync,
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

const it = createCommandTest();
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
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: "/dev/null",
    GIT_CONFIG_KEY_1: "commit.gpgSign",
    GIT_CONFIG_VALUE_1: "false",
    GIT_ALLOW_PROTOCOL: "file",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Evidence Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Evidence Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
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
pr_gh() {
  if [ "$#" = 7 ] && [ "$1 $2" = 'pr view' ] && [ "$4 $5 $6 $7" = '--json state --jq .state' ]; then
    git show-ref --verify --quiet "refs/openclaw/pr-operation-locks/$3" || exit 97
    printf '%s\\n' "$*" >> "$FIXTURE_ROOT/gh-calls"
    printf '%s\\n' "$FIXTURE_STATE"
  else
    echo "Unexpected GitHub call: $*" >&2; exit 97
  fi
}
pr_gh_plain() {
  if [ "$*" = 'writer-login' ]; then
    printf 'fixture-user\\n'
  else
    echo "Unexpected direct GitHub call: $*" >&2; exit 97
  fi
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
  return { root, repo, head, git, add, run, record, branches, outcomes, worktrees };
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

describePosix("native worktree cleanup preserves merge evidence", () => {
  it.for(["tracked.txt", "unpublished.txt"])(
    "retains dirty %s and local branches",
    async (file, { command }) => {
      await command.lifetime.run(async () => {
        const f = await fixture(command);
        const dir = await f.add(910001);
        writeFileSync(join(dir, file), "unpublished work\n");
        const branches = await f.branches();
        const registrations = await f.worktrees();
        const dry = await f.run(["gc_pr_worktrees true"], "MERGED");
        expect(dry.output).not.toContain("would remove .worktrees/pr-910001");
        expect(await f.branches()).toBe(branches);
        expect(await f.worktrees()).toBe(registrations);
        const result = await f.run(["gc_pr_worktrees false"], "MERGED");
        expect(result.status, result.output).toBe(0);
        expect(existsSync(join(dir, file)), result.output).toBe(true);
        expect(readFileSync(join(dir, file), "utf8")).toBe("unpublished work\n");
        expect(await f.branches()).toBe(branches);
        expect(await f.worktrees()).toBe(registrations);
        expect(result.output).toContain("cleanup incomplete");
      });
    },
  );

  it("removes clean worktrees with ignored generated artifacts", async ({ command }) => {
    await command.lifetime.run(async () => {
      const f = await fixture(command);
      const dir = await f.add(910001);
      mkdirSync(join(dir, "node_modules"));
      writeFileSync(join(dir, "node_modules", "generated"), "disposable\n");
      const result = await f.run(["gc_pr_worktrees false"], "MERGED");
      expect(result.status, result.output).toBe(0);
      expect(existsSync(dir)).toBe(false);
      expect(result.output).toContain("removed .worktrees/pr-910001");
    });
  });

  it.for(["none", "intent", "complete", "advanced", "configured", "local", "local-advanced"])(
    "deletes only published or completed-receipt branch tips (%s)",
    async (receipt, { command }) => {
      await command.lifetime.run(async () => {
        const f = await fixture(command);
        await f.add(910001);
        const tree = await f.git(["rev-parse", "HEAD^{tree}"]);
        const prepared = await f.git(["commit-tree", tree, "-p", f.head], "Reviewed source\n");
        const localHead = receipt.startsWith("local")
          ? await f.git(["commit-tree", tree, "-p", f.head], "Local prepared source\n")
          : undefined;
        if (receipt !== "none") {
          await f.record(910001, receipt === "intent" ? "intent" : "complete", prepared, localHead);
        }
        const tip =
          receipt === "advanced" || receipt === "configured" || receipt === "local-advanced"
            ? await f.git(
                ["commit-tree", tree, "-p", localHead ?? prepared],
                "Unpublished follow-up\n",
              )
            : (localHead ?? prepared);
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
        if (receipt === "complete" || receipt === "local") {
          expect(await f.branches()).not.toContain("refs/heads/pr-910001-prep");
          expect(result.output).toContain("removed .worktrees/pr-910001");
        } else {
          expect(await f.branches(), result.output).toContain(`refs/heads/pr-910001-prep ${tip}`);
          expect(result.output).toContain("cleanup incomplete");
        }
      });
    },
  );

  it.for(
    ["CLOSED", "MERGED"].flatMap((state) =>
      ["merge-output.log", "merge-output.11111111-1111-4111-8111-111111111111.log"].map(
        (captureName) => ({ state, captureName }),
      ),
    ),
  )(
    "preserves registered captures during dry-run and actual GC for %j",
    async ({ state, captureName }, { command }) => {
      await command.lifetime.run(async () => {
        const f = await fixture(command);
        const protectedDirs: string[] = [];
        for (const [index, shape] of (["empty", "populated", "symlink"] as const).entries()) {
          protectedDirs.push(await f.add(910001 + index, shape, true, captureName));
        }
        const eligible = await f.add(910009);
        const before = protectedDirs.map((dir) => evidence(dir, captureName));
        const branches = await f.branches();
        const registrations = await f.worktrees();
        const dry = await f.run(["gc_pr_worktrees true"], state);
        expect(dry.status, dry.output).toBe(0);
        expect.soft(dry.output).toContain("would remove .worktrees/pr-910009");
        for (const pr of [910001, 910002, 910003]) {
          expect.soft(dry.output).not.toContain(`would remove .worktrees/pr-${pr}`);
        }
        expect(await f.branches()).toBe(branches);
        expect(await f.worktrees()).toBe(registrations);
        const actual = await f.run(["gc_pr_worktrees false"], state);
        expect(actual.status, actual.output).toBe(0);
        // Check the original path first: moving evidence to Trash also violates recovery.
        for (const [index, dir] of protectedDirs.entries()) {
          expect.soft(existsSync(join(dir, ".local")), actual.output).toBe(true);
          if (existsSync(join(dir, ".local"))) {
            expect(evidence(dir, captureName)).toEqual(before[index]);
          }
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
      });
    },
  );

  it.for([false, true])(
    "preserves orphan evidence before scoped removal/provisioning (stale registration=%s)",
    async (stale, { command }) => {
      await command.lifetime.run(async () => {
        const f = await fixture(command);
        const dir = await f.add(910001, "empty", stale);
        if (stale) {
          const gitdir = readFileSync(join(dir, ".git"), "utf8").trim().slice(8);
          writeFileSync(join(gitdir, "gitdir"), `${dir}-missing/.git\n`);
          rmSync(join(dir, ".git"));
        }
        const before = evidence(dir);
        const branches = await f.branches();
        const registrations = await f.worktrees();
        const result = await f.run([
          "acquire_pr_operation_lock 910001",
          "begin_pr_operation_validation_phase",
          "enter_worktree 910001 false || exit $?",
          "echo unexpected-entry-completed",
        ]);
        expect.soft(existsSync(join(dir, ".local/merge-output.log")), result.output).toBe(true);
        if (existsSync(join(dir, ".local/merge-output.log"))) {
          expect(evidence(dir)).toEqual(before);
        }
        expect.soft(await f.worktrees()).toBe(registrations);
        expect(await f.branches()).toBe(branches);
        expect(result.status, result.output).not.toBe(0);
        expect(result.output).not.toContain("unexpected-entry-completed");
        expect(result.output).toContain(
          "Refusing PR worktree cleanup: unregistered or ambiguous PR worktree; scripts/pr refuses to mutate the shared canonical checkout",
        );
        expect(existsSync(join(f.root, "trash"))).toBe(false);
        expect(await f.outcomes()).toBe("");
      });
    },
  );

  it.for(["corrupt", "symbolic", "wrong-pr", "unretained", "local-tree"])(
    "refuses GC with %s outcome",
    async (fault, { command }) => {
      await command.lifetime.run(async () => {
        const f = await fixture(command);
        const dir = await f.add(910001, "populated");
        const localHead =
          fault === "local-tree"
            ? await f.git(
                ["commit-tree", await f.git(["mktree"], ""), "-p", f.head],
                "Different local tree\n",
              )
            : undefined;
        const ref = await f.record(910001, "intent", f.head, localHead);
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
        const before = evidence(dir);
        const branches = await f.branches();
        const outcomes = await f.outcomes();
        const result = await f.run(["gc_pr_worktrees false"]);
        expect(result.status, result.output).toBe(0);
        expect(existsSync(join(dir, ".local/merge-output.log")), result.output).toBe(true);
        expect(evidence(dir)).toEqual(before);
        expect(await f.branches()).toBe(branches);
        expect(await f.outcomes()).toBe(outcomes);
        expect(result.output).toContain("No merged/closed PR worktrees removed.");
        expect(result.output).toContain("reconcile the earlier request manually");
      });
    },
  );

  it.for([true, false])(
    "shared removal refuses capture (registered=%s)",
    async (registered, { command }) => {
      await command.lifetime.run(async () => {
        const f = await fixture(command);
        const dir = await f.add(910001, "populated", registered);
        const before = evidence(dir);
        const branches = await f.branches();
        const registrations = await f.worktrees();
        const result = await f.run([
          "acquire_pr_operation_lock 910001",
          "begin_pr_operation_validation_phase",
          'remove_worktree_if_present ".worktrees/pr-910001" || exit $?',
          "echo unexpected-removal-completed",
        ]);
        expect(existsSync(join(dir, ".local/merge-output.log")), result.output).toBe(true);
        expect(evidence(dir)).toEqual(before);
        expect(await f.branches()).toBe(branches);
        expect(await f.worktrees()).toBe(registrations);
        expect(result.status, result.output).not.toBe(0);
        expect(result.output).not.toContain("unexpected-removal-completed");
        expect(existsSync(join(f.root, "trash"))).toBe(false);
      });
    },
  );

  it.for(["intent", "complete"])(
    "allows cleanup with a valid retained %s outcome",
    async (phase, { command }) => {
      await command.lifetime.run(async () => {
        const f = await fixture(command);
        const dir = await f.add(910001, "populated");
        const ref = await f.record(910001, phase);
        const before = await f.outcomes();
        const result = await f.run(["gc_pr_worktrees false"]);
        expect(result.status, result.output).toBe(0);
        expect(existsSync(dir)).toBe(false);
        expect(result.output).toContain("removed .worktrees/pr-910001");
        expect(await f.outcomes()).toBe(before);
        expect(JSON.parse(await f.git(["show", `${ref}:outcome.json`])).phase).toBe(phase);
        expect(
          await f.git(["for-each-ref", "--format=%(refname)", "refs/openclaw/pr-operation-locks/"]),
        ).toBe("");
      });
    },
  );

  it("retains an unregistered orphan even when its merge outcome is valid", async ({ command }) => {
    await command.lifetime.run(async () => {
      const f = await fixture(command);
      const dir = await f.add(910001, "populated", false);
      await f.record(910001, "complete");
      const before = evidence(dir);
      const branches = await f.branches();
      const outcomes = await f.outcomes();
      const result = await f.run(["gc_pr_worktrees false"]);
      expect(result.status, result.output).toBe(0);
      expect(result.output).toContain("cleanup incomplete");
      expect(result.output).not.toContain("removed .worktrees/pr-910001");
      expect(evidence(dir)).toEqual(before);
      expect(await f.branches()).toBe(branches);
      expect(await f.outcomes()).toBe(outcomes);
      expect(existsSync(join(f.root, "trash"))).toBe(false);
    });
  });
});
