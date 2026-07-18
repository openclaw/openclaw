import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "../../scripts/check-docs-i18n-glossary.mjs";
import { cleanupTempDirs, makeTempDir } from "../helpers/temp-dir.js";

const scriptPath = path.resolve("scripts/check-docs-i18n-glossary.mjs");
const tempDirs: string[] = [];

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
    writeFileSync(
      path.join(binDir, "git"),
      [
        `#!${process.execPath}`,
        'if (process.argv[2] === "diff") { setTimeout(() => {}, 10_000); }',
        "else { process.exit(0); }",
        "",
      ].join("\n"),
      { mode: 0o755 },
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
});
