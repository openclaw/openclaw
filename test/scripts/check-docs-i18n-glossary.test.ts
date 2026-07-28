import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGitRunner, parseArgs } from "../../scripts/check-docs-i18n-glossary.mjs";
import { cleanupTempDirs, makeTempDir } from "../helpers/temp-dir.js";

const scriptPath = path.resolve("scripts/check-docs-i18n-glossary.mjs");
const tempDirs: string[] = [];

function writeGitFixture(binDir: string, body: string): void {
  if (process.platform === "win32") {
    const fixturePath = path.join(binDir, "git-fixture.mjs");
    writeFileSync(fixturePath, body);
    writeFileSync(
      path.join(binDir, "git.cmd"),
      `@echo off\r\n"${process.execPath}" "${fixturePath}" %*\r\n`,
    );
    return;
  }
  writeFileSync(path.join(binDir, "git"), `#!${process.execPath}\n${body}`, { mode: 0o755 });
}

afterEach(() => {
  cleanupTempDirs(tempDirs);
});

describe("check-docs-i18n-glossary", () => {
  it("parses explicit diff refs", () => {
    expect(parseArgs(["--base", "origin/main", "--head", "HEAD"])).toEqual({
      base: "origin/main",
      head: "HEAD",
    });
  });

  it("rejects missing diff ref values", () => {
    expect(() => parseArgs(["--base", "--head", "HEAD"])).toThrow("--base requires a value");
    expect(() => parseArgs(["--base", "-h", "--head", "HEAD"])).toThrow("--base requires a value");
    expect(() => parseArgs(["--head"])).toThrow("--head requires a value");
    expect(() => parseArgs(["--head", "-h"])).toThrow("--head requires a value");
    expect(() => parseArgs(["--base", ""])).toThrow("--base requires a value");
  });

  it("fails with an actionable timeout when git diff hangs", async () => {
    const tempDir = makeTempDir(tempDirs, "check-docs-i18n-glossary-");
    const binDir = path.join(tempDir, "bin");
    mkdirSync(binDir);
    writeGitFixture(
      binDir,
      'if (process.argv[2] === "diff") { setTimeout(() => {}, 10_000); }\nelse { process.exit(0); }\n',
    );

    const runGit = createGitRunner({
      timeoutMs: 500,
      env: {
        ...process.env,
        PATH: binDir,
      },
    });

    await expect(
      runGit(["diff", "--name-only", "--diff-filter=ACMR", "HEAD~1", "--", "docs"]),
    ).rejects.toThrow(
      "docs:check-i18n-glossary: git diff --name-only --diff-filter=ACMR HEAD~1 -- docs timed out after 500ms.",
    );
  });

  it("propagates timeout diagnostics when git merge-base hangs", async () => {
    const tempDir = makeTempDir(tempDirs, "check-docs-i18n-glossary-");
    const binDir = path.join(tempDir, "bin");
    mkdirSync(binDir);
    writeGitFixture(
      binDir,
      'if (process.argv[2] === "merge-base") { setTimeout(() => {}, 10_000); }\nelse { process.exit(0); }\n',
    );

    const runGit = createGitRunner({
      timeoutMs: 500,
      env: {
        ...process.env,
        PATH: binDir,
      },
    });

    await expect(runGit(["merge-base", "origin/main", "HEAD"])).rejects.toThrow(
      "docs:check-i18n-glossary: git merge-base origin/main HEAD timed out after 500ms.",
    );
  });

  it.skipIf(process.platform === "win32")(
    "escalates to SIGKILL when git ignores SIGTERM",
    async () => {
      const tempDir = makeTempDir(tempDirs, "check-docs-i18n-glossary-");
      const binDir = path.join(tempDir, "bin");
      const readyPath = path.join(tempDir, "ready");
      mkdirSync(binDir);
      writeGitFixture(
        binDir,
        'if (process.argv[2] === "diff") { process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(process.env.PROOF_READY, "ready"); setInterval(() => {}, 10_000); }\nelse { process.exit(0); }\n',
      );

      const runGit = createGitRunner({
        timeoutMs: 500,
        killGraceMs: 150,
        env: {
          ...process.env,
          PATH: binDir,
          PROOF_READY: readyPath,
        },
      });
      const startedAt = Date.now();

      await expect(
        runGit(["diff", "--name-only", "--diff-filter=ACMR", "HEAD~1", "--", "docs"]),
      ).rejects.toThrow(
        "docs:check-i18n-glossary: git diff --name-only --diff-filter=ACMR HEAD~1 -- docs timed out after 500ms.",
      );
      const elapsedMs = Date.now() - startedAt;
      expect(existsSync(readyPath)).toBe(true);
      expect(elapsedMs).toBeGreaterThanOrEqual(600);
      expect(elapsedMs).toBeLessThan(2_000);
    },
  );

  it("preserves stderr when git fails without timing out", () => {
    const tempDir = makeTempDir(tempDirs, "check-docs-i18n-glossary-");
    const binDir = path.join(tempDir, "bin");
    mkdirSync(binDir);
    writeGitFixture(
      binDir,
      'if (process.argv[2] === "diff") { console.error("fatal: invalid revision"); process.exit(128); }\nprocess.exit(0);\n',
    );

    const result = spawnSync(process.execPath, [scriptPath, "--base", "missing-ref"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: binDir,
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "docs:check-i18n-glossary: git diff --name-only --diff-filter=ACMR missing-ref -- docs failed: fatal: invalid revision",
    );
  });
});
