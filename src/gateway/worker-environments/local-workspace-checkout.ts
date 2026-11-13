import fs from "node:fs/promises";
import path from "node:path";
import type { SandboxConfig } from "../../agents/sandbox/types.js";
import type { WorktreeAllocationGuard } from "../../agents/worktrees/allocation.js";
import { withWorktreeGitConfig } from "../../agents/worktrees/checkout-git-config.js";
import { prepareWorktreeFilesystemMutation } from "../../agents/worktrees/filesystem-native.js";
import { commandError, gitEnvironment, requireGit, runGit } from "../../agents/worktrees/git.js";
import { timeWorktreePreparationPhase } from "../../agents/worktrees/preparation-timing.js";
import type { WorktreeWorkerAuthority } from "../../agents/worktrees/types.js";
import {
  composeSessionSourceAssertion,
  prepareSessionSourceEffect,
  type PreparedSessionSourceEffect,
  type SessionSourceAssertion,
} from "../../config/sessions/session-source-authority.js";
import { resolveStateDir } from "../../config/state-dir.js";
import { observeDiagnosticsTimelinePhases } from "../../infra/diagnostics-timeline.js";
import { gitNullConfigPath } from "../../infra/git-exec.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { withGitProcessOperation } from "../../process/spawn-diagnostics.js";
import { parseGitHubRemoteUrl } from "../github-remote.js";
import type { LocalWorkspaceOwner } from "./local-workspace-types.js";
import { prepareWorkerWorkspaceGitPack } from "./workspace-git-base.js";
import { captureWorkspaceManifestDocument } from "./workspace-manifest-worker.js";

const RECONCILE_PHASE = "attempt.setup.sandbox.workspace_selection.prepare.reconcile";

type CheckoutAuthority = {
  signal: AbortSignal;
  assertCurrent: SessionSourceAssertion;
  workerAuthority?: WorktreeWorkerAuthority;
};

function checkoutCurrent(source: PreparedSessionSourceEffect, params: CheckoutAuthority) {
  const assertCurrent = () => {
    params.signal.throwIfAborted();
    source.assertCurrent();
  };
  const workspaceEvidence = [
    ...new Set([
      ...(source.workspaceEvidence ?? []),
      ...(params.workerAuthority?.workspaceEvidence ?? []),
    ]),
  ];
  // Git borrows the source held by this checkout until its effects settle.
  return Object.assign(assertCurrent, {
    prepareSessionSourceEffect: async () => ({
      ...source,
      release: undefined,
      assertCurrent,
      workspaceEvidence,
    }),
  });
}

