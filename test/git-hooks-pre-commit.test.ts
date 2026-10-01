// Git hook tests validate pre-commit hook behavior and scripts.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  commitArgs,
  createContentGuardFixture,
  installFormattingRecorder,
  installPreCommitFixture,
  readFormatterLog,
  literals,
  rulePath,
  ruleSetting,
  run,
  runFailure,
  stageContent as stage,
  writeExecutable,
} from "./git-hooks-pre-commit.test-support.js";
import { cleanupTempDirs, makeTempDir as makeTempRepoRoot } from "./helpers/temp-dir.js";

const tempDirs: string[] = [];

function installRunNodeToolFixture(dir: string): void {
  mkdirSync(path.join(dir, "scripts", "pre-commit"), { recursive: true });
  symlinkSync(
    path.join(process.cwd(), "scripts", "pre-commit", "run-node-tool.sh"),
    path.join(dir, "scripts", "pre-commit", "run-node-tool.sh"),
  );
}

function splitNonEmptyLines(output: string): string[] {
  const lines: string[] = [];
  for (const line of output.split("\n")) {
    if (line) {
      lines.push(line);
    }
  }
  return lines;
}

afterEach(() => {
  cleanupTempDirs(tempDirs);
});

describe("git-hooks/pre-commit (integration)", () => {
  it("does not treat staged filenames as git-add flags (e.g. --all)", () => {
    const dir = makeTempRepoRoot(tempDirs, "openclaw-pre-commit-");
    run(dir, "git", ["init", "-q", "--initial-branch=main"]);

    // Use the real hook script and lightweight helper stubs.
    const fakeBinDir = installPreCommitFixture(dir);
    // Create an untracked file that should NOT be staged by the hook.
    writeFileSync(path.join(dir, "secret.txt"), "do-not-stage\n", "utf8");

    // Stage a maliciously-named file. Older hooks using `xargs git add` could run `git add --all`.
    writeFileSync(path.join(dir, "--all"), "flag\n", "utf8");
    run(dir, "git", ["add", "--", "--all"]);

    // Run the hook directly (same logic as when installed via core.hooksPath).
    run(dir, "bash", ["git-hooks/pre-commit"], {
      PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
    });

    const staged = splitNonEmptyLines(run(dir, "git", ["diff", "--cached", "--name-only"]));
    expect(staged).toEqual(["--all"]);
  });

  it.each(["configured", "unconfigured", "external"])(
    "formats staged files with %s private rules",
    (mode) => {
      const dir = makeTempRepoRoot(tempDirs, "openclaw-pre-commit-normal-");
      run(dir, "git", ["init", "-q", "--initial-branch=main"]);
      const fakeBinDir = installPreCommitFixture(dir);
      const logPath = installFormattingRecorder(dir);
      if (mode === "unconfigured") {
        run(dir, "git", ["config", "--local", "--unset", ruleSetting]);
        unlinkSync(path.join(dir, rulePath));
      } else if (mode === "external") {
        const privateDir = makeTempRepoRoot(tempDirs, "openclaw-private-rules-");
        const privatePath = path.join(privateDir, "private rules.txt");
        copyFileSync(path.join(dir, rulePath), privatePath);
        unlinkSync(path.join(dir, rulePath));
        run(dir, "git", ["config", "--local", ruleSetting, privatePath]);
        expect(run(dir, "git", ["config", "--path", "--get", ruleSetting])).toBe(privatePath);
      }

      writeFileSync(
        path.join(dir, "changed.ts"),
        mode === "unconfigured" ? literals[0] : "export const value = 1;\n",
        "utf8",
      );
      run(dir, "git", ["add", "--", "changed.ts"]);

      run(dir, "bash", ["git-hooks/pre-commit"], {
        PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
      });

      expect(readFormatterLog(logPath)).toEqual([
        "oxfmt --write --threads=1 --no-error-on-unmatched-pattern changed.ts",
      ]);
      if (mode === "external") {
        writeFileSync(path.join(dir, "changed.ts"), literals[0]);
        run(dir, "git", ["add", "--", "changed.ts"]);
        expect(runFailure(dir, "bash", ["git-hooks/pre-commit"]).stderr).toContain(
          "Blocked staged content",
        );
      }
    },
  );

  it("formats only staged bytes of a partially staged file and preserves the working tree", () => {
    const dir = createContentGuardFixture(tempDirs);
    writeExecutable(
      path.join(dir, "node_modules/.bin"),
      "oxfmt",
      `#!/usr/bin/env bash
set -euo pipefail
printf 'oxfmt %s\n' "$*" >> hook-tool.log
case "$*" in *--stdin-filepath=*) sed 's/FORMAT_ME/FORMATTED/' ;; esac
`,
    );
    const staged = "export const value = FORMAT_ME;\n";
    const working = `${staged}export const unstagedOnly = 1;\n`;
    stage(dir, "partial.ts", staged);
    writeFileSync(path.join(dir, "partial.ts"), working);

    run(dir, "git", commitArgs);

    expect(run(dir, "git", ["show", "HEAD:partial.ts"])).toBe("export const value = FORMATTED;");
    expect(readFileSync(path.join(dir, "partial.ts"), "utf8")).toBe(working);
    expect(readFormatterLog(path.join(dir, "hook-tool.log"))).toEqual([
      "oxfmt --stdin-filepath=partial.ts",
    ]);
  });

  it("preserves formatted staged content when the working-tree copy is deleted", () => {
    const dir = createContentGuardFixture(tempDirs);
    stage(dir, "gone.ts", "export const keep = 1;\n");
    unlinkSync(path.join(dir, "gone.ts"));

    run(dir, "git", commitArgs);

    expect(run(dir, "git", ["show", "HEAD:gone.ts"])).toBe("export const keep = 1;");
    expect(existsSync(path.join(dir, "gone.ts"))).toBe(false);
  });

  it("leaves staged symlinks untouched even when retargeted in the working tree", () => {
    const dir = createContentGuardFixture(tempDirs);
    writeFileSync(path.join(dir, "target-a.ts"), "const unformatted =  1\n", "utf8");
    writeFileSync(path.join(dir, "target-b.ts"), "const other = 2;\n", "utf8");
    symlinkSync("target-a.ts", path.join(dir, "alias.ts"));
    run(dir, "git", ["add", "--", "alias.ts"]);
    unlinkSync(path.join(dir, "alias.ts"));
    symlinkSync("target-b.ts", path.join(dir, "alias.ts"));

    run(dir, "git", commitArgs);

    expect(run(dir, "git", ["show", "HEAD:alias.ts"])).toBe("target-a.ts");
    expect(readFileSync(path.join(dir, "alias.ts"), "utf8")).toBe("const other = 2;\n");
  });

  it("fails instead of staging empty formatter output for a partially staged file", () => {
    const dir = createContentGuardFixture(tempDirs);
    // Drain stdin so SIGPIPE cannot preempt the hook's empty-output check.
    writeExecutable(
      path.join(dir, "node_modules/.bin"),
      "oxfmt",
      "#!/bin/sh\ncat >/dev/null\nexit 0\n",
    );
    stage(dir, "partial.ts", "export const value = 1;\n");
    writeFileSync(
      path.join(dir, "partial.ts"),
      "export const value = 1;\nexport const extra = 2;\n",
    );

    const result = runFailure(dir, "git", commitArgs);

    expect(result.stderr).toContain("Formatter returned no output");
    expect(run(dir, "git", ["show", ":partial.ts"])).toBe("export const value = 1;");
    expect(runFailure(dir, "git", ["rev-parse", "--verify", "HEAD"]).status).not.toBe(0);
  });

  it("does not run the changed-scope check for non-doc staged changes", () => {
    const dir = makeTempRepoRoot(tempDirs, "openclaw-pre-commit-no-check-changed-");
    run(dir, "git", ["init", "-q", "--initial-branch=main"]);

    const fakeBinDir = installPreCommitFixture(dir);
    writeFileSync(path.join(dir, "package.json"), '{"name":"tmp"}\n', "utf8");
    writeFileSync(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
    writeExecutable(
      fakeBinDir,
      "pnpm",
      "#!/usr/bin/env bash\necho 'pnpm should not run from pre-commit' >&2\nexit 99\n",
    );

    writeFileSync(path.join(dir, "tracked.txt"), "hello\n", "utf8");
    run(dir, "git", ["add", "--", "tracked.txt"]);

    run(dir, "bash", ["git-hooks/pre-commit"], {
      PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
    });

    expect(run(dir, "git", ["diff", "--cached", "--name-only"])).toBe("tracked.txt");
  });

  it("does not re-add staged paths that are ignored by the current .gitignore", () => {
    const dir = makeTempRepoRoot(tempDirs, "openclaw-pre-commit-ignored-staged-");
    run(dir, "git", ["init", "-q", "--initial-branch=main"]);

    const fakeBinDir = installPreCommitFixture(dir);
    mkdirSync(path.join(dir, ".agents", "skills", "discord-clawd"), { recursive: true });
    writeFileSync(path.join(dir, ".gitignore"), ".agents/skills/discord-clawd/\n", "utf8");
    writeFileSync(
      path.join(dir, ".agents", "skills", "discord-clawd", "SKILL.md"),
      "# Discord Clawd\n",
      "utf8",
    );

    run(dir, "git", ["add", "--", ".gitignore"]);
    run(dir, "git", ["add", "-f", "--", ".agents/skills/discord-clawd/SKILL.md"]);

    run(dir, "bash", ["git-hooks/pre-commit"], {
      PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
    });

    const staged = splitNonEmptyLines(run(dir, "git", ["diff", "--cached", "--name-only"]));
    expect(staged).toEqual([".agents/skills/discord-clawd/SKILL.md", ".gitignore"]);
  });
});

describe("staged content guard", () => {
  const fixture = () => createContentGuardFixture(tempDirs);

  function blocked(dir: string, names: string[], commit = false) {
    const result = commit
      ? runFailure(dir, "git", commitArgs)
      : runFailure(dir, "bash", ["git-hooks/pre-commit"]);
    const output = result.stdout + result.stderr;
    expect(result.status).toBe(1);
    expect(output).toContain("Blocked staged content");
    expect(output).toContain("restage");
    for (const name of names) {
      expect(output).toContain(JSON.stringify(name));
    }
    for (const literal of literals) {
      expect(output).not.toContain(literal);
    }
    expect(output).not.toContain("PRIVATE_SOURCE_CONTEXT");
    return result;
  }

  it.each(literals)(
    "blocks staged literal %s before formatting even with a clean working tree",
    (literal) => {
      const dir = fixture();
      const log = installFormattingRecorder(dir);
      stage(dir, "payload.ts", `PRIVATE_SOURCE_CONTEXT prefix${literal}suffix\n`);
      writeFileSync(path.join(dir, "payload.ts"), "clean working tree\n");
      blocked(dir, ["payload.ts"], true);
      expect(readFormatterLog(log)).toEqual([]);
      expect(runFailure(dir, "git", ["rev-parse", "--verify", "HEAD"]).status).not.toBe(0);
    },
  );

  it.each(["payload.txt", "payload.ts"])(
    "keeps unstaged working-tree bytes out of the commit: %s",
    (name) => {
      const dir = fixture();
      stage(dir, name, "clean staged version\n");
      writeFileSync(path.join(dir, name), literals[0]);
      run(dir, "git", commitArgs);
      expect(run(dir, "git", ["show", `HEAD:${name}`])).toBe("clean staged version");
      expect(readFileSync(path.join(dir, name), "utf8")).toBe(literals[0]);
    },
  );

  it("discovers a new path staged during formatting", () => {
    const dir = fixture();
    stage(dir, "payload.ts", "clean\n");
    writeFileSync(path.join(dir, "introduced.txt"), literals[1]);
    const log = installFormattingRecorder(dir, "git add -- introduced.txt");
    blocked(dir, ["introduced.txt"], true);
    expect(readFormatterLog(log)).toHaveLength(1);
  });

  it("uses fixed, case-sensitive matches despite Git grep defaults", () => {
    const dir = fixture();
    run(dir, "git", ["config", "grep.patternType", "extended"]);
    run(dir, "git", ["config", "grep.ignoreCase", "true"]);
    stage(dir, "payload.txt", `${literals[0].toLowerCase()}\nGUARD_SYNTHETIC_BETA_xanything42\n`);
    run(dir, "git", commitArgs);
    expect(run(dir, "git", ["show", "HEAD:payload.txt"])).toContain("xanything42");
  });

  it("scans unchanged lines in modified files but permits unchanged history and deletion-only commits", () => {
    const dir = fixture();
    stage(dir, "historical.txt", `${literals[0]}\nold line\n`);
    run(dir, "git", ["commit", "-qm", "historical fixture"]);
    stage(dir, "clean.txt", "clean\n");
    run(dir, "git", commitArgs);
    stage(dir, "historical.txt", `${literals[0]}\nnew line\n`);
    blocked(dir, ["historical.txt"]);
    run(dir, "git", ["rm", "-f", "--", "historical.txt"]);
    run(dir, "git", commitArgs);
    expect(run(dir, "git", ["ls-tree", "--name-only", "HEAD"])).toBe("clean.txt");
  });

  it.each(["rename", "typechange", "binary"])("scans the full staged blob for %s", (kind) => {
    const dir = fixture();
    if (kind === "rename") {
      stage(dir, "old.txt", literals[0]);
      run(dir, "git", ["commit", "-qm", "historical fixture"]);
      run(dir, "git", ["mv", "--", "old.txt", "payload.txt"]);
    } else if (kind === "typechange") {
      symlinkSync("absent-target", path.join(dir, "payload.txt"));
      run(dir, "git", ["add", "--", "payload.txt"]);
      run(dir, "git", ["commit", "-qm", "symlink fixture"]);
      unlinkSync(path.join(dir, "payload.txt"));
      stage(dir, "payload.txt", literals[0]);
    } else {
      stage(
        dir,
        "payload.txt",
        Buffer.concat([Buffer.from([0, 255]), Buffer.from(literals[1]), Buffer.from([0])]),
      );
    }
    blocked(dir, ["payload.txt"]);
  });

  it("reports literal paths safely and includes ignored docs, tests and generated files", () => {
    const dir = fixture();
    writeFileSync(path.join(dir, ".gitignore"), "ignored/\n");
    const names = [
      "space name.txt",
      "--all",
      ":(exclude)payload.txt",
      "[literal]*?.txt",
      "line\nbreak.txt",
      "control\u001b.txt",
      "ignored/file.txt",
      "docs/example.md",
      "test/example.ts",
      "extensions/example/src/host/web/file.bundle.js",
    ];
    for (const name of names) {
      stage(dir, name, literals[0]);
    }
    stage(dir, `${literals[0]}.txt`, literals[1]);
    const result = blocked(dir, [...names, "[REDACTED].txt"]);
    expect(result.stderr).not.toContain("\u001b");
  });

  it("scans the former public rule filename and beyond both batch limits", () => {
    const dir = fixture();
    const formerRulePath = "scripts/pre-commit/blocked-literals.txt";
    stage(dir, formerRulePath, literals[0]);
    blocked(dir, [formerRulePath]);
    // Long paths cross the byte budget first; short paths also cross the 256-entry count budget.
    const batchPaths = [];
    for (let i = 0; i < 600; i++) {
      const suffix = i < 70 ? `/${"x".repeat(180)}/${"y".repeat(180)}` : "";
      const name = `batch-${String(i).padStart(3, "0")}${suffix}.txt`;
      mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      writeFileSync(path.join(dir, name), "clean\n");
      batchPaths.push(name);
    }
    run(dir, "git", ["add", "--", ...batchPaths]);
    stage(dir, formerRulePath, "clean\n");
    stage(dir, "zzz-last.txt", literals[1]);
    blocked(dir, ["zzz-last.txt"]);
  });

  it("permits unborn and existing empty commits and ignores submodule contents", () => {
    const dir = fixture();
    run(dir, "git", [...commitArgs, "--allow-empty"]);
    run(dir, "git", [...commitArgs, "--allow-empty"]);
    const head = run(dir, "git", ["rev-parse", "HEAD"]);
    run(dir, "git", ["update-index", "--add", "--cacheinfo", `160000,${head},submodule`]);
    mkdirSync(path.join(dir, "submodule"));
    writeFileSync(path.join(dir, "submodule", "payload.txt"), literals[0]);
    run(dir, "bash", ["git-hooks/pre-commit"]);
    expect(run(dir, "git", ["diff", "--cached", "--name-only"])).toBe("submodule");
  });

  it.each([
    ["missing file", null],
    ["empty file", ""],
    ["blank lines", "\n\n"],
    ["invalid UTF-8", Buffer.from([255])],
    ["NUL literal", "\0"],
    ["empty setting", undefined],
  ])("fails closed with %s", (_label, content) => {
    const dir = fixture();
    const log = installFormattingRecorder(dir);
    stage(dir, "payload.ts", "clean\n");
    if (content === undefined) {
      run(dir, "git", ["config", "--local", ruleSetting, ""]);
    } else if (content === null) {
      unlinkSync(path.join(dir, rulePath));
    } else {
      writeFileSync(path.join(dir, rulePath), content);
    }
    const result = runFailure(dir, "bash", ["git-hooks/pre-commit"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(ruleSetting);
    expect(result.stderr).toContain("retry");
    expect(result.stdout + result.stderr).not.toContain(path.join(dir, rulePath));
    expect(readFormatterLog(log)).toEqual([]);
  });

  it.each([
    ["literal metacharacters", [...literals], literals.join(" "), "[REDACTED] [REDACTED]"],
    [
      "shorter prefix first",
      ["foo", "foobar"],
      "foobar foo FOOBAR",
      "[REDACTED] [REDACTED] FOOBAR",
    ],
    ["longer prefix first", ["foobar", "foo"], "foobar foo FOOBAR", "[REDACTED] [REDACTED] FOOBAR"],
    ["crossing overlaps", ["abc", "bcd"], "abcd", "[REDACTED]"],
    ["reversed crossing overlaps", ["bcd", "abc"], "abcd", "[REDACTED]"],
    ["self-overlap", ["aba"], "ababa", "[REDACTED]"],
    ["marker literal", ["foo", "REDACTED"], "foo REDACTED", "[REDACTED] [REDACTED]"],
  ])(
    "redacts filenames and formatter streams with %s while preserving failure status",
    (_label, rules, text, redacted) => {
      const dir = fixture();
      writeFileSync(path.join(dir, rulePath), `${rules.join("\n")}\n`);
      const name = `report-${text}\n🦞.ts`;
      stage(dir, name, text);
      const finding = runFailure(dir, "bash", ["git-hooks/pre-commit"]);

      stage(dir, name, "clean\n");
      const context = `🦞 café ${text}\nuntouched ${text} tail\n`;
      const expected = `🦞 café ${redacted}\nuntouched ${redacted} tail\n`;
      installFormattingRecorder(
        dir,
        `printf 'stdout %s' '${context}'\nprintf 'stderr %s' '${context}' >&2\nprintf broken > .git/index\nexit 23`,
      );
      const result = runFailure(dir, "bash", ["git-hooks/pre-commit"]);
      expect(result).toEqual({
        status: 23,
        stdout: `stdout ${expected}`,
        stderr: `stderr ${expected}[pre-commit] Formatter failed. Fix the reported error and retry.\n[pre-commit] FAILED (exit 23)\n`,
      });
      expect(finding.status).toBe(1);
      expect(finding.stderr).toContain(`  ${JSON.stringify(`report-${redacted}\n🦞.ts`)}\n`);
    },
  );

  it.each(["config path", "index", "blob", "post-format blob"])(
    "blocks Git %s read errors without raw diagnostics",
    (kind) => {
      const dir = fixture();
      const name = `${literals[0]}.txt`;
      stage(dir, name, "clean\n");
      if (kind === "config path") {
        run(dir, "git", ["config", "--local", ruleSetting, `~${literals[1]}/private rules.txt`]);
        expect(runFailure(dir, "git", ["config", "--path", "--get", ruleSetting]).status).not.toBe(
          1,
        );
      } else if (kind === "index") {
        writeFileSync(path.join(dir, ".git/index"), literals[1]);
      } else {
        const oid = run(dir, "git", ["rev-parse", `:${name}`]);
        const objectPath = `.git/objects/${oid.slice(0, 2)}/${oid.slice(2)}`;
        if (kind === "post-format blob") {
          // Keep git add from recreating the missing blob before the post-scan.
          writeFileSync(path.join(dir, ".gitignore"), "*.txt\n");
          stage(dir, "trigger.ts", "formatter trigger\n");
          installFormattingRecorder(dir, `rm -- '${objectPath}'`);
        } else {
          unlinkSync(path.join(dir, objectPath));
          const grep = runFailure(dir, "git", [
            "grep",
            "--cached",
            "--fixed-strings",
            "clean",
            "--",
            name,
          ]);
          expect(grep.status).toBe(1);
          expect(grep.stderr.length).toBeGreaterThan(0);
        }
      }
      const result = runFailure(dir, "bash", ["git-hooks/pre-commit"]);
      expect(result.stderr).toContain("Git could not");
      for (const literal of literals) {
        expect(result.stdout + result.stderr).not.toContain(literal);
      }
      expect(result.stderr).not.toContain("error:");
    },
  );
});

describe("scripts/pre-commit/run-node-tool.sh", () => {
  function toolingFixture() {
    const dir = createContentGuardFixture(tempDirs);
    const owner = makeTempRepoRoot(tempDirs, "openclaw-hook-tooling-");
    run(owner, "git", ["init", "-q", "--initial-branch=main"]);
    for (const root of [dir, owner]) {
      run(root, "git", ["remote", "add", "origin", "https://github.com/example/project.git"]);
      writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({ devDependencies: { oxfmt: "0.68.0" } }),
      );
    }
    rmSync(path.join(dir, "node_modules"), { recursive: true });
    const pkg = path.join(owner, "node_modules/oxfmt");
    const bindingName = `@oxfmt/binding-${process.platform}-${process.arch}`;
    const binding = path.join(owner, "node_modules", bindingName);
    const dependency = path.join(owner, "node_modules/tinypool");
    mkdirSync(pkg, { recursive: true });
    mkdirSync(binding, { recursive: true });
    mkdirSync(dependency, { recursive: true });
    writeFileSync(
      path.join(dependency, "package.json"),
      JSON.stringify({ name: "tinypool", version: "2.1.2", main: "index.cjs" }),
    );
    writeFileSync(path.join(dependency, "index.cjs"), "module.exports = {};\n");
    writeFileSync(
      path.join(pkg, "package.json"),
      JSON.stringify({
        name: "oxfmt",
        version: "0.68.0",
        bin: { oxfmt: "cli.cjs" },
        dependencies: { tinypool: "2.1.2" },
        optionalDependencies: { [bindingName]: "0.68.0" },
      }),
    );
    writeFileSync(
      path.join(binding, "package.json"),
      JSON.stringify({
        name: bindingName,
        version: "0.68.0",
        os: [process.platform],
        cpu: [process.arch],
        main: "binding.cjs",
      }),
    );
    writeFileSync(path.join(binding, "binding.cjs"), "module.exports = {};\n");
    const cli = path.join(pkg, "cli.cjs");
    const formatter = `const fs = require("node:fs");
if (process.argv[2] === "--version") { console.log("Version: 0.68.0"); process.exit(0); }
fs.writeFileSync("formatter-call.json", JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }));
if (process.argv.some(arg => arg.startsWith("--stdin-filepath="))) process.stdout.write(fs.readFileSync(0, "utf8").replace("FORMAT_ME", "FORMATTED"));
`;
    writeFileSync(cli, formatter);
    return {
      dir,
      owner,
      pkg,
      binding,
      dependency,
      cli,
      formatter,
      env: { OPENCLAW_PR_TOOLING_ROOT: owner },
    };
  }

  it.each(["environment", "config", "canonical"])(
    "uses the %s tooling owner with task cwd and exact arguments",
    (selection) => {
      const fixture = toolingFixture();
      let { dir } = fixture;
      const { owner, env } = fixture;
      if (selection === "config") {
        run(dir, "git", ["config", "openclaw.pr.toolingRoot", owner]);
        env.OPENCLAW_PR_TOOLING_ROOT = "";
      } else if (selection === "canonical") {
        run(owner, "git", ["add", "package.json"]);
        run(owner, "git", ["commit", "-qm", "tooling fixture"]);
        dir = path.join(owner, "task");
        run(owner, "git", ["worktree", "add", "--detach", dir, "HEAD"]);
        installPreCommitFixture(dir);
        rmSync(path.join(dir, "node_modules"), { recursive: true });
        env.OPENCLAW_PR_TOOLING_ROOT = "";
      } else {
        run(dir, "git", ["config", "openclaw.pr.toolingRoot", path.join(owner, "missing")]);
      }
      const args = ["--write", "space name.ts", ":(exclude)literal.ts", "line\nbreak.ts"];
      run(dir, "/bin/bash", ["scripts/pre-commit/run-node-tool.sh", "oxfmt", ...args], env);
      expect(JSON.parse(readFileSync(path.join(dir, "formatter-call.json"), "utf8"))).toEqual({
        cwd: dir,
        args,
      });
      expect(existsSync(path.join(dir, "node_modules"))).toBe(false);
      expect(existsSync(path.join(owner, "formatter-call.json"))).toBe(false);
    },
  );

  it.each([
    "wrong pin",
    "wrong package",
    "unrelated",
    "sparse",
    "subdirectory",
    "escaped package",
    "wrong platform",
    "wrong binding pin",
    "broken binding",
    "wrong dependency pin",
    "escaped dependency",
    "drift",
  ])("rejects %s before formatting", (kind) => {
    const { dir, owner, pkg, binding, dependency, cli, formatter, env } = toolingFixture();
    if (kind === "wrong pin" || kind === "wrong package") {
      const manifest = JSON.parse(readFileSync(path.join(pkg, "package.json"), "utf8"));
      if (kind === "wrong pin") {
        manifest.version = "0.60.0";
      } else {
        manifest.name = "another-formatter";
      }
      writeFileSync(path.join(pkg, "package.json"), JSON.stringify(manifest));
    } else if (kind === "unrelated") {
      run(owner, "git", [
        "remote",
        "set-url",
        "origin",
        "https://github.com/example/unrelated.git",
      ]);
    } else if (kind === "sparse") {
      run(owner, "git", ["config", "core.sparseCheckout", "true"]);
    } else if (kind === "subdirectory") {
      env.OPENCLAW_PR_TOOLING_ROOT = pkg;
    } else if (kind === "escaped package") {
      const outside = makeTempRepoRoot(tempDirs, "openclaw-outside-formatter-");
      rmSync(pkg, { recursive: true });
      symlinkSync(outside, pkg);
    } else if (kind === "wrong platform" || kind === "wrong binding pin") {
      const manifest = JSON.parse(readFileSync(path.join(binding, "package.json"), "utf8"));
      if (kind === "wrong platform") {
        manifest.cpu = ["unsupported"];
      } else {
        manifest.version = "0.60.0";
      }
      writeFileSync(path.join(binding, "package.json"), JSON.stringify(manifest));
    } else if (kind === "broken binding") {
      writeFileSync(
        path.join(binding, "binding.cjs"),
        'throw new Error("unusable native binding");',
      );
    } else if (kind === "wrong dependency pin") {
      const manifest = JSON.parse(readFileSync(path.join(dependency, "package.json"), "utf8"));
      manifest.version = "1.0.0";
      writeFileSync(path.join(dependency, "package.json"), JSON.stringify(manifest));
    } else if (kind === "escaped dependency") {
      const outside = makeTempRepoRoot(tempDirs, "openclaw-outside-dependency-");
      rmSync(dependency, { recursive: true });
      writeFileSync(
        path.join(outside, "package.json"),
        JSON.stringify({ name: "tinypool", version: "2.1.2", main: "index.cjs" }),
      );
      writeFileSync(path.join(outside, "index.cjs"), "module.exports = {};\n");
      symlinkSync(outside, dependency);
    } else {
      writeFileSync(
        cli,
        formatter.replace(
          "console.log",
          `fs.appendFileSync(${JSON.stringify(path.join(pkg, "package.json"))}, " "); console.log`,
        ),
      );
    }
    const result = runFailure(
      dir,
      "/bin/bash",
      ["scripts/pre-commit/run-node-tool.sh", "oxfmt", "--write", "a.ts"],
      env,
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Cannot use tooling-owner oxfmt");
    expect(existsSync(path.join(dir, "formatter-call.json"))).toBe(false);
    expect(existsSync(path.join(dir, "node_modules"))).toBe(false);
  });

  it.each(["false", "0", "override"])("allows inactive NAPI_RS_FORCE_WASI=%s", (value) => {
    const { dir, owner, env } = toolingFixture();
    const args = ["--write", "space name.ts"];
    run(dir, "/bin/bash", ["scripts/pre-commit/run-node-tool.sh", "oxfmt", ...args], {
      ...env,
      NAPI_RS_FORCE_WASI: value,
    });
    expect(JSON.parse(readFileSync(path.join(dir, "formatter-call.json"), "utf8"))).toEqual({
      cwd: dir,
      args,
    });
    expect(existsSync(path.join(dir, "node_modules"))).toBe(false);
    expect(existsSync(path.join(owner, "formatter-call.json"))).toBe(false);
  });

  it.each([
    ["NAPI_RS_NATIVE_LIBRARY_PATH", "override"],
    ["NAPI_RS_FORCE_WASI", "true"],
    ["NAPI_RS_FORCE_WASI", "error"],
    ["NAPI_RS_WASI_FLAVOR", "wasm32-wasi"],
  ])("rejects the platform override %s=%s before formatting", (key, value) => {
    const { dir, env } = toolingFixture();
    const result = runFailure(
      dir,
      "/bin/bash",
      ["scripts/pre-commit/run-node-tool.sh", "oxfmt", "--write", "a.ts"],
      { ...env, [key]: value },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Cannot qualify an overridden formatter platform binding");
    expect(existsSync(path.join(dir, "formatter-call.json"))).toBe(false);
  });

  it("keeps partial-stage and private-content guards around the tooling formatter", () => {
    const { dir, env } = toolingFixture();
    stage(dir, "partial.ts", "export const value = FORMAT_ME;\n");
    const working = `export const value = FORMAT_ME;\n// ${literals[0]}\n`;
    writeFileSync(path.join(dir, "partial.ts"), working);
    run(dir, "git", commitArgs, env);
    expect(run(dir, "git", ["show", "HEAD:partial.ts"])).toBe("export const value = FORMATTED;");
    expect(readFileSync(path.join(dir, "partial.ts"), "utf8")).toBe(working);
    rmSync(path.join(dir, "formatter-call.json"));
    stage(dir, "blocked.ts", literals[1]);
    const failed = runFailure(dir, "git", commitArgs, env);
    expect(failed.stderr).toContain("Blocked staged content");
    expect(failed.stderr).not.toContain(literals[1]);
    expect(existsSync(path.join(dir, "formatter-call.json"))).toBe(false);
  });

  it("propagates a tooling formatter failure through the hook without committing", () => {
    const { dir, cli, formatter, env } = toolingFixture();
    writeFileSync(cli, `${formatter}\nprocess.exit(23);\n`);
    stage(dir, "a.ts", "export const value = 1;\n");
    const failed = runFailure(dir, "git", commitArgs, env);
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("[pre-commit] FAILED (exit 23)");
    expect(runFailure(dir, "git", ["rev-parse", "--verify", "HEAD"]).status).not.toBe(0);
  });

  it("runs the installed local tool without invoking pnpm", () => {
    const dir = makeTempRepoRoot(tempDirs, "openclaw-run-node-tool-local-");
    installRunNodeToolFixture(dir);
    writeFileSync(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");

    const fakeBinDir = path.join(dir, "bin");
    const toolBinDir = path.join(dir, "node_modules", ".bin");
    mkdirSync(fakeBinDir, { recursive: true });
    mkdirSync(toolBinDir, { recursive: true });
    writeExecutable(
      fakeBinDir,
      "pnpm",
      "#!/usr/bin/env bash\necho 'pnpm should not run from run-node-tool' >&2\nexit 99\n",
    );
    writeExecutable(toolBinDir, "oxfmt", "#!/usr/bin/env bash\nprintf 'local:%s\\n' \"$*\"\n");

    expect(
      run(dir, "bash", ["scripts/pre-commit/run-node-tool.sh", "oxfmt", "--write", "a.ts"], {
        PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
      }),
    ).toBe("local:--write a.ts");
  });

  it("fails before pnpm can hydrate dependencies when node_modules is missing", () => {
    const dir = makeTempRepoRoot(tempDirs, "openclaw-run-node-tool-missing-deps-");
    installRunNodeToolFixture(dir);
    writeFileSync(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");

    const fakeBinDir = path.join(dir, "bin");
    const markerPath = path.join(dir, "pnpm-called");
    mkdirSync(fakeBinDir, { recursive: true });
    writeExecutable(
      fakeBinDir,
      "pnpm",
      `#!/usr/bin/env bash\ntouch ${JSON.stringify(markerPath)}\nexit 99\n`,
    );

    const result = runFailure(
      dir,
      "bash",
      ["scripts/pre-commit/run-node-tool.sh", "oxfmt", "--write", "a.ts"],
      { PATH: `${fakeBinDir}:${process.env.PATH ?? ""}` },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Missing repo dependencies: cannot run oxfmt without node_modules.",
    );
    expect(existsSync(markerPath)).toBe(false);
  });
});
