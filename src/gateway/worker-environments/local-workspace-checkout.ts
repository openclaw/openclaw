import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withWorktreeGitConfig } from "../../agents/worktrees/checkout-git-config.js";
import { requireGit } from "../../agents/worktrees/git.js";
import { prepareWorkerWorkspaceGitPack } from "./workspace-git-base.js";
import { runWorkspaceInventoryCommandToFile } from "./workspace-sync-inventory.js";

/** Build independent, source-only Git metadata before any guest can write this checkout. */
export async function prepareLocalWorkspaceCheckout(params: {
  source: string;
  destination: string;
  temporaryRoot: string;
  baseCommit: string;
  branch: string;
  signal: AbortSignal;
  assertCurrent: () => void;
}) {
  const { signal, assertCurrent: current, destination: repo } = params;
  const temporary = await fs.mkdtemp(path.join(params.temporaryRoot, "git-"));
  try {
    const pack = await withWorktreeGitConfig(
      params.source,
      true,
      {
        signal,
        beforeRun: current,
      },
      (git) =>
        git.withContentEnvironment((baseEnv) =>
          prepareWorkerWorkspaceGitPack({
            root: params.source,
            baseCommit: params.baseCommit,
            temporaryRoot: temporary,
            signal,
            baseEnv,
          }),
        ),
    );
    current();
    await fs.mkdir(repo, { recursive: true, mode: 0o700 });
    const cleanEnv = {
      PATH: process.env.PATH,
      HOME: temporary,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: os.devNull,
      GIT_CONFIG_SYSTEM: os.devNull,
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_TERMINAL_PROMPT: "0",
    };
    const git = (args: string[], input?: Uint8Array) =>
      requireGit(repo, args, {
        baseEnv: cleanEnv,
        env: cleanEnv,
        input,
        signal,
        beforeRun: current,
      });
    await git([
      "init",
      "--quiet",
      "--template=",
      "--object-format=" + (params.baseCommit.length === 40 ? "sha1" : "sha256"),
    ]);
    current();
    await runWorkspaceInventoryCommandToFile({
      argv: [
        "git",
        "-c",
        "core.hooksPath=" + os.devNull,
        "-c",
        "core.fsmonitor=false",
        "-C",
        repo,
        "index-pack",
        "--stdin",
      ],
      inputPath: pack,
      outputPath: path.join(temporary, "index-pack-result"),
      baseEnv: cleanEnv,
      signal,
      timeoutMs: 300_000,
      maxOutputBytes: 4096,
    });
    current();
    await fs.writeFile(path.join(repo, ".git", "shallow"), params.baseCommit + "\n", {
      mode: 0o600,
    });
    await git(["checkout", "--quiet", "-b", params.branch, params.baseCommit]);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
