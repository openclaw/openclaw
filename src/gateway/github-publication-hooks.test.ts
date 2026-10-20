import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, expect, it, onTestFinished } from "vitest";
import { runCommandBuffered } from "../process/exec.js";
import {
  assertSafeGitPublicationWorkspace,
  captureGitHubPublicationWorkspaceSnapshot,
} from "./github-publication-git-transport.js";

let root: string;

const write = (name: string, contents: string, mode?: number) =>
  fs.writeFile(path.join(root, name), contents, { mode });
const runGit = (argv: string[], options: Parameters<typeof runCommandBuffered>[1] = {}) =>
  runCommandBuffered(argv, {
    cwd: root,
    env: process.env,
    timeoutMs: 10_000,
    maxOutputBytes: 64 * 1024,
    ...options,
  });

async function git(...args: string[]): Promise<string> {
  const result = await runGit(["git", ...args]);
  if (result.code !== 0) {
    throw new Error(result.stderr.toString("utf8"));
  }
  return result.stdout.toString("utf8").trim();
}

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-publication-hooks-")));
  onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
  await git("init", "--initial-branch=main");
  await git("config", "user.name", "OpenClaw Test");
  await git("config", "user.email", "openclaw@example.test");
  await write("artifact.txt", "base\n");
  await git("add", "artifact.txt");
  await git("commit", "-m", "base");
});

it("accepts checkout-configured hooks while snapshot commands keep every hook disabled", async () => {
  const hooks = path.join(root, "git-hooks");
  const sentinel = path.join(root, ".hook-ran");
  await fs.mkdir(hooks);
  for (const hook of ["reference-transaction", "pre-push", "post-index-change"]) {
    await write(path.join("git-hooks", hook), `#!/bin/sh\nprintf hook > '${sentinel}'\n`, 0o755);
  }
  await git("config", "core.hooksPath", "git-hooks");
  await write("artifact.txt", "accepted\n");

  await expect(assertSafeGitPublicationWorkspace(root, runGit)).resolves.toBeUndefined();
  await expect(captureGitHubPublicationWorkspaceSnapshot({ cwd: root })).resolves.toMatchObject({
    sourceHeadCommit: expect.stringMatching(/^[a-f0-9]{40}$/u),
    sourceIndexTree: expect.stringMatching(/^[a-f0-9]{40}$/u),
    workspaceTree: expect.stringMatching(/^[a-f0-9]{40}$/u),
  });
  await expect(fs.access(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
});

it("captures a repository whose recursive tree listing exceeds the default output cap", async () => {
  // 2000 long paths exceed the executor's default 256KB `ls-tree -r` output cap.
  const directory = "a".repeat(120);
  await fs.mkdir(path.join(root, directory));
  for (let batch = 0; batch < 40; batch += 1) {
    await Promise.all(
      Array.from({ length: 50 }, (_, file) => write(`${directory}/${batch}-${file}.txt`, "x\n")),
    );
  }
  await git("add", "-A");
  await git("commit", "-q", "-m", "large tree");

  await expect(captureGitHubPublicationWorkspaceSnapshot({ cwd: root })).resolves.toMatchObject({
    workspaceTree: expect.stringMatching(/^[a-f0-9]{40}$/u),
  });
});

it.each(["replace refs", "grafts"])("rejects Git replacement metadata from %s", async (kind) => {
  const head = await git("rev-parse", "HEAD");
  if (kind === "replace refs") {
    await git("update-ref", `refs/replace/${head}`, head);
  } else {
    await write(".git/info/grafts", `${head}\n`);
  }

  await expect(assertSafeGitPublicationWorkspace(root, runGit)).rejects.toThrow(
    "replacement metadata",
  );
});
