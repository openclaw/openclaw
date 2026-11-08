import { realpathSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { SandboxConfig } from "../../agents/sandbox/types.js";
import type { WorktreeAllocationGuard } from "../../agents/worktrees/allocation.js";
import { withWorktreeGitConfig } from "../../agents/worktrees/checkout-git-config.js";
import { commandError, gitEnvironment, requireGit, runGit } from "../../agents/worktrees/git.js";
import { timeWorktreePreparationPhase } from "../../agents/worktrees/preparation-timing.js";
import { resolveStateDir } from "../../config/state-dir.js";
import { observeDiagnosticsTimelinePhases } from "../../infra/diagnostics-timeline.js";
import { gitNullConfigPath, quoteGitConfig } from "../../infra/git-exec.js";
import { parseGitHubRemoteUrl } from "../github-remote.js";
import type { LocalWorkspaceOwner } from "./local-workspace-types.js";
import { prepareWorkerWorkspaceGitPack } from "./workspace-git-base.js";
import { captureWorkspaceManifestDocument } from "./workspace-manifest-worker.js";
import { runWorkspaceInventoryCommandToFile } from "./workspace-sync-inventory.js";

const RECONCILE_PHASE = "attempt.setup.sandbox.workspace_selection.prepare.reconcile";

async function configureProjectionFetch(params: {
  source: string;
  destination: string;
  signal: AbortSignal;
  assertCurrent: () => void;
}) {
  const origin = await runGit(params.source, ["config", "--get", "remote.origin.url"], {
    signal: params.signal,
    beforeRun: params.assertCurrent,
  });
  if (origin.code !== 0 && origin.code !== 1) {
    throw commandError("git config remote.origin.url", origin);
  }
  const repository = parseGitHubRemoteUrl(origin.stdout);
  if (!repository) {
    return;
  }
  // Reconstruct the address: never export host credentials, helpers or local paths.
  const url = `https://github.com/${repository.owner}/${repository.repo}`;
  // A cached template may already have an origin; multiple URLs make push fan out.
  await requireGit(
    params.destination,
    ["config", "--local", "--replace-all", "remote.origin.url", `${url}.git`],
    {
      signal: params.signal,
      beforeRun: params.assertCurrent,
    },
  );
  // Git keys filters by the supplied remote name, even when that name is a URL.
  const config = ["origin", url, `${url}.git`]
    .map(
      (remote) =>
        `\n[remote ${quoteGitConfig(remote)}]\npromisor=true\npartialclonefilter=blob:none\n`,
    )
    .join("");
  params.assertCurrent();
  await fs.appendFile(path.join(params.destination, ".git", "config"), config);
}

export function localWorkspaceProjectionPath(owner: Pick<LocalWorkspaceOwner, "worktree" | "env">) {
  if (!/^[a-f0-9-]{36}$/u.test(owner.worktree.id)) {
    throw new Error("Invalid managed worktree identity");
  }
  return path.join(
    realpathSync(resolveStateDir(owner.env)),
    "worktree-projections",
    owner.worktree.id,
    "workspace",
  );
}

/** Build or refresh private source-only metadata before any guest can write this checkout. */
export async function prepareLocalWorkspaceCheckout(params: {
  source: string;
  destination: string;
  temporaryRoot: string;
  baseCommit: string;
  /** The exclusive template owner has validated this existing checkout. */
  retainedCommit?: string;
  branch: string;
  signal: AbortSignal;
  assertCurrent: () => void;
}) {
  using phases = observeDiagnosticsTimelinePhases(`${RECONCILE_PHASE}.checkout.pack`);
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
            retainedCommit: params.retainedCommit,
            temporaryRoot: temporary,
            signal,
            baseEnv,
          }),
        ),
    );
    current();
    phases.mark(`${RECONCILE_PHASE}.checkout.index`);
    await fs.mkdir(repo, { recursive: true, mode: 0o700 });
    const cleanEnv = {
      PATH: process.env.PATH,
      HOME: temporary,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: gitNullConfigPath(),
      GIT_CONFIG_SYSTEM: gitNullConfigPath(),
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
    if (!params.retainedCommit) {
      await git([
        "init",
        "--quiet",
        "--template=",
        "--object-format=" + (params.baseCommit.length === 40 ? "sha1" : "sha256"),
      ]);
    }
    current();
    await runWorkspaceInventoryCommandToFile({
      argv: ["git", "-C", repo, "index-pack", "--stdin", "--fix-thin"],
      inputPath: pack,
      outputPath: path.join(temporary, "index-pack-result"),
      baseEnv: gitEnvironment(cleanEnv),
      signal,
      timeoutMs: 300_000,
      maxOutputBytes: 4096,
    });
    current();
    phases.mark(`${RECONCILE_PHASE}.checkout.materialize`);
    // Earlier snapshot commits remain in objects/reflogs and still lack their ancestors.
    await fs.appendFile(path.join(repo, ".git", "shallow"), params.baseCommit + "\n", {
      mode: 0o600,
    });
    await git([
      "checkout",
      "--quiet",
      params.retainedCommit ? "-B" : "-b",
      params.branch,
      params.baseCommit,
    ]);
    if (params.retainedCommit) {
      // A session may receive only this commit's source, including through Git objects.
      // Template metadata is host-owned; every imported object lives in a pack.
      await git(["reflog", "expire", "--expire=all", "--all"]);
      await git(["repack", "-ad"]);
      current();
      await fs.writeFile(path.join(repo, ".git", "shallow"), params.baseCommit + "\n");
    }
    await configureProjectionFetch(params);
  } finally {
    phases.mark(`${RECONCILE_PHASE}.checkout.cleanup`);
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
  using phases = observeDiagnosticsTimelinePhases(`${RECONCILE_PHASE}.initialize`);
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
    phases.mark(`${RECONCILE_PHASE}.template`);
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
      phases.mark(`${RECONCILE_PHASE}.checkout`);
      await timeWorktreePreparationPhase("checkout", () => prepareLocalWorkspaceCheckout(checkout));
    } else {
      // A retained template may predate the fetch defaults; its key remains source-owned.
      await configureProjectionFetch(checkout);
    }
    phases.mark(`${RECONCILE_PHASE}.manifest_scan`);
    const initial = await timeWorktreePreparationPhase("snapshot", async () =>
      captureWorkspaceManifestDocument({
        root: repo,
        baseCommit: params.baseCommit,
        buildCacheInputs: new Set(await params.buildCacheInputs()),
        signal,
      }),
    );
    current();
    phases.mark(`${RECONCILE_PHASE}.publish`);
    await fs.rename(repo, params.projectionPath);
    return initial;
  } finally {
    phases.mark(`${RECONCILE_PHASE}.cleanup`);
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
