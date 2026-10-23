import * as fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as hooks from "./git-hooks-pre-commit.test-support.js";
import { cleanupTempDirs } from "./helpers/temp-dir.js";

const tempDirs: string[] = [];
const failureLine = "[pre-commit] FAILED (exit 23)\n";
const { literals, rulePath, ruleSetting, commitArgs } = hooks;
const operationRefs = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"];
const operationDirs = ["rebase-merge", "rebase-apply", "sequencer"];
afterEach(() => cleanupTempDirs(tempDirs));

function fixture(dir = hooks.createContentGuardFixture(tempDirs)) {
  const git = (args: string[], env?: NodeJS.ProcessEnv) => hooks.run(dir, "git", args, env);
  const write = (name: string, content: string) => fs.writeFileSync(path.join(dir, name), content);
  const stage = (name: string, content: string) => hooks.stageContent(dir, name, content);
  return {
    dir,
    git,
    write,
    stage,
    read: (name: string) => fs.readFileSync(path.join(dir, name), "utf8"),
    show: (name: string, ref = "HEAD") => git(["show", `${ref}:${name}`]),
    fail: (args = commitArgs, env?: NodeJS.ProcessEnv) => hooks.runFailure(dir, "git", args, env),
    hook: () => hooks.run(dir, "bash", ["git-hooks/pre-commit"]),
    failHook: () => hooks.runFailure(dir, "bash", ["git-hooks/pre-commit"]),
    metadata: (state: string) => path.resolve(dir, git(["rev-parse", "--git-path", state])),
    assertNoMetadata(states: string[]) {
      for (const state of states) {
        expect(fs.existsSync(this.metadata(state))).toBe(false);
      }
    },
    partial(name: string, staged: string, working: string) {
      stage(name, staged);
      write(name, working);
    },
    withoutRules() {
      git(["config", "--local", "--unset", ruleSetting]);
      fs.unlinkSync(path.join(dir, rulePath));
    },
    formatter(body: string) {
      hooks.writeExecutable(path.join(dir, "node_modules/.bin"), "oxfmt", body);
    },
  };
}
type Repo = ReturnType<typeof fixture>;

function expectBlocked(output: string, name: string): void {
  expect(output).toContain("Blocked staged content");
  expect(output).toContain(JSON.stringify(name));
  expect(output).not.toContain(literals[0]);
  expect(output).toContain("[pre-commit] FAILED (exit 1)\n");
}

// Emit the working-tree input; stdin-mode additionally echoes the staged blob.
function diagnosticFormatter(r: Repo, stream: number, exitCode: number, echoStdin = false) {
  r.formatter(`#!/usr/bin/env node
const fs = require("node:fs");
${echoStdin ? "fs.writeSync(1, fs.readFileSync(0));" : ""}
const payload = fs.readFileSync("payload.ts");
let written = 0;
while (written < payload.length) written += fs.writeSync(${stream}, payload, written, payload.length - written);
process.exitCode = ${exitCode};
`);
}

function captureFixture(stream: number, oversized = false) {
  const r = fixture();
  const token = oversized ? "SYNTHETIC_CAPTURE_".padEnd(128, "x") : literals[0];
  if (oversized) {
    r.write(rulePath, `${token}\n`);
  }
  const payload = oversized
    ? ".".repeat(16 * 1024 * 1024 - 131168) + token.repeat(2048) + "ACTIONABLE_TAIL\n"
    : ".".repeat(256) + `${token}\n`.repeat(2048) + "ACTIONABLE_TAIL\n";
  r.partial("payload.ts", "clean\n", payload);
  diagnosticFormatter(r, stream, 23);
  return r;
}

const formatterBody = "printf '// formatted\\n' >> changed.ts\nprintf formatted";
const recordFormatting = (r: Repo) => hooks.installFormattingRecorder(r.dir, formatterBody);