function checkoutGitEnvironment(home: string) {
  return {
    PATH: process.env.PATH,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: gitNullConfigPath(),
    GIT_CONFIG_SYSTEM: gitNullConfigPath(),
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
}

async function configureProjectionFetch(
  params: CheckoutAuthority & {
    source: string;
    destination: string;
  },
  cleanEnv: NodeJS.ProcessEnv,
) {
  const options = {
    baseEnv: cleanEnv,
    env: cleanEnv,
    signal: params.signal,
    beforeRun: params.assertCurrent,
    stateOwnerPath: params.workerAuthority?.stateOwnerPath,
  };
  // Git-owned projection metadata; shared base clones must never get shallow defaults.
  await requireGit(
    params.destination,
    ["config", "--local", "--replace-all", "openclaw.projection", "true"],
    options,
  );
  const origin = await runGit(params.source, ["config", "--get", "remote.origin.url"], options);
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
  const config: Record<string, string> = { "remote.origin.url": `${url}.git` };
  // Git keys filters by the supplied remote name, even when that name is a URL.
  for (const remote of ["origin", url, `${url}.git`]) {
    config[`remote.${remote}.promisor`] = "true";
    config[`remote.${remote}.partialclonefilter`] = "blob:none";
  }
  for (const [key, value] of Object.entries(config)) {
    await requireGit(
      params.destination,
      ["config", "--local", "--replace-all", key, value],
      options,
    );
  }
}

export async function localWorkspaceProjectionPath(
  owner: Pick<LocalWorkspaceOwner, "worktree" | "env">,
) {
  if (!/^[a-f0-9-]{36}$/u.test(owner.worktree.id)) {
    throw new Error("Invalid managed worktree identity");
  }
  return path.join(
    await fs.realpath(resolveStateDir(owner.env)),
    "worktree-projections",
    owner.worktree.id,
    "workspace",
  );
}

/** Build or refresh private source-only metadata before any guest can write this checkout. */
export async function prepareLocalWorkspaceCheckout(
  params: CheckoutAuthority & {
    source: string;
    destination: string;
    temporaryRoot: string;
    baseCommit: string;
    /** The exclusive template owner has validated this existing checkout. */
    retainedCommit?: string;
    branch: string;
  },
) {
  using phases = observeDiagnosticsTimelinePhases(`${RECONCILE_PHASE}.checkout.pack`);
  const { signal, destination: repo } = params;
  const source = await prepareSessionSourceEffect(
    composeSessionSourceAssertion([params.assertCurrent, params.workerAuthority?.assertCurrent]),
  );
  await using _ = { [Symbol.asyncDispose]: async () => await source.release?.() };
  const current = checkoutCurrent(source, params);
  const filesystem = { commitGuard: current, signal, workerAuthority: params.workerAuthority };
  const prepare = () => prepareWorktreeFilesystemMutation(filesystem, source);
  await prepare();
  current();
  const temporary = await fs.mkdtemp(path.join(params.temporaryRoot, "git-"));
  try {
    const pack = await withWorktreeGitConfig(
      params.source,
      true,
      {
        signal,
        beforeRun: current,
        stateOwnerPath: params.workerAuthority?.stateOwnerPath,
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
    await prepare();
    current();
    phases.mark(`${RECONCILE_PHASE}.checkout.index`);
    await fs.mkdir(repo, { recursive: true, mode: 0o700 });
    const cleanEnv = checkoutGitEnvironment(temporary);
    const git = (args: string[], input?: Uint8Array) =>
      requireGit(repo, args, {
        baseEnv: cleanEnv,
        env: cleanEnv,
        input,
        signal,
        beforeRun: current,
        stateOwnerPath: params.workerAuthority?.stateOwnerPath,
      });
    if (!params.retainedCommit) {
      await git([
        "init",
        "--quiet",
        "--template=",
        "--object-format=" + (params.baseCommit.length === 40 ? "sha1" : "sha256"),
      ]);
    }
    const input = await fs.open(pack, "r");
    try {
      await prepare();
      current();
      const result = await withGitProcessOperation(
        "workspace.inventory",
        () =>
          runCommandWithTimeout(["git", "-C", repo, "index-pack", "--stdin", "--fix-thin"], {
            stdinFileDescriptor: input.fd,
            baseEnv: gitEnvironment(cleanEnv),
            signal,
            timeoutMs: 300_000,
            maxOutputBytes: 4096,
            terminateOnOutputLimit: true,
            killProcessTree: true,
            requireProcessTreeExtinction: true,
          }),
        "default",
      );
      if (result.code !== 0 || result.termination !== "exit") {
        throw commandError("git index-pack", result);
      }
    } finally {
      await input.close();
    }
    await prepare();
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
      phases.mark(`${RECONCILE_PHASE}.checkout.repack`);
      await git(["reflog", "expire", "--expire=all", "--all"]);
      // Reuse compressed objects without searching the entire snapshot for new deltas.
      await git(["repack", "-ad", "--window=0"]);
      await prepare();
      current();
      await fs.writeFile(path.join(repo, ".git", "shallow"), params.baseCommit + "\n");
    }
    phases.mark(`${RECONCILE_PHASE}.checkout.configure`);
    await configureProjectionFetch({ ...params, assertCurrent: current }, cleanEnv);
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
export async function initializeLocalWorkspaceProjection(
  params: CheckoutAuthority & {
    owner: LocalWorkspaceOwner;
    projectionPath: string;
    baseCommit: string;
    buildCacheInputs: () => Promise<string[]>;
    dependencies?: { sandbox: SandboxConfig; allocation: WorktreeAllocationGuard };
  },
) {
  using phases = observeDiagnosticsTimelinePhases(`${RECONCILE_PHASE}.initialize`);
  const { signal, dependencies } = params;
  const workerAuthority = {
    ...params.owner.workerAuthority,
    ...params.workerAuthority,
    workspaceEvidence: [
      ...new Set([
        ...(params.owner.workerAuthority?.workspaceEvidence ?? []),
        ...(params.workerAuthority?.workspaceEvidence ?? []),
      ]),
    ],
  };
  const source = await prepareSessionSourceEffect(
    composeSessionSourceAssertion([
      params.assertCurrent,
      params.owner.assertCurrent,
      params.owner.workerAuthority?.assertCurrent,
      params.workerAuthority?.assertCurrent,
    ]),
  );
  await using _ = { [Symbol.asyncDispose]: async () => await source.release?.() };
  const current = checkoutCurrent(source, { ...params, workerAuthority });
  const filesystem = { commitGuard: current, signal, workerAuthority };
  const prepare = () => prepareWorktreeFilesystemMutation(filesystem, source);
  const parent = path.dirname(params.projectionPath);
  await prepare();
  current();
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  await assertLocalWorkspaceDirectory(parent);
  await prepare();
  current();
  // No runtime can use an uncommitted initial projection. Only this durable
  // reservation owns interrupted preparation; never recreate a ready checkout.
  await fs.rm(params.projectionPath, { recursive: true, force: true });
  await prepare();
  current();
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
      workerAuthority,
    };
    const buildCacheInputs = await params.buildCacheInputs();
    phases.mark(`${RECONCILE_PHASE}.template`);
    const cloned =
      dependencies &&
      (await (
        await import("./local-workspace-template.js")
      ).cloneLocalWorkspaceTemplate({
        ...checkout,
        buildCacheInputs,
        repoRoot: params.owner.worktree.repoRoot,
        templateRoot: path.dirname(parent),
        env: params.owner.env ?? process.env,
        sandbox: dependencies.sandbox,
        guard: {
          ...dependencies.allocation,
          signal: dependencies.allocation.signal
            ? AbortSignal.any([signal, dependencies.allocation.signal])
            : signal,
          commitGuard: composeSessionSourceAssertion([
            dependencies.allocation.commitGuard,
            current,
          ]),
          workerAuthority: {
            ...dependencies.allocation.workerAuthority,
            assertCurrent: composeSessionSourceAssertion([
              dependencies.allocation.workerAuthority.assertCurrent,
              workerAuthority.assertCurrent,
              current,
            ]),
            stateOwnerPath:
              workerAuthority.stateOwnerPath ??
              dependencies.allocation.workerAuthority.stateOwnerPath,
            workspaceEvidence: [
              ...new Set([
                ...(dependencies.allocation.workerAuthority.workspaceEvidence ?? []),
                ...(workerAuthority.workspaceEvidence ?? []),
              ]),
            ],
          },
        },
      }));
    if (!cloned) {
      phases.mark(`${RECONCILE_PHASE}.checkout`);
      await timeWorktreePreparationPhase("checkout", () => prepareLocalWorkspaceCheckout(checkout));
    } else {
      // A retained template may predate the fetch defaults; its key remains source-owned.
      await configureProjectionFetch(checkout, checkoutGitEnvironment(temporary));
    }
    phases.mark(`${RECONCILE_PHASE}.manifest_scan`);
    const initial =
      cloned ||
      (await timeWorktreePreparationPhase("snapshot", async () =>
        captureWorkspaceManifestDocument({
          root: repo,
          baseCommit: params.baseCommit,
          buildCacheInputs: new Set(buildCacheInputs),
          signal,
        }),
      ));
    await prepare();
    current();
    phases.mark(`${RECONCILE_PHASE}.publish`);
    await fs.rename(repo, params.projectionPath);
    return initial;
  } finally {
    phases.mark(`${RECONCILE_PHASE}.cleanup`);
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
