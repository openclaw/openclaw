// Covers git root and HEAD path discovery.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { findGitRoot, readGitHead } from "./git-root.js";

async function expectGitRootResolution(params: {
  label: string;
  setup: (
    temp: string,
  ) => Promise<{ startPath: string; expectedRoot: string | null; expectedHead: string | null }>;
}): Promise<void> {
  await withTestDir({ prefix: `openclaw-${params.label}-` }, async (temp) => {
    const { startPath, expectedRoot, expectedHead } = await params.setup(temp);
    if (expectedHead) {
      await fs.writeFile(expectedHead, `${"a".repeat(40)}\n`);
    }
    // Include the fixture root, but never inspect host-owned ancestors above it.
    const maxDepth = path.relative(temp, startPath).split(path.sep).filter(Boolean).length + 1;
    expect(findGitRoot(startPath, { maxDepth })).toBe(expectedRoot);
    expect(readGitHead(startPath, { maxDepth })?.headPath ?? null).toBe(expectedHead);
  });
}

describe("git-root", () => {
  it.each([
    {
      name: "starting at the repo root itself",
      label: "git-root-self",
      setup: async (temp: string) => {
        const repoRoot = path.join(temp, "repo");
        await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
        return {
          startPath: repoRoot,
          expectedRoot: repoRoot,
          expectedHead: path.join(repoRoot, ".git", "HEAD"),
        };
      },
    },
    {
      name: ".git is a directory",
      label: "git-root-dir",
      setup: async (temp: string) => {
        const repoRoot = path.join(temp, "repo");
        const workspace = path.join(repoRoot, "nested", "workspace");
        await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
        await fs.mkdir(workspace, { recursive: true });
        return {
          startPath: workspace,
          expectedRoot: repoRoot,
          expectedHead: path.join(repoRoot, ".git", "HEAD"),
        };
      },
    },
    {
      name: ".git is a gitdir pointer file",
      label: "git-root-file",
      setup: async (temp: string) => {
        const repoRoot = path.join(temp, "repo");
        const workspace = path.join(repoRoot, "nested", "workspace");
        const gitDir = path.join(repoRoot, ".actual-git");
        await fs.mkdir(workspace, { recursive: true });
        await fs.mkdir(gitDir, { recursive: true });
        await fs.writeFile(path.join(repoRoot, ".git"), "gitdir: .actual-git\n", "utf-8");
        return {
          startPath: workspace,
          expectedRoot: repoRoot,
          expectedHead: path.join(gitDir, "HEAD"),
        };
      },
    },
    {
      name: "invalid gitdir content still keeps root detection",
      label: "git-root-invalid-file",
      setup: async (temp: string) => {
        const parentRoot = path.join(temp, "repo");
        const childRoot = path.join(parentRoot, "child");
        const nested = path.join(childRoot, "nested");
        await fs.mkdir(path.join(parentRoot, ".git"), { recursive: true });
        await fs.mkdir(nested, { recursive: true });
        await fs.writeFile(path.join(childRoot, ".git"), "not-a-gitdir-pointer\n", "utf-8");
        return {
          startPath: nested,
          expectedRoot: childRoot,
          expectedHead: path.join(parentRoot, ".git", "HEAD"),
        };
      },
    },
    {
      name: "invalid gitdir content without a parent repo",
      label: "git-root-invalid-only",
      setup: async (temp: string) => {
        const repoRoot = path.join(temp, "repo");
        const nested = path.join(repoRoot, "nested");
        await fs.mkdir(nested, { recursive: true });
        await fs.writeFile(path.join(repoRoot, ".git"), "not-a-gitdir-pointer\n", "utf-8");
        return {
          startPath: nested,
          expectedRoot: repoRoot,
          expectedHead: null,
        };
      },
    },
  ])("resolves git roots when $name", async ({ label, setup }) => {
    await expectGitRootResolution({ label, setup });
  });

  it("respects maxDepth traversal limit", async () => {
    await withTestDir({ prefix: "openclaw-git-root-depth-" }, async (temp) => {
      const repoRoot = path.join(temp, "repo");
      const nested = path.join(repoRoot, "a", "b", "c");
      await fs.mkdir(path.join(repoRoot, ".git"), { recursive: true });
      await fs.mkdir(nested, { recursive: true });

      expect(findGitRoot(nested, { maxDepth: 2 })).toBeNull();
      expect(readGitHead(nested, { maxDepth: 2 })).toBeUndefined();
    });
  });

  it("bounds the HEAD read instead of slurping an oversized file", async () => {
    await withTestDir({ prefix: "openclaw-git-root-head-bound-" }, async (temp) => {
      const repoRoot = path.join(temp, "repo");
      const gitDir = path.join(repoRoot, ".git");
      await fs.mkdir(gitDir, { recursive: true });

      // HEAD is one `ref:` line, but a corrupted or hostile file can be any size:
      // the reader must not load the whole thing.
      const headPath = path.join(gitDir, "HEAD");
      const oversized = 2 * 1024 * 1024;
      await fs.writeFile(headPath, `ref: refs/heads/trunk\n${"x".repeat(oversized)}\n`, "utf-8");

      const read = readGitHead(repoRoot, { maxDepth: 1 });
      // Trailing bytes beyond the first line never leak into the parsed ref.
      expect(read?.ref).toBe("refs/heads/trunk");
      expect(read?.headPath).toBe(headPath);
      // The file really is far larger than the window that was read.
      expect((await fs.stat(headPath)).size).toBeGreaterThan(oversized);
    });
  });

  it("keeps a long branch name within the bounded HEAD window", async () => {
    await withTestDir({ prefix: "openclaw-git-root-head-long-ref-" }, async (temp) => {
      const repoRoot = path.join(temp, "repo");
      const gitDir = path.join(repoRoot, ".git");
      await fs.mkdir(gitDir, { recursive: true });
      // Git does not length-cap branch names; a segmented name stays resolvable.
      const longRef = `refs/heads/${"segment/".repeat(40)}main`;
      await fs.writeFile(path.join(gitDir, "HEAD"), `ref: ${longRef}\n`, "utf-8");

      const read = readGitHead(repoRoot, { maxDepth: 1 });
      expect(read?.ref).toBe(longRef);
    });
  });

  it("keeps a normal HEAD value intact under the bound", async () => {
    await withTestDir({ prefix: "openclaw-git-root-head-normal-" }, async (temp) => {
      const repoRoot = path.join(temp, "repo");
      const gitDir = path.join(repoRoot, ".git");
      await fs.mkdir(gitDir, { recursive: true });
      const sha = "a".repeat(40);
      await fs.writeFile(path.join(gitDir, "HEAD"), `${sha}\n`, "utf-8");

      const read = readGitHead(repoRoot, { maxDepth: 1 });
      expect(read?.ref).toBeNull();
      expect(read?.value).toBe(sha);
    });
  });
});