describe("pre-commit Git path identity", () => {
  it("blocks the only BOM-prefixed path when staged", () => {
    const r = fixture();
    const name = "\uFEFFpayload.txt";
    r.partial(name, literals[0], literals[0]);
    expectBlocked(r.fail().stderr, name);
    expect(r.fail(["rev-parse", "--verify", "HEAD"]).status).not.toBe(0);
  });
  it("commits only the staged bytes of a partially staged BOM-prefixed path", () => {
    const r = fixture();
    const name = "\uFEFFpayload.ts";
    r.partial(name, "clean\n", literals[0]);
    r.git(commitArgs);
    expect([r.show(name), r.read(name)]).toEqual(["clean", literals[0]]);
  });
  it("accepts a benign BOM path without searching its unchanged non-BOM counterpart", () => {
    const r = fixture();
    r.stage("payload.txt", literals[0]);
    r.git(["commit", "-qm", "historical fixture"]);
    const name = "\uFEFFpayload.txt";
    r.stage(name, "clean\n");
    r.git(commitArgs);
    expect([r.show(name), r.show("payload.txt")]).toEqual(["clean", literals[0]]);
  });
  it.each([rulePath, "\uFEFFprivate-rules.txt"])(
    "consumes a rule-file BOM but preserves its path: %s",
    (name) => {
      const r = fixture();
      r.write(name, `\uFEFF${literals[0]}\n`);
      r.git(["config", "--local", ruleSetting, name]);
      r.stage("payload.txt", literals[0]);
      expectBlocked(r.fail().stderr, "payload.txt");
    },
  );
  it.each(["--glob-pathspecs", "--icase-pathspecs", "--noglob-pathspecs", "--literal-pathspecs"])(
    "keeps enumerated filenames literal under %s without private rules",
    (flag) => {
      const r = fixture();
      r.withoutRules();
      const name = "chosen[1].txt";
      r.partial(name, "staged\n", "unstaged\n");
      r.stage(":(exclude)clean.txt", "literal colon\n");
      r.partial("chosen[2].ts", "partial staged\n", "partial unstaged\n");
      expect(
        hooks.run(r.dir, "bash", ["-c", 'exec git "$@" 2>&1', "hook-proof", flag, ...commitArgs]),
      ).toBe("");
      expect(r.show(name)).toBe("staged");
      expect(r.show(":(exclude)clean.txt")).toBe("literal colon");
      expect(r.show("chosen[2].ts")).toBe("partial staged");
      expect(r.read("chosen[2].ts")).toBe("partial unstaged\n");
    },
  );
  it("treats recovered filenames as literal pathspecs even without the guard env", () => {
    const r = fixture();
    const names = ["chosen[3].ts", ":(exclude)partial.ts"];
    for (const name of names) {
      r.partial(name, "keep staged\n", "unstaged only\n");
    }
    // Direct invocation: no guard process pins GIT_LITERAL_PATHSPECS for the script.
    hooks.run(r.dir, "bash", ["scripts/pre-commit/format-staged.sh"]);
    r.git(["commit", "-qm", "literal proof"]);
    for (const name of names) {
      expect([r.show(name), r.read(name)]).toEqual(["keep staged", "unstaged only\n"]);
    }
  });
  it.each(
    ["--glob-pathspecs", "--icase-pathspecs"].flatMap((flag) =>
      ["only", "alternate"].map((index) => ({ flag, index })),
    ),
  )("preserves $index commit index authority under $flag", ({ flag, index }) => {
    const r = fixture();
    const name = "chosen[1].txt";
    r.stage(name, "original\n");
    r.stage("excluded.txt", "original excluded\n");
    r.git(["commit", "-qm", "initial fixture"]);
    const indexFile = path.join(r.dir, ".git/selected-index");
    fs.copyFileSync(path.join(r.dir, ".git/index"), indexFile);
    r.stage("excluded.txt", literals[0]);
    const env =
      index === "alternate"
        ? { GIT_INDEX_FILE: indexFile, GIT_DIR: path.join(r.dir, ".git"), GIT_WORK_TREE: r.dir }
        : undefined;
    const select = flag === "--glob-pathspecs" ? "chosen*.txt" : "CHOSEN[1].TXT";
    const args = [flag, ...commitArgs, ...(index === "only" ? ["--only", "--", select] : [])];
    r.write(name, "selected staged\n");
    r.git(["--literal-pathspecs", "add", "--", name], env);
    r.write(name, "selected unstaged\n");
    r.git(args, env);
    // --only commits working-tree bytes; an ordinary commit must keep staged bytes.
    expect(r.show(name)).toBe(index === "only" ? "selected unstaged" : "selected staged");
    expect(r.read(name)).toBe("selected unstaged\n");
    expect(r.show("excluded.txt")).toBe("original excluded");
    expect(r.show("excluded.txt", "")).toBe(literals[0]);
    expect(r.read("excluded.txt")).toBe(literals[0]);
    const head = r.git(["rev-parse", "HEAD"]);
    r.write(name, literals[0]);
    r.git(["--literal-pathspecs", "add", "--", name], env);
    expectBlocked(r.fail(args, env).stderr, name);
    expect([r.git(["rev-parse", "HEAD"]), r.show("excluded.txt", "")]).toEqual([head, literals[0]]);
  });
});

