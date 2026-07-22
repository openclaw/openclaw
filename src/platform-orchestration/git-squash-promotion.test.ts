import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BareGitSquashPromotionAdapter } from "./git-squash-promotion.js";

const execFileAsync = promisify(execFile);
const tempDirectories: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return result.stdout.trim();
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("BareGitSquashPromotionAdapter", () => {
  it("atomically creates one squash commit without pushing", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-promotion-test-"));
    tempDirectories.push(root);
    const source = path.join(root, "source");
    const bare = path.join(root, "project.git");
    await fs.mkdir(source);
    await git(source, "init", "-b", "main");
    await git(source, "config", "user.name", "Test");
    await git(source, "config", "user.email", "test@example.invalid");
    await fs.writeFile(path.join(source, "fixture.txt"), "base\n", "utf8");
    await git(source, "add", "fixture.txt");
    await git(source, "commit", "-m", "base");
    const baseCommit = await git(source, "rev-parse", "HEAD");
    await git(root, "clone", "--bare", source, bare);

    await fs.writeFile(path.join(source, "fixture.txt"), "base\nchange\n", "utf8");
    await fs.writeFile(path.join(source, "added.txt"), "added\n", "utf8");
    await git(source, "add", ".");
    await git(source, "commit", "-m", "first execution commit");
    await fs.appendFile(path.join(source, "added.txt"), "second\n", "utf8");
    await git(source, "commit", "-am", "second execution commit");
    const sourceCommit = await git(source, "rev-parse", "HEAD");
    await git(source, "push", bare, `${sourceCommit}:refs/heads/pi-job`);
    vi.stubEnv("GIT_DIR", path.join(root, "ambient-override.git"));
    vi.stubEnv("GIT_OBJECT_DIRECTORY", path.join(root, "ambient-objects"));

    const result = await new BareGitSquashPromotionAdapter().promote({
      promotionId: "pro_018f0000-0000-7000-8000-000000000001",
      repositoryPath: bare,
      targetBranch: "main",
      expectedTargetCommitSha: baseCommit,
      sourceCommitSha: sourceCommit,
      commitMessage: "chore(platform): promote fixture",
      commitTimestamp: "2026-07-18T12:00:00.000Z",
    });
    vi.unstubAllEnvs();

    expect(result).toEqual({
      promotionId: "pro_018f0000-0000-7000-8000-000000000001",
      commitSha: expect.stringMatching(/^[0-9a-f]{40}$/u),
      strategy: "squash",
      pushed: false,
    });
    expect(await git(bare, "rev-parse", `${result.commitSha}^`)).toBe(baseCommit);
    expect(await git(bare, "rev-parse", `${result.commitSha}^{tree}`)).toBe(
      await git(bare, "rev-parse", `${sourceCommit}^{tree}`),
    );
    expect(await git(bare, "rev-list", "--count", "main")).toBe("2");
    await expect(
      new BareGitSquashPromotionAdapter().promote({
        promotionId: result.promotionId,
        repositoryPath: bare,
        targetBranch: "main",
        expectedTargetCommitSha: baseCommit,
        sourceCommitSha: sourceCommit,
        commitMessage: "chore(platform): promote fixture",
        commitTimestamp: "2026-07-18T12:00:00.000Z",
      }),
    ).resolves.toEqual(result);
  });

  it("fails closed when the target revision changed", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-promotion-stale-"));
    tempDirectories.push(root);
    await git(root, "init", "--bare", "project.git");

    await expect(
      new BareGitSquashPromotionAdapter().promote({
        promotionId: "pro_018f0000-0000-7000-8000-000000000001",
        repositoryPath: path.join(root, "project.git"),
        targetBranch: "main",
        expectedTargetCommitSha: "1".repeat(40),
        sourceCommitSha: "2".repeat(40),
        commitMessage: "chore(platform): promote fixture",
        commitTimestamp: "2026-07-18T12:00:00.000Z",
      }),
    ).rejects.toThrow("precondition failed");
  });
});
