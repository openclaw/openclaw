import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { runCommandWithTimeout } from "../process/exec.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { acquireGitSource } from "./git-source.js";

type SourceOptions = Omit<Parameters<typeof acquireGitSource>[0], "repoDir" | "url" | "label">;
const gitConfig = [
  "user.name=Test",
  "user.email=test@openclaw.invalid",
  "commit.gpgsign=false",
].flatMap((value) => ["-c", value]);
async function git(cwd: string, ...args: string[]): Promise<string> {
  const argv = ["git", ...gitConfig, ...args];
  const result = await runCommandWithTimeout(argv, { cwd, timeoutMs: 30_000 });
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout);
  }
  return result.stdout.trim();
}

it("preserves each caller's ref selection against a local repository", async () => {
  await withTestDir({ prefix: "openclaw-git-source-" }, async (root) => {
    const sourceDir = path.join(root, "source");
    await fs.mkdir(sourceDir);
    await git(sourceDir, "init", "--initial-branch=main");
    const commit = async (contents: string) => {
      await fs.writeFile(path.join(sourceDir, "payload.txt"), contents);
      await git(sourceDir, "add", "payload.txt");
      await git(sourceDir, "commit", "-m", contents);
      return await git(sourceDir, "rev-parse", "HEAD");
    };
    const mainCommit = await commit("main");
    await git(sourceDir, "switch", "-c", "feature/skill");
    const featureCommit = await commit("feature");
    await git(sourceDir, "tag", "v1");
    await git(sourceDir, "switch", "main");

    const source = { url: pathToFileURL(sourceDir).href, label: "fixture" };
    const acquire = (repoDir: string, options: SourceOptions) =>
      acquireGitSource({ ...source, repoDir, ...options });
    const cases = [
      [undefined, "detached"],
      ["feature/skill", "resolve-remote"],
      ["origin/feature/skill", "resolve-remote"],
      ["feature/skill", "shallow-branch"],
      ["v1", "shallow-branch"],
      [featureCommit, "detached"],
    ] as const;
    for (const [index, [ref, refMode]] of cases.entries()) {
      const repoDir = path.join(root, `checkout-${index}`);
      const result = await acquire(repoDir, { ref, refMode });
      expect(result).toEqual({ ok: true, commit: ref ? featureCommit : mainCommit });
      expect(await fs.readFile(path.join(repoDir, "payload.txt"), "utf8")).toBe(
        ref ? "feature" : "main",
      );
    }

    const repoDir = path.join(root, "missing-ref");
    const failed = await acquire(repoDir, {
      ref: "missing",
      refMode: "resolve-remote",
      cleanupOnFailure: () => fs.rm(repoDir, { recursive: true, force: true }),
    });
    expect(failed).toEqual({ ok: false, error: "failed to resolve ref missing in fixture" });
    await expect(fs.access(repoDir)).rejects.toMatchObject({ code: "ENOENT" });

    const unsafeRef = "https://fixture-user:fixture-password@example.invalid/missing\u001b[31m";
    const checkoutFailure = await acquire(path.join(root, "unsafe-ref"), {
      ref: unsafeRef,
      refMode: "detached",
    });
    expect(checkoutFailure.ok).toBe(false);
    if (!checkoutFailure.ok) {
      expect(checkoutFailure.error).toContain("failed to checkout https://***:***@");
      for (const secret of ["fixture-user", "fixture-password", "\u001b"]) {
        expect(checkoutFailure.error).not.toContain(secret);
      }
    }
    expect(await fs.readFile(path.join(sourceDir, "payload.txt"), "utf8")).toBe("main");
  });
});