describe("pre-commit formatter capture", () => {
  it.each([
    [2, "could not complete", 1],
    [1, "failed", 23],
  ] as const)("discards oversized capture on stream %s", (stream, message, exitCode) => {
    const r = captureFixture(stream, true);
    const result = r.fail();
    const output = result.stdout + result.stderr;
    expect(output).toContain(`Formatter ${message}`);
    expect(output.length).toBeLessThan(300);
    expect(output).not.toMatch(/\.{2}|SYNTHETIC|x{2}|REDACTED|ACTIONABLE_TAIL/);
    expect(output).toContain(`[pre-commit] FAILED (exit ${exitCode})\n`);
    if (stream === 1) {
      expect(r.show("payload.ts", "")).toBe("clean");
    }
    expect(r.fail(["rev-parse", "--verify", "HEAD"]).status).not.toBe(0);
  });
  it("stages formatter stdout for partially staged files and rescans it", () => {
    const r = captureFixture(1);
    const failed = r.failHook();
    expect(failed.status).toBe(23);
    expect(failed.stdout + failed.stderr).not.toMatch(/ACTIONABLE_TAIL|\[REDACTED\]/);
    expect(r.show("payload.ts", "")).toBe("clean");
    // On success stdout becomes staged content, owned by the post-format scan.
    diagnosticFormatter(r, 1, 0);
    expectBlocked(r.fail().stderr, "payload.ts");
  });
  it("discards captures when the formatter shell is terminated by a signal", () => {
    const r = fixture();
    r.stage("payload.ts", "clean\n");
    r.formatter(`#!/usr/bin/env bash
printf 'INCOMPLETE_STDOUT'
printf 'INCOMPLETE_STDERR' >&2
kill -TERM "$PPID"
`);
    const result = r.fail();
    expect(result.stdout + result.stderr).not.toContain("INCOMPLETE");
    expect(result.stderr).toContain("Formatter could not complete");
    expect(result.stderr).toContain("FAILED (exit 1)");
  });
  it("fails safely when the formatter shell cannot be spawned", () => {
    const r = fixture();
    r.stage("payload.txt", "clean\n");
    const bin = path.join(r.dir, "bin");
    fs.symlinkSync(process.execPath, path.join(bin, "node"));
    const [git, originalPath] = [hooks.run(r.dir, "which", ["git"]), process.env.PATH ?? ""].map(
      (value) => `'${value.replaceAll("'", "'\\''")}'`,
    );
    // Git may itself be a wrapper; only the formatter child must lack Bash.
    hooks.writeExecutable(bin, "git", `#!/bin/sh\nPATH=${originalPath} exec ${git} "$@"\n`);
    expect(r.git(["rev-parse", "--show-toplevel"], { PATH: bin })).toBe(r.dir);
    const result = hooks.runFailure(r.dir, "/bin/bash", ["git-hooks/pre-commit"], { PATH: bin });
    expect(result).toMatchObject({ status: 1, stdout: "" });
    expect(result.stderr).toContain("Formatter could not complete");
    expect(result.stderr).toContain("FAILED (exit 1)");
  });
  it.each([true, false])("drains piped stderr diagnostics: rules=%s", (configured) => {
    const r = fixture();
    if (!configured) {
      r.withoutRules();
    }
    const context = configured
      ? `public diagnostic context ${literals[0]}\n`
      : "public diagnostic context\n";
    const payload = context.repeat(4000) + "ACTIONABLE_FINAL_DETAIL\n";
    const redacted = payload.replaceAll(literals[0], "[REDACTED]");
    r.partial("payload.ts", "clean\n", payload);
    diagnosticFormatter(r, 2, 23);
    for (const [cmd, args] of [
      ["bash", ["git-hooks/pre-commit"]],
      ["git", commitArgs],
    ] as const) {
      const result = hooks.runFailure(r.dir, cmd, [...args]);
      const output = result.stdout + result.stderr;
      expect(result.status).toBe(cmd === "git" ? 1 : 23);
      expect(output.startsWith(redacted)).toBe(true);
      expect(output).not.toContain(literals[0]);
      expect(output.endsWith(failureLine)).toBe(true);
      expect(output.match(/\[pre-commit\] FAILED/g)).toHaveLength(1);
      expect(r.show("payload.ts", "")).toBe("clean");
    }
    diagnosticFormatter(r, 2, 0, true);
    expect(
      hooks.run(r.dir, "bash", ["-c", 'exec git "$@" 2>&1', "hook-proof", ...commitArgs]),
    ).toBe(redacted.trim());
    expect(r.show("payload.ts")).toBe("clean");
  });
});

