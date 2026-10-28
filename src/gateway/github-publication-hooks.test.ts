import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, expect, it, onTestFinished, vi } from "vitest";
import * as exec from "../process/exec.js";
import { runCommandBuffered } from "../process/exec.js";
import {
  assertSafeGitPublicationWorkspace as assertSafeWorkspace,
  captureGitHubPublicationWorkspaceSnapshot as captureSnapshot,
} from "./github-publication-git-transport.js";

let root: string;
const commit = expect.stringMatching(/^[a-f0-9]{40}$/u);

const write = (name: string, contents: string, mode?: number) =>
  fs.writeFile(path.join(root, name), contents, { mode });
const runGit = (argv: string[], options: Parameters<typeof runCommandBuffered>[1] = {}) =>
  runCommandBuffered(argv, {
    cwd: root,
    timeoutMs: 10_000,
    maxOutputBytes: 64 * 1024,
    ...options,
  });

async function git(...args: string[]): Promise<string> {
  const { code, stdout, stderr } = await runGit(["git", ...args]);
  expect(code, stderr.toString("utf8")).toBe(0);
  return stdout.toString("utf8").trim();
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
  await write("global-config", '[core]\nfsmonitor = "./monitor"\n');
  await write("monitor", `#!/bin/sh\nprintf monitor > '${sentinel}'\n`, 0o755);
  vi.stubEnv("GIT_CONFIG_GLOBAL", path.join(root, "global-config"));
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  await write("artifact.txt", "accepted\n");

  await expect(assertSafeWorkspace(root, runGit)).resolves.toBeUndefined();
  await expect(captureSnapshot({ cwd: root })).resolves.toMatchObject({
    sourceHeadCommit: commit,
    sourceIndexTree: commit,
    workspaceTree: commit,
  });
  await expect(fs.access(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
});

it("captures a large tree without buffering unrelated paths for its attribute check", async () => {
  // 600 ~540-byte entries exceed the default 256KB `ls-tree -r` output cap.
  const directory = "a".repeat(240);
  const filename = "b".repeat(240);
  await fs.mkdir(path.join(root, directory));
  for (let batch = 0; batch < 12; batch += 1) {
    await Promise.all(
      Array.from({ length: 50 }, (_, file) =>
        write(`${directory}/${filename}-${batch}-${file}`, "x\n"),
      ),
    );
  }
  await git("add", "-A");
  await git("commit", "-q", "-m", "large tree");

  await write(".gitattributes", "*.txt text\n");
  await write(`${directory}/.GITATTRIBUTES`, "*.txt -text\n");
  const transport = vi.spyOn(exec, "runCommandBuffered");
  onTestFinished(() => transport.mockRestore());
  await expect(captureSnapshot({ cwd: root })).resolves.toMatchObject({
    workspaceTree: commit,
  });
  let inventoryBytes = 0;
  for (let index = 0; index < transport.mock.calls.length; index++) {
    if (transport.mock.calls[index]![0].some((arg) => arg === "ls-tree" || arg === "ls-files")) {
      inventoryBytes += (await transport.mock.results[index]!.value).stdout.length;
    }
  }
  expect(inventoryBytes).toBeGreaterThan(0);
  expect(inventoryBytes).toBeLessThan(1024);
});

it.each([".gitattributes", "nested/.GITATTRIBUTES"])(
  "checks newly staged attributes from the private snapshot index: %s",
  async (file) => {
    vi.stubEnv("GIT_LITERAL_PATHSPECS", "1");
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await write(file, "*.txt text\n");
    await git("add", file);
    await captureSnapshot({ cwd: root });
    await write(file, "*.txt filter=blocked\n");
    await expect(captureSnapshot({ cwd: root })).rejects.toThrow("unsupported Git clean filter");
    expect(await git("show", `:${file}`)).toBe("*.txt text");
  },
);

it.each(["replace refs", "grafts"])("rejects Git replacement metadata from %s", async (kind) => {
  const head = await git("rev-parse", "HEAD");
  if (kind === "replace refs") {
    await git("update-ref", `refs/replace/${head}`, head);
  } else {
    await write(".git/info/grafts", `${head}\n`);
  }

  await expect(assertSafeWorkspace(root, runGit)).rejects.toThrow("replacement metadata");
});
