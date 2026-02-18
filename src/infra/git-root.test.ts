import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findGitRoot, resolveGitHeadPath } from "./git-root.js";

async function makeTempDir(label: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `openclaw-${label}-`));
}

describe("git-root", () => {
  it("finds git root and HEAD path when .git is a directory", async () => {
    const temp = await makeTempDir("git-root-dir");
    const repoRoot = path.join(temp, "repo");
    const workspace = path.join(repoRoot, "nested", "workspace");
    await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
    await fs.mkdir(workspace, { recursive: true });

    expect(findGitRoot(workspace)).toBe(repoRoot);
    expect(resolveGitHeadPath(workspace)).toBe(path.join(repoRoot, ".git", "HEAD"));
  });

  it("resolves HEAD path when .git is a gitdir pointer file", async () => {
    const temp = await makeTempDir("git-root-file");
    const repoRoot = path.join(temp, "repo");
    const workspace = path.join(repoRoot, "nested", "workspace");
    const gitDir = path.join(repoRoot, ".actual-git");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(gitDir, { recursive: true });
    await fs.writeFile(path.join(repoRoot, ".git"), "gitdir: .actual-git\n", "utf-8");

    expect(findGitRoot(workspace)).toBe(repoRoot);
    expect(resolveGitHeadPath(workspace)).toBe(path.join(gitDir, "HEAD"));
  });

  it("keeps root detection for .git file and skips invalid gitdir content for HEAD lookup", async () => {
    const temp = await makeTempDir("git-root-invalid-file");
    const parentRoot = path.join(temp, "repo");
    const childRoot = path.join(parentRoot, "child");
    const nested = path.join(childRoot, "nested");
    await fs.mkdir(path.join(parentRoot, ".git"), { recursive: true });
    await fs.mkdir(nested, { recursive: true });
    await fs.writeFile(path.join(childRoot, ".git"), "not-a-gitdir-pointer\n", "utf-8");

    expect(findGitRoot(nested)).toBe(childRoot);
    expect(resolveGitHeadPath(nested)).toBe(path.join(parentRoot, ".git", "HEAD"));
  });

  it("respects maxDepth traversal limit", async () => {
    const temp = await makeTempDir("git-root-depth");
    const repoRoot = path.join(temp, "repo");
    const nested = path.join(repoRoot, "a", "b", "c");
    await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
    await fs.mkdir(nested, { recursive: true });

    expect(findGitRoot(nested, { maxDepth: 2 })).toBeNull();
    expect(resolveGitHeadPath(nested, { maxDepth: 2 })).toBeNull();
  });
});
