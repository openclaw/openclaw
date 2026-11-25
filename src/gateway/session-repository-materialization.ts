import { randomUUID } from "node:crypto";
import os from "node:os";
import { resolveConfiguredGitHubHost } from "../agents/github-host.js";
import { captureWorktreeRegistryReadGuard } from "../agents/worktrees/registry-read.js";
import { captureWorktreeRunEndContext } from "../agents/worktrees/run-end-lifecycle.js";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import { captureSessionEntrySourceAssertion } from "../config/sessions/session-entry-source-authority.js";
import {
  sessionEntryCommitGuardOptions,
  composeSessionSourceAssertion,
  type SessionSourceAssertion,
} from "../config/sessions/session-source-authority.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { gitNullConfigPath } from "../infra/git-exec.js";
import { resolveRuntimeProcessEntrypointUrl } from "../infra/runtime-process-url.js";
import { resolveRuntimeWorkerArgv } from "../infra/runtime-worker-url.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  readProjectCheckoutRemoteHead,
  ProjectCloneError,
} from "../projects/project-clone-runtime.js";
import { materializeProjectClone } from "../projects/project-clone.js";
import { getSessionRepositoryWorkspaceStore } from "../state/session-repository-workspaces.js";
import type { SessionRepositoryWorkspaceRecord } from "../state/session-repository-workspaces.types.js";
import { parseGitHubPublicationBaseBranch } from "./github-publication-base.js";
import {
  assertSafeGitPublicationWorkspace,
  createGitHubPublicationCommandRunner,
} from "./github-publication-git-transport.js";
import { readRepositoryGitHubPublicationBranchAsync } from "./github-publication-store-async.js";
import { parseGitHubRemoteUrl } from "./github-remote.js";
import { prepareRepositoryPublicationRestore } from "./github-repository-publication-restore.js";
import { retainGatewaySessionEntryReadOnly } from "./session-utils-read-lifetime.js";
import type { GatewaySessionEntryRead } from "./session-utils-store.js";
import { prepareSessionWorktree } from "./session-worktree-preparation.js";
import type { PlacementRecoveryDeps } from "./worker-environments/placement-recovery-contract.js";
import type {
  WorkerSessionPlacementStore,
  WorkerSessionTurnClaim,
} from "./worker-environments/placement-store.js";
import { prepareRepositoryGitHubIdentity } from "./worker-environments/repository-github-identity.js";
import { captureRepositoryDiskCheckpoint } from "./worker-environments/repository-workspace-snapshot.js";
import {
  readSessionRepositoryArtifacts,
  withSessionRepositoryCheckpoint,
} from "./worker-environments/session-repository-checkpoints.js";
import { applyStagedWorkerWorkspace } from "./worker-environments/workspace-reconcile-apply.js";
import { restoreWorkerWorkspaceHistory } from "./worker-environments/workspace-result-history.js";
import { workerWorkspaceResultRef } from "./worker-environments/workspace-result-staging.js";

/** The existing Move owner supplies quiescence and result custody; publication shares its exclusion. */
export function createRepositoryGatewayMovePreparation(options: {
  placements: WorkerSessionPlacementStore;
  environments: Parameters<typeof captureRepositoryDiskCheckpoint>[0]["environments"];
  getConfig: () => OpenClawConfig;
}): NonNullable<PlacementRecoveryDeps["prepareGatewayMove"]> {
  return (identity) =>
    options.placements.withWorkspaceExclusion(identity.sessionId, async (assertOwned) =>
      materializeSessionRepositoryWorkspaceOnGateway({
        cfg: options.getConfig(),
        ...identity,
        ...(identity.diskResult
          ? { diskMove: { claim: identity.diskResult, placements: options.placements } }
          : {}),
        assertCurrent: () => {
          assertOwned();
          identity.assertCurrent();
        },
        exportDisk: identity.quiescence
          ? (repository, assertCurrent, use) =>
              captureRepositoryDiskCheckpoint(
                {
                  identity,
                  repository,
                  checkpointRef: workerWorkspaceResultRef("gateway-export-" + randomUUID()),
                  purpose: "gateway-move",
                  placements: options.placements,
                  environments: options.environments,
                  quiescence: identity.quiescence,
                  assertCurrent,
                },
                async (snapshot, verifyCurrent) => {
                  if (identity.diskResult) {
                    assertCurrent();
                    await options.placements.recordStagedWorkspaceResult(
                      identity.diskResult,
                      snapshot.checkpointRef,
                      repository.workspaceId,
                      assertCurrent,
                    );
                  }
                  await use(snapshot, verifyCurrent);
                },
              )
          : undefined,
      }),
    );
}

