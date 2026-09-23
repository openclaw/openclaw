import * as childProcess from "node:child_process";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import * as os from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { vi } from "vitest";
import { requireGit } from "../../agents/worktrees/git.js";
import {
  createWorkerProjectPreparation,
  readWorkerProjectSetupRecipe,
} from "./project-preparation.js";
import { prepareWorkerProjectSnapshot, workerProjectSeedKey } from "./workspace-git-base.js";

const requireModule = createRequire(import.meta.url);

/** Execute the provider's generated script against real fixtures with a controlled Git result. */
export async function runProjectScriptWithGitProbe(
  script: string,
  home: string,
  probe: (
    args: string[],
    options: childProcess.SpawnSyncOptionsWithStringEncoding,
  ) => childProcess.SpawnSyncReturns<string> | undefined,
): Promise<string> {
  let stdout = "";
  let stderr = "";
  const guestProcess = {
    env: { PATH: process.env.PATH, HOME: home },
    execPath: process.execPath,
    umask: () => {},
    exitCode: 0,
    stdout: { write: (text: string) => (stdout += text) },
  };
  // Both provider scripts wrap their Node program in a shell heredoc.
  await runInNewContext(script.split("\n").slice(2, -1).join("\n"), {
    Buffer,
    performance,
    process: guestProcess,
    console: { error: (text: string) => (stderr += text) },
    require: (id: string) => {
      if (id === "node:os") {
        return { ...os, homedir: () => home };
      }
      if (id === "node:child_process") {
        return {
          ...childProcess,
          spawnSync: (
            command: string,
            args: string[],
            options: childProcess.SpawnSyncOptionsWithStringEncoding,
          ) =>
            (command === "git" ? probe(args, options) : undefined) ??
            childProcess.spawnSync(command, args, options),
        };
      }
      return requireModule(id);
    },
  });
  if (guestProcess.exitCode !== 0) {
    throw new Error(stderr);
  }
  return stdout;
}

export async function createProjectPreparationFixture(
  directory: string,
  setup?: string,
  symlink = false,
) {
  const root = await fs.realpath(directory);
  const repository = path.join(root, "repository");
  const home = path.join(root, "worker-home");
  await fs.mkdir(repository);
  await fs.mkdir(home);
  await requireGit(repository, ["init", "--quiet"]);
  await requireGit(repository, ["config", "user.name", "Project Test"]);
  await requireGit(repository, ["config", "user.email", "project@example.invalid"]);
  await requireGit(repository, ["config", "commit.gpgsign", "false"]);
  await fs.writeFile(path.join(repository, "input.txt"), "prepared base\n");
  if (symlink) {
    await fs.symlink("input.txt", path.join(repository, "linked-input"));
  }
  if (setup) {
    await fs.mkdir(path.join(repository, ".openclaw"));
    await fs.writeFile(path.join(repository, ".openclaw", "worktree-setup.sh"), setup, {
      mode: 0o755,
    });
    await fs.writeFile(path.join(repository, ".gitignore"), "build/\n");
  }
  await requireGit(repository, ["add", "."]);
  await requireGit(repository, ["commit", "--quiet", "-m", "base"]);
  const project = (await prepareWorkerProjectSnapshot({
    localPath: repository,
    namespace: "gateway",
  }))!;
  const runScript = vi.fn(async (script: string) =>
    execFileSync("sh", ["-c", script], {
      env: { ...process.env, HOME: home, PREPARATION_UNRELATED_ENV: "must-not-forward" },
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  const upload = vi.fn(async (source: string, destination: string) => {
    uploadBytes.push((await fs.stat(source)).size);
    await fs.copyFile(source, destination);
  });
  const uploadBytes: number[] = [];
  const operation = (requireCurrent = () => {}) =>
    createWorkerProjectPreparation({ project, namespace: "gateway", requireCurrent });
  const seed = path.join(
    home,
    ".openclaw-worker",
    "git-seeds",
    "gateway",
    workerProjectSeedKey(project),
  );
  const preparedOperation = async (
    requireCurrent = () => {},
    options: { project?: typeof project; key?: string; cacheKey?: string } = {},
  ) => {
    const snapshot = options.project ?? project;
    return createWorkerProjectPreparation({
      project: snapshot,
      namespace: "gateway",
      preparation: {
        purpose: "session",
        demandAtMs: 1_000,
        key: options.key ?? "a".repeat(64),
        cacheKey: options.cacheKey ?? "c".repeat(64),
        setupRecipe: await readWorkerProjectSetupRecipe(snapshot),
      },
      setupAuthorized: true,
      requireCurrent,
    });
  };
  return {
    repository,
    home,
    project,
    seed,
    operation,
    preparedOperation,
    runScript,
    runScriptWithBudget(createScript: (timeoutMs: number) => string) {
      return this.runScript(createScript(30_000));
    },
    upload,
    uploadBytes,
  };
}
