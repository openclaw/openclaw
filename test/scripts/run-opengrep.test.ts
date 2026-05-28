import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();
const BASH_COMMAND =
  process.platform === "win32"
    ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "bash.exe")
    : "bash";

function toBashPath(filePath: string): string {
  const normalized = filePath.replaceAll("\\", "/");
  const match = /^([A-Za-z]):\/(.*)$/u.exec(normalized);
  return match ? `/mnt/${match[1].toLowerCase()}/${match[2]}` : normalized;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

describe("run-opengrep.sh", () => {
  it("validates the rulepack when only OpenGrep rulepack files changed", () => {
    const repo = createTempDir("openclaw-run-opengrep-");
    git(repo, "init", "-q");
    git(repo, "config", "core.autocrlf", "false");
    git(repo, "config", "core.eol", "lf");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test User");

    const scriptSource = path.resolve("scripts/run-opengrep.sh");
    writeFile(path.join(repo, "scripts/run-opengrep.sh"), fs.readFileSync(scriptSource, "utf8"));
    fs.chmodSync(path.join(repo, "scripts/run-opengrep.sh"), 0o755);
    writeFile(path.join(repo, "security/opengrep/precise.yml"), "rules: []\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "initial");

    fs.appendFileSync(path.join(repo, "security/opengrep/precise.yml"), "# changed\n");
    const argsPath = path.join(repo, "opengrep-args.txt");
    const binDir = path.join(repo, "bin");
    fs.mkdirSync(binDir);
    writeFile(
      path.join(binDir, "opengrep"),
      [
        "#!/usr/bin/env bash",
        `printf '%s\\n' "$@" > ${shellQuote(toBashPath(argsPath))}`,
        "exit 0",
        "",
      ].join("\n"),
    );
    fs.chmodSync(path.join(binDir, "opengrep"), 0o755);

    const scriptPath = path.join(repo, "scripts/run-opengrep.sh");
    const bashPath =
      process.platform === "win32"
        ? `${toBashPath(binDir)}:/usr/bin:/bin`
        : `${binDir}${path.delimiter}${process.env.PATH ?? ""}`;
    execFileSync(
      BASH_COMMAND,
      [
        "-lc",
        `export PATH=${shellQuote(bashPath)}; ${shellQuote(toBashPath(scriptPath))} --changed`,
      ],
      {
        cwd: repo,
        env: {
          ...process.env,
          OPENCLAW_OPENGREP_BASE_REF: "HEAD",
        },
        encoding: "utf8",
      },
    );

    const args = fs.readFileSync(path.join(repo, "opengrep-args.txt"), "utf8");
    expect(args).toContain("security/opengrep/precise.yml");
  });
});
