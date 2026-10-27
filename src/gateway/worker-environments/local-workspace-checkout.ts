import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SandboxConfig } from "../../agents/sandbox/types.js";
import type { WorktreeAllocationGuard } from "../../agents/worktrees/allocation.js";
import { withWorktreeGitConfig } from "../../agents/worktrees/checkout-git-config.js";
import { requireGit } from "../../agents/worktrees/git.js";
import { timeWorktreePreparationPhase } from "../../agents/worktrees/preparation-timing.js";
import type { LocalWorkspaceOwner } from "./local-workspace-types.js";
import { prepareWorkerWorkspaceGitPack } from "./workspace-git-base.js";
import { captureWorkspaceManifestDocument } from "./workspace-manifest-worker.js";
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

export async function assertLocalWorkspaceDirectory(directory: string) {
  const stat = await fs.lstat(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (await fs.realpath(directory)) !== directory
  ) {
    throw new Error("Local sandbox workspace directory changed; preserved for recovery");
  }
}

/** Only an unpublished projection reservation may replace an interrupted initial checkout. */
export async function initializeLocalWorkspaceProjection(params: {
  owner: LocalWorkspaceOwner;
  projectionPath: string;
  baseCommit: string;
  signal: AbortSignal;
  assertCurrent: () => void;
  buildCacheInputs: () => Promise<string[]>;
  dependencies?: { sandbox: SandboxConfig; allocation: WorktreeAllocationGuard };
}) {
  const { signal, assertCurrent: current, dependencies } = params;
  const parent = path.dirname(params.projectionPath);
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  await assertLocalWorkspaceDirectory(parent);
  current();
  // No runtime can use an uncommitted initial projection. Only this durable
  // reservation owns interrupted preparation; never recreate a ready checkout.
  await fs.rm(params.projectionPath, { recursive: true, force: true });
  const temporary = await fs.mkdtemp(path.join(parent, ".prepare-"));
  try {
    const repo = path.join(temporary, "workspace");
    const checkout = {
      source: params.owner.worktree.path,
      destination: repo,
      temporaryRoot: temporary,
      baseCommit: params.baseCommit,
      branch: params.owner.worktree.branch,
      signal,
      assertCurrent: current,
    };
    const cloned =
      dependencies &&
      (await (
        await import("./local-workspace-template.js")
      ).cloneLocalWorkspaceTemplate({
        ...checkout,
        repoRoot: params.owner.worktree.repoRoot,
        templateRoot: path.dirname(parent),
        env: params.owner.env ?? process.env,
        sandbox: dependencies.sandbox,
        guard: {
          ...dependencies.allocation,
          signal: dependencies.allocation.signal
            ? AbortSignal.any([signal, dependencies.allocation.signal])
            : signal,
          commitGuard: () => {
            dependencies.allocation.commitGuard();
            current();
          },
        },
      }));
    if (!cloned) {
      await timeWorktreePreparationPhase("checkout", () => prepareLocalWorkspaceCheckout(checkout));
    }
    const initial = await timeWorktreePreparationPhase("snapshot", async () =>
      captureWorkspaceManifestDocument({
        root: repo,
        baseCommit: params.baseCommit,
        buildCacheInputs: new Set(await params.buildCacheInputs()),
        signal,
      }),
    );
    current();
    await fs.rename(repo, params.projectionPath);
    return initial;
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
