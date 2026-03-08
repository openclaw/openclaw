import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

async function makeTempDir(label: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `openclaw-${label}-`));
}

describe("git commit resolution", () => {
  const originalCwd = process.cwd();

  afterEach(() => {
    process.chdir(originalCwd);
    vi.resetModules();
  });

  it("resolves commit metadata from the caller module root instead of the caller cwd", async () => {
    const repoHead = execFileSync("git", ["rev-parse", "--short=7", "HEAD"], {
      cwd: originalCwd,
      encoding: "utf-8",
    }).trim();

    const temp = await makeTempDir("git-commit-cwd");
    const otherRepo = path.join(temp, "other");
    await fs.mkdir(otherRepo, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: otherRepo });
    await fs.writeFile(path.join(otherRepo, "note.txt"), "x\n", "utf-8");
    execFileSync("git", ["add", "note.txt"], { cwd: otherRepo });
    execFileSync(
      "git",
      ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "init"],
      { cwd: otherRepo },
    );
    const otherHead = execFileSync("git", ["rev-parse", "--short=7", "HEAD"], {
      cwd: otherRepo,
      encoding: "utf-8",
    }).trim();

    process.chdir(otherRepo);
    const { resolveCommitHash } = await import("./git-commit.js");
    const entryModuleUrl = pathToFileURL(path.join(originalCwd, "src", "entry.ts")).href;

    expect(resolveCommitHash({ moduleUrl: entryModuleUrl })).toBe(repoHead);
    expect(resolveCommitHash({ moduleUrl: entryModuleUrl })).not.toBe(otherHead);
  });
});