/** Explicit Gateway moves and failed-placement recovery restore only accepted source results. */
async function materializeSessionRepositoryWorkspaceOnGateway(params: {
  cfg: OpenClawConfig;
  sessionId: string;
  sessionKey: string;
  agentId: string;
  assertCurrent: SessionSourceAssertion;
  signal?: AbortSignal;
  diskMove?: { claim: WorkerSessionTurnClaim; placements: WorkerSessionPlacementStore };
  exportDisk?: (
    repository: SessionRepositoryWorkspaceRecord,
    assertCurrent: () => void,
    use: (
      snapshot: { checkpointRef: string; manifestHash: string },
      verifyCurrent: () => Promise<void>,
    ) => Promise<void>,
  ) => Promise<void>;
}): Promise<void> {
  const initial = await retainGatewaySessionEntryReadOnly(
    params.sessionKey,
    params.agentId,
    (previous, current) => previous.repositoryWorkspaceId === current.repositoryWorkspaceId,
    params.cfg,
  );
  try {
    await materializeCapturedRepositoryWorkspace(params, initial, () => {
      if (!initial.isCurrentAtResponse()) {
        throw new Error("Repository workspace changed during Gateway materialization; retry move");
      }
    });
  } finally {
    initial.release();
  }
  if (params.diskMove) {
    await retireMaterializedRepositoryDisk(params, params.diskMove);
  }
}

async function retireMaterializedRepositoryDisk(
  params: Parameters<typeof materializeSessionRepositoryWorkspaceOnGateway>[0],
  diskMove: NonNullable<
    Parameters<typeof materializeSessionRepositoryWorkspaceOnGateway>[0]["diskMove"]
  >,
) {
  const pending = diskMove.placements.preparedWorkspaceResult(diskMove.claim);
  if (
    !pending?.repositoryWorkspaceId ||
    !pending.repositoryDiskAuthority ||
    !pending.stagedResultRef
  ) {
    throw new Error("Repository disk handoff has no retained export result");
  }
  const store = getSessionRepositoryWorkspaceStore();
  const repository = await store.get(pending.repositoryWorkspaceId);
  params.assertCurrent();
  if (
    !repository ||
    repository.agentId !== params.agentId ||
    repository.sessionKey !== params.sessionKey
  ) {
    throw new Error("Repository disk handoff lost its source owner");
  }
  const local = await retainGatewaySessionEntryReadOnly(
    params.sessionKey,
    params.agentId,
    (before, after) =>
      before.sessionId === after.sessionId &&
      before.lifecycleRevision === after.lifecycleRevision &&
      before.activeWriterRunId === after.activeWriterRunId &&
      before.repositoryWorkspaceId === after.repositoryWorkspaceId &&
      before.worktree?.id === after.worktree?.id &&
      before.spawnedCwd === after.spawnedCwd,
    params.cfg,
  );
  try {
    const entry = local.entry;
    const accept = captureWorktreeRegistryReadGuard(
      captureWorktreeRunEndContext(process.env),
      "source-owner",
      entry?.worktree
        ? { id: entry.worktree.id, ownerKind: "session", ownerId: local.canonicalKey }
        : undefined,
    );
    const { managedWorktrees } = await import("../agents/worktrees/service.js");
    const worktree = await managedWorktrees.findLiveByOwner("session", local.canonicalKey);
    const assertWorktree = accept(worktree);
    const assertCurrent = () => {
      params.assertCurrent();
      if (
        !local.isCurrentAtResponse() ||
        !diskMove.placements.validateWorkspaceResultClaim(diskMove.claim)
      ) {
        throw new Error("Repository disk handoff lost its local session owner");
      }
      assertWorktree();
    };
    assertCurrent();
    // Move's draining placement excludes reset/switch/turns. The unique repository-named
    // managed worktree binding is the durable completion receipt of the verified import.
    // Recovery never reapplies the artifact after that binding, preserving local edits.
    if (
      entry?.sessionId !== params.sessionId ||
      entry.repositoryWorkspaceId ||
      !worktree ||
      worktree.name !== repository.workspaceId ||
      worktree.id !== entry.worktree?.id ||
      worktree.branch !== repository.branch ||
      worktree.path !== entry.spawnedCwd
    ) {
      throw new Error("Repository disk export has not been handed to its managed Gateway worktree");
    }
    if (!repository.diskAuthority) {
      if (repository.checkpointRef !== pending.stagedResultRef) {
        throw new Error("Repository disk handoff export changed");
      }
      return;
    }
    const snapshot = await readSessionRepositoryArtifacts({
      workspaceId: repository.workspaceId,
      checkpointRef: pending.stagedResultRef,
      assertCurrent,
    });
    assertCurrent();
    await store.retireDisk({
      workspaceId: repository.workspaceId,
      expectedRevision: repository.revision,
      checkpointRef: pending.stagedResultRef,
      manifestHash: snapshot.currentManifestRef,
      claim: diskMove.claim,
      assertCurrent,
    });
  } finally {
    local.release();
  }
}

