import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireGit } from "../agents/worktrees/git.js";
import {
  gitHubBranchPresence,
  resolveRecordedPublicationBaseBranch,
} from "./github-publication-recorded-base.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);
const git = (cwd: string, ...args: string[]) => requireGit(cwd, args);
const identity = ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid"];

async function repository() {
  const root = temporary.make("publication-recorded-base-");
  await git(root, "init", "--quiet", "-b", "main");
  await git(
    root,
    ...identity,
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

const resolve = (cwd: string, baseRef: string, remote: boolean | undefined) => {
  const remoteBranchExists = vi.fn(async () => remote);
  return {
    remoteBranchExists,
    branch: resolveRecordedPublicationBaseBranch({
      cwd,
      baseRef,
      defaultBranch: "trunk",
      remoteBranchExists,
    }),
  };
};

describe("resolveRecordedPublicationBaseBranch", () => {
  it("targets the default branch for an abbreviated commit base absent from GitHub", async () => {
    const { root, head } = await repository();

    for (const baseRef of [head.slice(0, 11), head.slice(0, 11).toUpperCase()]) {
      await expect(resolve(root, baseRef, false).branch).resolves.toBe("trunk");
    }
  });

  it("targets the default branch for a full commit base without asking GitHub", async () => {
    const { root, head } = await repository();
    const result = resolve(root, head, true);

    await expect(result.branch).resolves.toBe("trunk");
    expect(result.remoteBranchExists).not.toHaveBeenCalled();
  });

  it("keeps a commit-like name that GitHub has, or can't confirm missing, as a branch", async () => {
    const { root, head } = await repository();
    const short = head.slice(0, 11);

    const present = resolve(root, short, true);
    await expect(present.branch).resolves.toBe(short);
    expect(present.remoteBranchExists).toHaveBeenCalledWith(short);
    await expect(resolve(root, short, undefined).branch).resolves.toBe(short);
  });

  it("keeps branch bases without asking GitHub", async () => {
    const { root } = await repository();
    await git(root, "branch", "cafe1234");

    for (const [baseRef, expected] of [
      ["main", "main"],
      ["origin/main", "main"],
      ["cafe1234", "cafe1234"],
      // Hex text that names no commit stays a branch name for GitHub to verify.
      ["0000000", "0000000"],
    ]) {
      const result = resolve(root, baseRef!, false);
      await expect(result.branch).resolves.toBe(expected);
      expect(result.remoteBranchExists).not.toHaveBeenCalled();
    }
  });
});

describe("gitHubBranchPresence", () => {
  // A stand-in `gh` that answers the ref read the way the real CLI does.
  const presence = (script: string) => {
    const bin = temporary.make("publication-recorded-base-gh-");
    fs.writeFileSync(path.join(bin, "gh"), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    return gitHubBranchPresence({
      repository: "openclaw/openclaw",
      host: "github.com",
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` },
    });
  };

  it("reports a branch GitHub returns", async () => {
    await expect(presence("echo refs/heads/cafe1234")("cafe1234")).resolves.toBe(true);
  });

  it("reports a branch missing only when GitHub answers HTTP 404", async () => {
    await expect(presence('echo "gh: Not Found (HTTP 404)" >&2; exit 1')("cafe1234")).resolves.toBe(
      false,
    );
    await expect(
      presence('echo "gh: Not Found (HTTP 503)" >&2; exit 1')("cafe1234"),
    ).resolves.toBeUndefined();
    await expect(
      presence('echo "error connecting to api.github.com" >&2; exit 1')("cafe1234"),
    ).resolves.toBeUndefined();
  });
});
