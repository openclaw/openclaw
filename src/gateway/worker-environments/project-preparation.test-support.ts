import * as cp from "node:child_process";
import { readFileSync, readdirSync, renameSync, unlinkSync } from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import * as os from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { expect, vi } from "vitest";
import { requireGit } from "../../agents/worktrees/git.js";
import {
  createWorkerProjectPreparation,
  readWorkerProjectEnvironmentRecipe,
} from "./project-preparation.js";
import {
  prepareWorkerWorkspaceGitPack,
  prepareWorkerProjectSnapshot,
  workerProjectSeedKey,
} from "./workspace-git-base.js";
import { parseWorkerWorkspaceManifest } from "./workspace-manifest.js";

const requireModule = createRequire(import.meta.url);

/** Execute the provider's generated script against real fixtures with a controlled Git result. */
export async function runProjectScriptWithGitProbe(
  script: string,
  home: string,
  probe: (
    args: string[],
    options: cp.SpawnSyncOptionsWithStringEncoding,
  ) => cp.SpawnSyncReturns<string> | undefined,
  manifestProbe?: typeof probe,
): Promise<string> {
  let stdout = "";
  let stderr = "";
  const guestProcess = {
    env: { PATH: process.env.PATH, HOME: home },
    execPath: process.execPath,
    umask: () => {},
    exitCode: 0,
    stdout: { write: (text: string) => (stdout += text) },
    once: process.once.bind(process),
    removeListener: process.removeListener.bind(process),
    kill: process.kill.bind(process),
  };
  const modules = new Map<string, unknown>([
    ["node:os", { ...os, homedir: () => home }],
    [
      "node:child_process",
      {
        ...cp,
        spawnSync: (command: string, ...args: Parameters<typeof probe>) =>
          (command === "git"
            ? probe(...args)
            : command === process.execPath && args[0][0] === "-e"
              ? manifestProbe?.(...args)
              : undefined) ?? cp.spawnSync(command, ...args),
      },
    ],
  ]);
  // Both provider scripts wrap their Node program in a shell heredoc.
  const source = script.slice(script.indexOf("\n", script.indexOf("node <<'PROJECT_")) + 1);
  await runInNewContext(source.slice(0, source.lastIndexOf("\n")), {
    Buffer,
    URL,
    performance,
    setTimeout,
    clearTimeout,
    process: guestProcess,
    console: { error: (text: string) => (stderr += text) },
    require: (id: string) => modules.get(id) ?? requireModule(id),
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
  files: Record<string, string> = {},
) {
  const root = await fs.realpath(directory);
  const repository = path.join(root, "repository");
  const home = path.join(root, "worker-home");
  const write = async (relative: string, content: string, mode?: number) => {
    const file = path.join(repository, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content, { mode });
  };
  await fs.mkdir(repository);
  await fs.mkdir(home);
  await requireGit(repository, ["init", "--quiet"]);
  await requireGit(repository, ["config", "user.name", "Project Test"]);
  await requireGit(repository, ["config", "user.email", "project@example.invalid"]);
  await requireGit(repository, ["config", "commit.gpgsign", "false"]);
  await write("input.txt", "prepared base\n");
  if (symlink) {
    await fs.symlink("input.txt", path.join(repository, "linked-input"));
  }
  if (setup) {
    await write(".openclaw/worktree-setup.sh", setup, 0o755);
    await write(".gitignore", "build/\n");
  }
  for (const [relative, content] of Object.entries(files)) {
    await write(relative, content);
  }
  await requireGit(repository, ["add", "."]);
  await requireGit(repository, ["commit", "--quiet", "-m", "base"]);
  const project = (await prepareWorkerProjectSnapshot({
    localPath: repository,
    namespace: "gateway",
  }))!;
  const runScript = vi.fn(async (script: string) =>
    cp.execFileSync("sh", ["-c", script], {
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
  const seedKey = workerProjectSeedKey(project);
  const seed = path.join(home, ".openclaw-worker", "git-seeds", "gateway", seedKey);
  const preparedOperation = async (
    requireCurrent = () => {},
    options: { project?: typeof project; key?: string; cacheKey?: string } = {},
  ) => {
    const snapshot = options.project ?? project;
    const recipe = await readWorkerProjectEnvironmentRecipe(snapshot);
    return createWorkerProjectPreparation({
      project: snapshot,
      namespace: "gateway",
      preparation: {
        purpose: "session",
        demandAtMs: 1_000,
        key: options.key ?? "a".repeat(64),
        cacheKey: options.cacheKey ?? "c".repeat(64),
        setupRecipe: recipe.identity,
        recipe,
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

export async function prepareRefreshFixture(
  f: Awaited<ReturnType<typeof createProjectPreparationFixture>>,
  source: "public" | "private" | "unpacked",
) {
  const initial = (await prepareProjectFixture(f)).preparedWorkspace!;
  await requireGit(f.seed, ["remote", "add", "origin", "https://github.com/fixture/project.git"]);
  const originalPacks = new Set(
    await fs.readdir(path.join(initial.workspaceDir, ".git/objects/pack")),
  );
  await fs.writeFile(path.join(f.repository, "input.txt"), "refreshed\n");
  await requireGit(f.repository, ["commit", "--quiet", "-am", "refresh"]);
  const local = await snapshot(f.repository);
  const seed = path.join(path.dirname(f.seed), workerProjectSeedKey(local));
  let runs = 0;
  let budgets = 0;
  let workspaceFetches = 0;
  const reportedPhases: Record<string, number> = {};
  const runScript = async (script: string) => {
    runs++;
    const output = await runProjectScriptWithGitProbe(script, f.home, (args, options) => {
      if (args.includes("fetch") && args.includes(initial.workspaceDir)) {
        workspaceFetches++;
      }
      const url = args.indexOf("https://github.com/fixture/project.git");
      if (url !== -1 && args.includes("fetch")) {
        const redirected = [...args];
        redirected[url] = f.repository;
        return cp.spawnSync("git", ["-c", "protocol.file.allow=always", ...redirected], options);
      }
      if (source === "unpacked" && args[1] === seed && args[2] === "status") {
        const packRoot = path.join(seed, ".git/objects/pack");
        for (const file of readdirSync(packRoot).filter((name) => name.endsWith(".pack"))) {
          const pack = path.join(packRoot, file);
          const bytes = readFileSync(pack);
          renameSync(pack, `${pack}.saved`);
          cp.execFileSync("git", ["-C", seed, "unpack-objects"], { input: bytes });
          unlinkSync(`${pack}.saved`);
          unlinkSync(pack.replace(/\.pack$/u, ".idx"));
        }
      }
      return undefined;
    });
    const report: { phaseDurationsMs: Record<string, number> } = JSON.parse(output);
    for (const [phase, duration] of Object.entries(report.phaseDurationsMs)) {
      reportedPhases[phase] = (reportedPhases[phase] ?? 0) + duration;
    }
    return output;
  };
  const recipe = await readWorkerProjectEnvironmentRecipe(local);
  const operation = createWorkerProjectPreparation({
    project: {
      key: local.key,
      baseCommit: local.baseCommit,
      source: {
        kind: "repository",
        url: "https://github.com/fixture/project.git",
        repositoryId: "fixture",
        owner: { agent: { agentId: "main", provenance: null }, identity: { source: "anonymous" } },
      },
    },
    namespace: "gateway",
    preparation: {
      key: "b".repeat(64),
      cacheKey: "c".repeat(64),
      purpose: "session",
      demandAtMs: 1,
      setupRecipe: recipe.identity,
      recipe,
    },
    setupAuthorized: true,
    requireCurrent: () => {},
    revalidateRepositorySource: async () => {},
    ...(source !== "public"
      ? {
          prepareRepositoryGitPack: (input) =>
            prepareWorkerWorkspaceGitPack({
              ...input,
              root: f.repository,
              baseCommit: local.baseCommit,
            }),
        }
      : {}),
  });
  try {
    const result = await operation.project.prepare({
      runScript,
      runScriptWithBudget: (createScript) => {
        budgets++;
        return runScript(createScript(30_000));
      },
      upload: f.upload,
    });
    return {
      initial,
      result,
      runs,
      budgets,
      workspaceFetches,
      seed,
      originalPacks,
      reportedPhases,
    };
  } finally {
    operation.close();
  }
}

export function expectSetupProcessStopped(pid: number) {
  expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
  const result = cp.spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
  expect(result.error).toBeUndefined();
  expect([0, 1]).toContain(result.status);
  const state = result.stdout.trim();
  expect(state === "" || state.startsWith("Z")).toBe(true);
}

export const preparedPath = (home: string, ...parts: string[]) =>
  path.join(home, ".openclaw-worker", "prepared", "gateway", "c".repeat(64), ...parts);
export const snapshot = async (localPath: string) =>
  (await prepareWorkerProjectSnapshot({ localPath, namespace: "gateway" }))!;
export const manifestFiles = async (home: string) =>
  (await fs.readdir(path.join(home, ".openclaw-worker", "manifests"))).filter((file) =>
    file.endsWith(".json"),
  );
export const readManifest = async (home: string, ref: string) =>
  parseWorkerWorkspaceManifest(
    await fs.readFile(
      path.join(home, ".openclaw-worker", "manifests", `${ref.slice(7)}.json`),
      "utf8",
    ),
    ref,
  );

export async function prepareProjectFixture(
  f: Awaited<ReturnType<typeof createProjectPreparationFixture>>,
  options?: Parameters<typeof f.preparedOperation>[1],
) {
  const operation = await f.preparedOperation(undefined, options);
  try {
    return await operation.project.prepare(f);
  } finally {
    operation.close();
  }
}
