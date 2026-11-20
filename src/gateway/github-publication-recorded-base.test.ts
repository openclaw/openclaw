import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireGit } from "../agents/worktrees/git.js";
import { resolveRecordedPublicationBaseBranch } from "./github-publication-recorded-base.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);
const git = (cwd: string, ...args: string[]) => requireGit(cwd, args);

async function repository() {
  const root = temporary.make("publication-recorded-base-");
  await git(root, "init", "--quiet", "-b", "main");
  await git(
    root,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgSign=false",
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    "base",
  );
  return { root, head: (await git(root, "rev-parse", "HEAD")).trim() };
}

describe("resolveRecordedPublicationBaseBranch", () => {
  it("targets the default branch for an abbreviated or full commit base", async () => {
    const { root, head } = await repository();

    for (const baseRef of [head.slice(0, 11), head.slice(0, 11).toUpperCase(), head]) {
      await expect(resolveRecordedPublicationBaseBranch(root, baseRef, "trunk")).resolves.toBe(
        "trunk",
      );
    }
  });

  it("keeps branch bases, including hex-looking local and origin branches", async () => {
    const { root } = await repository();
    await git(root, "branch", "cafe1234");
    await git(root, "update-ref", "refs/remotes/origin/beef5678", "HEAD");

    await expect(resolveRecordedPublicationBaseBranch(root, "main", "trunk")).resolves.toBe("main");
    await expect(resolveRecordedPublicationBaseBranch(root, "origin/main", "trunk")).resolves.toBe(
      "main",
    );
    await expect(resolveRecordedPublicationBaseBranch(root, "cafe1234", "trunk")).resolves.toBe(
      "cafe1234",
    );
    await expect(resolveRecordedPublicationBaseBranch(root, "beef5678", "trunk")).resolves.toBe(
      "beef5678",
    );
    // Hex text that names no branch and no commit stays a branch name for GitHub to verify.
    await expect(resolveRecordedPublicationBaseBranch(root, "0000000", "trunk")).resolves.toBe(
      "0000000",
    );
  });
});
