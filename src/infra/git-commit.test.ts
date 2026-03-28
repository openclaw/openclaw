import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resetCommitHashCacheForTests, resolveCommitHash } from "./git-commit.js";

function createFakeRepo(root: string, hash: string): void {
  const gitDir = path.join(root, ".git");
  const refsDir = path.join(gitDir, "refs", "heads");
  fs.mkdirSync(refsDir, { recursive: true });
  fs.writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(refsDir, "main"), `${hash}\n`);
}

describe("resolveCommitHash", () => {
  afterEach(() => {
    resetCommitHashCacheForTests();
  });

  it("does not cache env-provided commit across calls with different env values", () => {
    expect(
      resolveCommitHash({ env: { GIT_COMMIT: "aaaaaaaaaaaaaaaa" } as NodeJS.ProcessEnv }),
    ).toBe("aaaaaaa");
    expect(
      resolveCommitHash({ env: { GIT_COMMIT: "bbbbbbbbbbbbbbbb" } as NodeJS.ProcessEnv }),
    ).toBe("bbbbbbb");
    expect(resolveCommitHash({ env: { GIT_SHA: "cccccccccccccccc" } as NodeJS.ProcessEnv })).toBe(
      "ccccccc",
    );
  });

  it("resolves per-cwd git HEAD and reflects ref updates", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-git-commit-"));
    const repoA = path.join(base, "repo-a");
    const repoB = path.join(base, "repo-b");
    fs.mkdirSync(repoA, { recursive: true });
    fs.mkdirSync(repoB, { recursive: true });
    createFakeRepo(repoA, "1111111111111111111111111111111111111111");
    createFakeRepo(repoB, "2222222222222222222222222222222222222222");

    expect(resolveCommitHash({ cwd: repoA, env: {} as NodeJS.ProcessEnv })).toBe("1111111");
    expect(resolveCommitHash({ cwd: repoB, env: {} as NodeJS.ProcessEnv })).toBe("2222222");

    fs.writeFileSync(
      path.join(repoA, ".git", "refs", "heads", "main"),
      "3333333333333333333333333333333333333333\n",
    );
    expect(resolveCommitHash({ cwd: repoA, env: {} as NodeJS.ProcessEnv })).toBe("3333333");
  });
});