async function materializeCapturedRepositoryWorkspace(
  params: Parameters<typeof materializeSessionRepositoryWorkspaceOnGateway>[0],
  initial: GatewaySessionEntryRead,
  assertEntryCurrent: () => void,
  diskExport?: {
    snapshot: { checkpointRef: string; manifestHash: string };
    verifyCurrent: () => Promise<void>;
  },
): Promise<void> {
  if (initial.entry?.sessionId !== params.sessionId) {
    throw new Error("Session changed before repository materialization");
  }
  const workspaceId = initial.entry.repositoryWorkspaceId;
  if (!workspaceId) {
    return;
  }
  const repositories = getSessionRepositoryWorkspaceStore();
  const preparedRepository = await repositories.prepare(workspaceId);
  const repository = preparedRepository.workspace;
  if (
    !repository ||
    repository.agentId !== params.agentId ||
    repository.sessionKey !== initial.canonicalKey ||
    !repository.baseCommit
  ) {
    throw new Error("Repository workspace has no pinned source; retry its cloud preparation");
  }
  const exportDisk = params.exportDisk;
  if (repository.diskAuthority && !diskExport && !exportDisk) {
    throw new Error(
      "Moving this repository to the Gateway requires a fresh disk export; preserve the original runner and retry after export support is available.",
    );
  }
  const githubHost = resolveConfiguredGitHubHost(params.cfg);
  const remote = parseGitHubRemoteUrl(repository.url, githubHost);
  if (!remote) {
    throw new Error(
      `Repository workspace does not match the configured GitHub host (${githubHost}); restore its GitHub configuration before retrying the Gateway move`,
    );
  }
  const branchInput = {
    workspaceId,
    branch: repository.branch,
    pushRepository: `${remote.owner}/${remote.repo}`,
  };
  const selected = await readRepositoryGitHubPublicationBranchAsync(branchInput);
  const published = selected.head;
  if (selected.unsettled) {
    throw new Error(
      "Repository publication is awaiting a GitHub effect observation; retry the Gateway move after publication settles",
    );
  }
  const assertOtherOwners = () => {
    params.signal?.throwIfAborted();
    if (preparedRepository.current()?.revision !== repository.revision) {
      throw new Error("Repository workspace changed during Gateway materialization; retry move");
    }
  };
  const assertEntry = (current: Partial<NonNullable<typeof initial.entry>> | undefined) => {
    if (
      current?.sessionId !== params.sessionId ||
      current.lifecycleRevision !== initial.entry?.lifecycleRevision ||
      current.repositoryWorkspaceId !== workspaceId
    ) {
      throw new Error("Repository workspace changed during Gateway materialization; retry move");
    }
  };
  const entrySource = captureSessionEntrySourceAssertion({
    scope: {
      agentId: params.agentId,
      sessionKey: initial.canonicalKey,
      storePath: initial.storePath,
    },
    readSource: initial.capturedReadSource,
    fields: ["sessionId", "lifecycleRevision", "repositoryWorkspaceId"],
    expected: initial.entry,
    assertCurrent: assertEntryCurrent,
    refuse: () => {
      throw new Error("Repository workspace changed during Gateway materialization; retry move");
    },
  });
  const assertCurrent = composeSessionSourceAssertion(
    [params.assertCurrent, entrySource],
    (assertSources) => {
      assertSources();
      assertOtherOwners();
    },
  );
  assertCurrent();
  if (repository.diskAuthority && !diskExport && exportDisk) {
    return await exportDisk(
      repository,
      assertCurrent,
      async (snapshot, verifyCurrent) =>
        await materializeCapturedRepositoryWorkspace(params, initial, assertEntryCurrent, {
          snapshot,
          verifyCurrent,
        }),
    );
  }
  const snapshot = diskExport?.snapshot ?? {
    checkpointRef: repository.checkpointRef,
    manifestHash: repository.manifestHash,
  };
  assertCurrent();
  const github = await prepareRepositoryGitHubIdentity(params.agentId, assertCurrent);
  assertCurrent();
  const cloneOptions = {
    signal: params.signal,
    token: github.token,
    assertCurrent: github.assertSelected,
  };
  const requiredCommit = published?.pushed_head_commit ?? repository.baseCommit;
  const project = await github
    .start(() =>
      materializeProjectClone(
        {
          cfg: params.cfg,
          gitUrl: repository.url,
          requiredCommit,
        },
        cloneOptions,
      ),
    )
    .catch((error: unknown) => {
      if (error instanceof ProjectCloneError && error.failure === "auth_required") {
        throw new ProjectCloneError(
          error.failure,
          "GitHub could not authenticate this repository with the selected shared GitHub identity. Check its repository access or reconnect it in Settings, then retry the Gateway move.",
        );
      }
      throw error;
    });
  assertCurrent();
  const {
    step,
    require: command,
    run,
  } = createGitHubPublicationCommandRunner(assertCurrent, "session.materialize");
  const source = { url: repository.url, target: project.repoRoot };
  const remoteHead = await step(() =>
    readProjectCheckoutRemoteHead({ ...source, branch: repository.branch }, cloneOptions),
  );
  if (remoteHead !== (published?.pushed_head_commit ?? undefined)) {
    throw new Error(
      "Repository publication branch differs from its recorded push; review the remote branch before retrying the Gateway move",
    );
  }
  const requestedBase = parseGitHubPublicationBaseBranch(repository.requestedRef ?? "HEAD", "HEAD");
  const baseRef =
    published?.base_branch ??
    (requestedBase !== "HEAD" &&
    (await step(() =>
      readProjectCheckoutRemoteHead({ ...source, branch: requestedBase }, cloneOptions),
    ))
      ? requestedBase
      : "HEAD");
  if (published?.pushed_head_commit) {
    const head = published.pushed_head_commit;
    const contents = await command(["git", "show", "-s", "--format=%T%n%P%n%B", head], {
      cwd: project.repoRoot,
    });
    const [tree, parent, ...message] = contents.split("\n");
    const ancestor = await run(
      ["git", "merge-base", "--is-ancestor", repository.baseCommit, head],
      { cwd: project.repoRoot },
    );
    if (
      ancestor.code !== 0 ||
      tree !== published.workspace_tree ||
      parent !== (published.previous_head_commit ?? repository.baseCommit) ||
      !message.includes(`OpenClaw-Publication: ${published.request_id}`)
    ) {
      throw new Error(
        "Recorded repository publication commit could not be verified; review publication before retrying the Gateway move",
      );
    }
  }
  const prepared = await prepareSessionWorktree({
    cfg: params.cfg,
    target: {
      agentId: params.agentId,
      key: initial.canonicalKey,
      storePath: initial.storePath,
      entry: initial.entry,
      projectId: project.id,
      sandboxRequired: initial.entry.sandbox === "required",
    },
    workspace: project.repoRoot,
    name: repository.workspaceId,
    baseRef,
    checkoutCommit: repository.baseCommit,
    runSetupScript: false,
    signal: params.signal,
    commitGuard: assertCurrent,
  });
  if (!prepared.ok) {
    throw new Error(prepared.error.message);
  }
  const workspace = prepared.value;
  const root = workspace.spawnedCwd;
  if (!root || !workspace.worktree) {
    throw new Error("Repository materialization did not create a managed worktree");
  }
  const git = (args: string[]) =>
    command(["git", "-c", `core.hooksPath=${os.devNull}`, "-c", "core.fsmonitor=false", ...args], {
      cwd: root,
      env: { GIT_CONFIG_GLOBAL: gitNullConfigPath(), GIT_CONFIG_SYSTEM: gitNullConfigPath() },
    });
  const alignPublication = async () => {
    if (published?.pushed_head_commit) {
      // Preserve the creation reflog at the pinned base and the accepted working bytes.
      // The local publisher must append to the cloud push, not make a sibling commit.
      await git(["reset", "--mixed", "--no-refresh", published.pushed_head_commit]);
    }
  };
  let bound = false;
  try {
    await step(() => assertSafeGitPublicationWorkspace(root, run));
    const currentHead = await git(["rev-parse", "--verify", "HEAD^{commit}"]);
    const currentBranch = await git(["symbolic-ref", "--quiet", "HEAD"]);
    if (
      currentBranch !== `refs/heads/${repository.branch}` ||
      (!diskExport &&
        currentHead !== repository.baseCommit &&
        currentHead !== published?.pushed_head_commit)
    ) {
      throw new Error(
        "Gateway worktree changed before repository restoration; review its local commits before retrying move",
      );
    }
    if (snapshot.checkpointRef) {
      await withSessionRepositoryCheckpoint(
        { workspaceId, checkpointRef: snapshot.checkpointRef },
        async (payload) => {
          assertCurrent();
          // A crash can leave this unbound preparation after its HEAD import but
          // before session binding. Resume only the exact freshly exported HEAD;
          // unknown local commits still refuse rather than being reset or discarded.
          if (
            currentHead !== repository.baseCommit &&
            currentHead !== published?.pushed_head_commit &&
            currentHead !== payload.gitHistory?.headCommit
          ) {
            throw new Error(
              "Gateway worktree changed before repository restoration; review its local commits before retrying move",
            );
          }
          const applied = await applyStagedWorkerWorkspace({
            ...payload,
            acceptance: { kind: "reconcile" },
            root,
            // The checkout is unbound until verification. Failed preparation rolls it
            // back; a crash leaves the immutable checkpoint available for a fresh retry.
            journal: {
              load: async () => undefined,
              begin: async () => assertCurrent(),
              commit: async () => assertCurrent(),
              abort: async () => {},
            },
          });
          if (applied.conflictPaths.length || applied.manifestRef !== snapshot.manifestHash) {
            throw new Error(
              "Repository changes could not be fully restored; retry the Gateway move",
            );
          }
          await applied.verifyLocalStable();
          await alignPublication();
          const historyNote = await restoreWorkerWorkspaceHistory({
            ...payload,
            root,
            assertCurrent,
          });
          if (historyNote && repository.diskAuthority) {
            throw new Error(
              "Repository disk history could not be restored exactly; the original disk is preserved",
            );
          }
          if (historyNote) {
            createSubsystemLogger("gateway/worker-workspace").info(historyNote);
          }
          for (const restore of await prepareRepositoryPublicationRestore({
            ...payload,
            indexBase: { root, commit: await git(["rev-parse", "HEAD"]), assertCurrent },
          })) {
            await command(
              [
                process.execPath,
                ...resolveRuntimeWorkerArgv(
                  resolveRuntimeProcessEntrypointUrl("repositoryPublicationRestore"),
                ),
                restore.action,
              ],
              { cwd: root, input: restore.input },
            );
          }
          await applied.verifyLocalStable();
          assertCurrent();
        },
      );
    } else {
      await alignPublication();
    }
    await diskExport?.verifyCurrent();
    assertCurrent();
    const bind = async (assertSourceCurrent: SessionSourceAssertion, sourceSignal?: AbortSignal) =>
      await patchSessionEntryCore(
        { agentId: params.agentId, sessionKey: initial.canonicalKey, storePath: initial.storePath },
        (current) => {
          assertCurrent();
          assertSourceCurrent();
          assertEntry(current);
          return {
            ...current,
            repositoryWorkspaceId: undefined,
            projectId: project.id,
            spawnedCwd: workspace.spawnedCwd,
            sessionRoot: workspace.sessionRoot,
            worktree: workspace.worktree,
          };
        },
        {
          replaceEntry: true,
          signal:
            params.signal && sourceSignal
              ? AbortSignal.any([params.signal, sourceSignal])
              : (params.signal ?? sourceSignal),
          ...sessionEntryCommitGuardOptions(
            composeSessionSourceAssertion([assertCurrent, assertSourceCurrent]),
          ),
          requireWriteSuccess: true,
          skipMaintenance: true,
          onCommitted: () => {
            bound = true;
          },
        },
      );
    const entry = workspace.withCommit ? await workspace.withCommit(bind) : await bind(() => {});
    if (!entry) {
      throw new Error("Session disappeared before repository materialization committed");
    }
    // Pending publication receipts still own immutable source refs. Session deletion
    // releases that retained repository row; future turns use the bound local worktree.
  } finally {
    if (!bound) {
      await workspace.rollback?.();
    }
  }
}
