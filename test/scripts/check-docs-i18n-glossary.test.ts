import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "../../scripts/check-docs-i18n-glossary.mjs";
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

  it("fails with an actionable timeout when git diff hangs", () => {
    const tempDir = makeTempDir(tempDirs, "check-docs-i18n-glossary-");
    const binDir = path.join(tempDir, "bin");
    mkdirSync(binDir);
    writeGitFixture(
      binDir,
      'if (process.argv[2] === "diff") { setTimeout(() => {}, 10_000); }\nelse { process.exit(0); }\n',
    );

    const result = spawnSync(process.execPath, [scriptPath, "--base", "HEAD~1"], {
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCLAW_DOCS_I18N_GLOSSARY_GIT_TIMEOUT_MS: "500",
        PATH: binDir,
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "docs:check-i18n-glossary: git diff --name-only --diff-filter=ACMR HEAD~1 -- docs timed out after 500ms.",
    );
  });

  it("propagates timeout diagnostics when git merge-base hangs", () => {
    const tempDir = makeTempDir(tempDirs, "check-docs-i18n-glossary-");
    const binDir = path.join(tempDir, "bin");
    mkdirSync(binDir);
    writeGitFixture(
      binDir,
      'if (process.argv[2] === "merge-base") { setTimeout(() => {}, 10_000); }\nelse { process.exit(0); }\n',
    );

    const result = spawnSync(process.execPath, [scriptPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCLAW_DOCS_I18N_GLOSSARY_GIT_TIMEOUT_MS: "500",
        PATH: binDir,
      },
      timeout: 5_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "docs:check-i18n-glossary: git merge-base origin/main HEAD timed out after 500ms.",
    );
  });

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