function operationFixture(linked: boolean, revert = false) {
  const primary = fixture();
  const commit = (name: string, content: string) => {
    primary.stage(name, content);
    primary.git(["commit", "-qm", "operation fixture"]);
  };
  commit("changed.ts", "export const value = 0;\n");
  primary.git(["checkout", "-qb", "side"]);
  commit("changed.ts", "export const value = 1;\n");
  commit("next.txt", "next step\n");
  primary.git(["checkout", "-q", "main"]);
  if (revert) {
    primary.git(["merge", "--ff-only", "side"]);
  }
  commit("changed.ts", "export const value = 2;\n");
  if (!linked) {
    return { r: primary, primary };
  }
  const dir = path.join(primary.dir, "linked");
  primary.git(["worktree", "add", "-qb", "linked", dir, "HEAD"]);
  hooks.installPreCommitFixture(dir);
  return { r: fixture(dir), primary };
}

describe.each([false, true])("Git operation state (linked=%s)", (linked) => {
  it.each([
    ["merge", "MERGE_HEAD", ["merge", "--no-commit", "side"]],
    ["rebase merge", "rebase-merge/git-rebase-todo", ["rebase", "--merge", "side"]],
    ["rebase apply", "rebase-apply/next", ["rebase", "--apply", "side"]],
    ["cherry-pick", "CHERRY_PICK_HEAD", ["cherry-pick", "side~1"]],
    ["revert", "REVERT_HEAD", ["revert", "--no-edit", "side~1"]],
    ["cherry-pick sequencer-only", "sequencer/todo", ["cherry-pick", "side~1", "side"]],
    ["revert sequencer-only", "sequencer/todo", ["revert", "--no-edit", "side~1", "side"]],
  ] satisfies [string, string, string[]][])(
    "preserves operation staging during %s",
    (operation, state, args) => {
      const { r, primary } = operationFixture(linked, operation.startsWith("revert"));
      expect(r.fail(args).status).toBe(1);
      expect(r.git(["ls-files", "--unmerged"])).not.toBe("");
      const metadata = r.metadata(state);
      if (linked) {
        expect(fs.existsSync(path.join(primary.dir, ".git", state))).toBe(false);
      }
      if (state === "sequencer/todo") {
        r.stage("changed.ts", "export const value = 3;\n");
        // Resolution clears the per-step ref while later steps remain queued.
        r.git(commitArgs);
        r.assertNoMetadata(["CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD"]);
      }
      const before = fs.readFileSync(metadata);
      const staged = "export const value=4;\n";
      const unstaged = `${staged}// unstaged edit\n`;
      r.partial("changed.ts", staged, unstaged);
      const stagedOid = r.git(["rev-parse", ":changed.ts"]);
      const log = recordFormatting(r);
      expect(r.hook()).toBe("");
      expect(hooks.readFormatterLog(log)).toEqual([]);
      expect(r.git(["rev-parse", ":changed.ts"])).toBe(stagedOid);
      expect(r.read("changed.ts")).toBe(unstaged);
      expect(fs.readFileSync(metadata)).toEqual(before);
      r.stage("changed.ts", literals[1]);
      expect(r.failHook().stderr).toContain("Blocked staged content");
      r.partial("changed.ts", staged, unstaged);
      r.git(commitArgs);
      expect(hooks.readFormatterLog(log)).toEqual([]);
      expect(r.git(["rev-parse", "HEAD:changed.ts"])).toBe(stagedOid);
      expect(r.read("changed.ts")).toBe(unstaged);
    },
  );
  it("formats and restages with an orphan REBASE_HEAD", () => {
    const { r, primary } = operationFixture(linked);
    if (linked) {
      // Another worktree's rebase must not suppress this worktree's ordinary commit.
      expect(primary.fail(["rebase", "--merge", "side"]).status).toBe(1);
    }
    const head = r.git(["rev-parse", "HEAD"]);
    r.git(["update-ref", "REBASE_HEAD", head]);
    r.assertNoMetadata([...operationRefs, ...operationDirs]);
    expect(r.fail(["rebase", "--continue"]).stderr).toContain("no rebase in progress");
    const working = "export const value=5;\n";
    r.stage("changed.ts", working);
    const log = recordFormatting(r);
    expect(r.hook()).toBe("formatted");
    expect(hooks.readFormatterLog(log)).toEqual([
      "oxfmt --write --threads=1 --no-error-on-unmatched-pattern changed.ts",
    ]);
    expect(r.read("changed.ts")).toBe(`${working}// formatted\n`);
    expect(r.show("changed.ts", "")).toBe(`${working}// formatted`);
    expect(r.git(["diff", "--", "changed.ts"])).toBe("");
    expect(r.git(["rev-parse", "REBASE_HEAD"])).toBe(head);
  });
});
