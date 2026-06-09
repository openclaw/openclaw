// Run Opengrep tests cover run opengrep script behavior.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function copyRunOpengrepFiles(repo: string): void {
  const scriptSource = path.resolve("scripts/run-opengrep.sh");
  const helperSource = path.resolve("scripts/lib/merge-head-diff-base.mjs");
  writeFile(path.join(repo, "scripts/run-opengrep.sh"), fs.readFileSync(scriptSource, "utf8"));
  writeFile(
    path.join(repo, "scripts/lib/merge-head-diff-base.mjs"),
    fs.readFileSync(helperSource, "utf8"),
  );
  fs.chmodSync(path.join(repo, "scripts/run-opengrep.sh"), 0o755);
}

describe("run-opengrep.sh", () => {
  it("validates the rulepack when only OpenGrep rulepack files changed", () => {
    const repo = createTempDir("openclaw-run-opengrep-");
    git(repo, "init", "-q");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test User");

    copyRunOpengrepFiles(repo);
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
        `printf '%s\\n' "$@" > ${JSON.stringify(argsPath)}`,
        "exit 0",
        "",
      ].join("\n"),
    );
    fs.chmodSync(path.join(binDir, "opengrep"), 0o755);

    execFileSync("bash", ["scripts/run-opengrep.sh", "--changed"], {
      cwd: repo,
      env: {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        OPENCLAW_OPENGREP_BASE_REF: "HEAD",
      },
      encoding: "utf8",
    });

    const args = fs.readFileSync(path.join(repo, "opengrep-args.txt"), "utf8");
    expect(args).toContain("security/opengrep/precise.yml");
  });

  it("scans PR files instead of main-only files when the payload base is stale", () => {
    const repo = createTempDir("openclaw-run-opengrep-merge-");
    git(repo, "init", "-q", "--initial-branch=main");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test User");

    copyRunOpengrepFiles(repo);
    writeFile(path.join(repo, "security/opengrep/precise.yml"), "rules: []\n");
    writeFile(path.join(repo, "README.md"), "base\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "base");
    const staleBase = git(repo, "rev-parse", "HEAD");

    git(repo, "switch", "-q", "-c", "feature");
    writeFile(path.join(repo, "src/pr.ts"), "export const pr = true;\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "feature");

    git(repo, "switch", "-q", "main");
    writeFile(path.join(repo, "src/main-only.ts"), "export const mainOnly = true;\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "main only");
    git(repo, "merge", "--no-ff", "feature", "-m", "synthetic merge");

    const argsPath = path.join(repo, "opengrep-args.txt");
    const binDir = path.join(repo, "bin");
    fs.mkdirSync(binDir);
    writeFile(
      path.join(binDir, "opengrep"),
      [
        "#!/usr/bin/env bash",
        `printf '%s\\n' "$@" > ${JSON.stringify(argsPath)}`,
        "exit 0",
        "",
      ].join("\n"),
    );
    fs.chmodSync(path.join(binDir, "opengrep"), 0o755);

    execFileSync("bash", ["scripts/run-opengrep.sh", "--changed"], {
      cwd: repo,
      env: {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        OPENCLAW_OPENGREP_BASE_REF: `${staleBase}...HEAD`,
        OPENCLAW_OPENGREP_MERGE_HEAD_FIRST_PARENT: "1",
      },
      encoding: "utf8",
    });

    const args = fs.readFileSync(argsPath, "utf8");
    expect(args).toContain("src/pr.ts");
    expect(args).not.toContain("src/main-only.ts");
  });

  it("does not pass changed files ignored by semgrepignore as explicit scan paths", () => {
    const repo = createTempDir("openclaw-run-opengrep-ignore-");
    git(repo, "init", "-q", "--initial-branch=main");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test User");

    copyRunOpengrepFiles(repo);
    writeFile(path.join(repo, ".semgrepignore"), "*.test.*\nextensions/qa-*/\nscripts/test-*\n");
    writeFile(path.join(repo, "security/opengrep/precise.yml"), "rules: []\n");
    writeFile(path.join(repo, "src/prod.ts"), "export const prod = 1;\n");
    writeFile(path.join(repo, "src/prod.test.ts"), "export const test = 1;\n");
    writeFile(path.join(repo, "src/foo/extensions/qa-demo/index.ts"), "export const nested = 1;\n");
    writeFile(path.join(repo, "extensions/qa-backdoor.ts"), "export const qaBackdoor = 1;\n");
    writeFile(path.join(repo, "extensions/qa-demo/src/index.ts"), "export const qa = 1;\n");
    writeFile(path.join(repo, "scripts/test-planner/vitest-args.mjs"), "export const plan = 1;\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "base");

    writeFile(path.join(repo, "src/prod.ts"), "export const prod = 2;\n");
    writeFile(path.join(repo, "src/prod.test.ts"), "export const test = 2;\n");
    writeFile(path.join(repo, "src/foo/extensions/qa-demo/index.ts"), "export const nested = 2;\n");
    writeFile(path.join(repo, "extensions/qa-backdoor.ts"), "export const qaBackdoor = 2;\n");
    writeFile(path.join(repo, "extensions/qa-demo/src/index.ts"), "export const qa = 2;\n");
    writeFile(path.join(repo, "scripts/test-planner/vitest-args.mjs"), "export const plan = 2;\n");

    const argsPath = path.join(repo, "opengrep-args.txt");
    const binDir = path.join(repo, "bin");
    fs.mkdirSync(binDir);
    writeFile(
      path.join(binDir, "opengrep"),
      [
        "#!/usr/bin/env bash",
        `printf '%s\\n' "$@" > ${JSON.stringify(argsPath)}`,
        "exit 0",
        "",
      ].join("\n"),
    );
    fs.chmodSync(path.join(binDir, "opengrep"), 0o755);

    execFileSync("bash", ["scripts/run-opengrep.sh", "--changed"], {
      cwd: repo,
      env: {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        OPENCLAW_OPENGREP_BASE_REF: "HEAD",
      },
      encoding: "utf8",
    });

    const args = fs.readFileSync(argsPath, "utf8");
    expect(args).toContain("src/prod.ts");
    expect(args).toContain("src/foo/extensions/qa-demo/index.ts");
    expect(args).toContain("extensions/qa-backdoor.ts");
    expect(args).not.toContain("src/prod.test.ts");
    expect(args).not.toContain("extensions/qa-demo/src/index.ts");
    expect(args).not.toContain("scripts/test-planner/vitest-args.mjs");
  });
});
