import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..");
const entry = path.join(repoRoot, "openclaw.mjs");
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));

function runVersion(flag: string) {
  return spawnSync(process.execPath, [entry, flag], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 5_000,
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });
}

describe("bootstrap --version fast-path", () => {
  it.each(["--version", "-V", "-v"])(
    "short-circuits for bare %s and prints the package version",
    (flag) => {
      const result = runVersion(flag);
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe(packageJson.version);
    },
  );

  it("does not short-circuit when a subcommand precedes --version", () => {
    // With a subcommand, the early exit should NOT fire; the process will
    // continue into entry.ts / Commander (which may fail without a full build,
    // but the key assertion is that it doesn't print the bare version).
    const result = spawnSync(process.execPath, [entry, "status", "--version"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 10_000,
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });
    // If the bootstrap early exit wrongly triggered, stdout would be just the version.
    const stdoutTrimmed = result.stdout.trim();
    expect(stdoutTrimmed).not.toBe(packageJson.version);
  });
});
