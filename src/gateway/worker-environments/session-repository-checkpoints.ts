import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { prepareSessionSourceAuthority } from "../../config/sessions/session-source-authority.js";
import { runGitWorkerOperation } from "../../infra/git-worker.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { runExec } from "../../process/exec.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import {
  getSessionRepositoryWorkspaceStore,
  type SessionRepositoryWorkspaceStore,
} from "../../state/session-repository-workspaces.js";
import type { SessionRepositoryWorkspaceRecord } from "../../state/session-repository-workspaces.types.js";
import { MAX_WORKSPACE_RESULT_GIT_PACK_BYTES } from "../../worker/node-workspace-transfer-protocol.js";
import { readGitHubRepositoryPublicationMetadata } from "../github-repository-publication-snapshot.js";
import {
  checkpointRef,
  publicationRef,
  publishCheckpointRefs,
} from "./session-repository-checkpoint-refs.js";
import type {
  RepositoryGitHistory,
  SessionRepositoryCheckpointPayload,
} from "./session-repository-checkpoints.types.js";
import { boundedWorkerError } from "./worker-error.js";
import { sameEntry } from "./workspace-manifest-comparison.js";
import {
  loadStagedWorkspaceManifest,
  parseWorkspaceManifestPair,
} from "./workspace-manifest-worker.js";
import {
  requireWorkspaceResultGit,
  requireWorkspaceResultGit as git,
  updateWorkspaceResultRefs,
  readWorkspaceResultRefObjects,
  workspaceResultCheckpointInitArgs,
  workspaceResultGitCommand,
  WORKSPACE_RESULT_GIT_TIMEOUT_MS,
} from "./workspace-result-git.js";
import {
  repositoryHistoryNote,
  workerHistoryNotAdopted,
  withRepositoryCheckpointHistory,
  REPOSITORY_HISTORY_MESSAGE as MARKER,
} from "./workspace-result-history.js";
import type {
  StagedWorkerArtifactInventory,
  StagedWorkerWorkspaceResult,
} from "./workspace-result-inventory.js";
import {
  deleteStagedWorkerWorkspaceResult,
  preparedWorkerWorkspaceResultRef,
  withStagedWorkerWorkspaceResult,
  withStagedWorkerWorkspaceManifest,
  readStagedWorkerWorkspaceResult,
  workerWorkspaceResultRef,
  workerWorkspaceResultStaging,
} from "./workspace-result-staging.js";

// Preserve the checkpoint owner's existing public payload type import path.
export type { SessionRepositoryCheckpointPayload } from "./session-repository-checkpoints.types.js";

type CheckpointOwner = { workspaceId: string; store?: SessionRepositoryWorkspaceStore };
type CheckpointSource = CheckpointOwner & { checkpointRef?: string };
const workspaceLog = createSubsystemLogger("gateway/worker-workspace");

async function owner(params: CheckpointOwner) {
  const store = params.store ?? getSessionRepositoryWorkspaceStore();
  const prepared = await store.prepare(params.workspaceId);
  const workspace = prepared.workspace;
  if (!workspace) {
    throw new Error("Repository workspace no longer exists");
  }
  return {
    store,
    workspace,
    current: prepared.current,
    root: store.artifactPath(params.workspaceId),
  };
}

function assertBase(
  workspace: SessionRepositoryWorkspaceRecord,
  snapshot: Pick<StagedWorkerArtifactInventory, "base" | "current" | "baseManifestRef">,
) {
  if (
    !workspace.baseCommit ||
    snapshot.base.baseCommit !== workspace.baseCommit ||
    snapshot.current.baseCommit !== workspace.baseCommit ||
    snapshot.baseManifestRef !== workspace.baseManifestHash
  ) {
    throw new Error("Repository checkpoint does not match its pinned base");
  }
  return workspace.baseCommit;
}

export async function readSessionRepositoryArtifacts(
  params: CheckpointSource & {
    previewPath?: string;
    downloadPath?: string;
    assertCurrent: () => void;
  },
): Promise<StagedWorkerArtifactInventory> {
  const { workspace, root } = await owner(params);
  const ref = checkpointRef(workspace, params.checkpointRef);
  const snapshot = await runGitWorkerOperation(
    {
      type: "workspace.artifacts",
      input: { root, ref, previewPath: params.previewPath, downloadPath: params.downloadPath },
    },
    { assertCurrent: params.assertCurrent },
  );
  assertBase(workspace, snapshot);
  if (ref === workspace.checkpointRef && snapshot.currentManifestRef !== workspace.manifestHash) {
    throw new Error("Repository checkpoint differs from its accepted manifest");
  }
  return snapshot;
}

async function publicationBinding(root: string, currentManifestRef: string) {
  const raw = await fs.readFile(path.join(root, "binding.json"), "utf8");
  const binding: unknown = JSON.parse(raw);
  if (
    !isRecord(binding) ||
    binding.currentManifestRef !== currentManifestRef ||
    typeof binding.publicationDigest !== "string"
  ) {
    throw new Error("Repository publication checkpoint binding changed");
  }
  const { snapshot } = await readGitHubRepositoryPublicationMetadata(
    root,
    binding.publicationDigest,
  );
  return { publicationDigest: binding.publicationDigest, snapshot };
}

export async function withSessionRepositoryCheckpoint<T>(
  params: CheckpointSource & { requireGitHistory?: boolean },
  use: (snapshot: SessionRepositoryCheckpointPayload) => Promise<T>,
): Promise<T> {
  return withRepositoryCheckpoint(params, withStagedWorkerWorkspaceManifest, use);
}

export async function withSessionRepositoryPublicationCheckpoint<T>(
  params: CheckpointSource,
  use: (
    snapshot: StagedWorkerWorkspaceResult &
      RepositoryGitHistory & {
        publicationStagingRoot?: string;
        publicationDigest?: string;
      },
  ) => Promise<T>,
): Promise<T> {
  return withRepositoryCheckpoint(
    params,
    async (source, consume) =>
      consume(await readStagedWorkerWorkspaceResult(source.root, source.stagedResultRef)),
    use,
  );
}

async function withRepositoryCheckpoint<
  Snapshot extends {
    base: { baseCommit: string | null };
    current: { baseCommit: string | null };
    baseManifestRef: string;
    currentManifestRef: string;
  },
  T,
>(
  params: CheckpointSource & { requireGitHistory?: boolean },
  materialize: <Result>(
    source: { root: string; stagedResultRef: string },
    use: (snapshot: Snapshot) => Promise<Result>,
  ) => Promise<Result>,
  use: (
    snapshot: Snapshot &
      RepositoryGitHistory & { publicationStagingRoot?: string; publicationDigest?: string },
  ) => Promise<T>,
): Promise<T> {
  const { workspace, root } = await owner(params);
  const ref = checkpointRef(workspace, params.checkpointRef);
  return await materialize({ root, stagedResultRef: ref }, async (files) => {
    const historyReadInput = { root, checkpointRef: ref, baseCommit: assertBase(workspace, files) };
    return await withRepositoryCheckpointHistory(
      { ...historyReadInput, requireGitHistory: params.requireGitHistory },
      async (history) => {
        const snapshot = { ...files, ...history };
        assertBase(workspace, snapshot);
        if (
          ref === workspace.checkpointRef &&
          snapshot.currentManifestRef !== workspace.manifestHash
        ) {
          throw new Error("Repository checkpoint differs from its accepted manifest");
        }
        let useStarted = false;
        try {
          const companion = publicationRef(ref);
          if (!(await readWorkspaceResultRefObjects(root, [companion])).get(companion)) {
            useStarted = true;
            return await use(snapshot);
          }
          return await withStagedWorkerWorkspaceResult(
            { root, stagedResultRef: companion },
            async (publication) => {
              const binding = await publicationBinding(
                publication.stagingRoot,
                snapshot.currentManifestRef,
              );
              if (binding.snapshot.baseCommit !== workspace.baseCommit) {
                throw new Error("Repository publication checkpoint base changed");
              }
              useStarted = true;
              return await use({
                ...snapshot,
                publicationStagingRoot: publication.stagingRoot,
                publicationDigest: binding.publicationDigest,
              });
            },
          );
        } catch (error) {
          // Optional publication corruption cannot discard verified recovery bytes.
          // Once the consumer starts, its failures and effects must propagate unchanged.
          if (useStarted) {
            throw error;
          }
          workspaceLog.warn(
            `Repository publication checkpoint unavailable: ${boundedWorkerError(error)}`,
          );
          return await use(snapshot);
        }
      },
    );
  });
}

export async function recoverSessionRepositoryCheckpoint(
  params: CheckpointOwner & {
    checkpointRef: string;
    expectedRevision?: number;
    assertCurrent: () => void;
  },
): Promise<SessionRepositoryWorkspaceRecord> {
  const { store, workspace, current: currentWorkspace } = await owner(params);
  const snapshot = await readSessionRepositoryArtifacts(params);
  params.assertCurrent();
  const current = currentWorkspace();
  if (
    current?.checkpointRef === params.checkpointRef &&
    current.manifestHash === snapshot.currentManifestRef
  ) {
    return current;
  }
  return store.acceptCheckpoint({
    workspaceId: params.workspaceId,
    expectedRevision: params.expectedRevision ?? workspace.revision,
    checkpointRef: params.checkpointRef,
    manifestHash: snapshot.currentManifestRef,
    assertCurrent: params.assertCurrent,
  });
}

export async function stageSessionRepositoryCheckpoint(
  params: CheckpointOwner &
    RepositoryGitHistory & {
      expectedRevision: number;
      checkpointRef?: string;
      stagingRoot: string;
      baseManifestRaw: string;
      currentManifestRaw: string;
      baseManifestRef: string;
      currentManifestRef: string;
      publicationStagingRoot?: string;
      publicationDigest?: string;
      requireGitHistory?: boolean;
      assertCurrent: () => void;
    },
) {
  const { store, workspace, current: currentWorkspace, root } = await owner(params);
  params.assertCurrent();
  const ref = checkpointRef(
    workspace,
    params.checkpointRef ?? workerWorkspaceResultRef(randomUUID()),
  );
  const candidateRef = preparedWorkerWorkspaceResultRef(workerWorkspaceResultRef(randomUUID()));
  const companionCandidate = preparedWorkerWorkspaceResultRef(
    workerWorkspaceResultRef(randomUUID()),
  );
  const { base, current } = await parseWorkspaceManifestPair({
    baseRaw: params.baseManifestRaw,
    baseRef: params.baseManifestRef,
    currentRaw: params.currentManifestRaw,
    currentRef: params.currentManifestRef,
  });
  // Transfer bases advance after acceptance; durable recovery always stays relative
  // to the original pinned source. Only the accepted owner can supply reused blobs.
  let originalBase = {
    base,
    baseManifestRaw: params.baseManifestRaw,
    baseManifestRef: params.baseManifestRef,
  };
  let accepted: Awaited<ReturnType<typeof loadStagedWorkspaceManifest>> | undefined;
  let existingObjects: Array<[string, string]> | undefined;
  if (params.baseManifestRef !== workspace.baseManifestHash) {
    if (!workspace.checkpointRef || params.baseManifestRef !== workspace.manifestHash) {
      throw new Error("Repository incremental checkpoint has the wrong accepted parent");
    }
    accepted = await loadStagedWorkspaceManifest(
      root,
      checkpointRef(workspace, workspace.checkpointRef),
    );
    assertBase(workspace, accepted);
    if (
      accepted.currentManifestRef !== workspace.manifestHash ||
      base.baseCommit !== workspace.baseCommit
    ) {
      throw new Error("Repository incremental checkpoint parent changed");
    }
    originalBase = accepted;
    const previous = new Map(accepted.current.entries.map((entry) => [entry.path, entry]));
    const objects = accepted.objectsByPath;
    existingObjects = current.entries.flatMap<[string, string]>((entry) => {
      const object = objects.get(entry.path);
      return object && sameEntry(entry, previous.get(entry.path))
        ? [[entry.path, object.objectId]]
        : [];
    });
  }
  const baseCommit = assertBase(workspace, { ...originalBase, current });
  let note = repositoryHistoryNote(baseCommit, params);
  if (params.requireGitHistory && note) {
    throw new Error("Repository checkpoint requires complete Git history; retry the disk export");
  }
  const assertRevision = () => {
    params.assertCurrent();
    const latest = currentWorkspace();
    if (
      !latest ||
      (latest.revision !== params.expectedRevision &&
        !(latest.checkpointRef === ref && latest.manifestHash === params.currentManifestRef))
    ) {
      throw new Error("Repository workspace revision changed");
    }
  };
  assertRevision();
  if (workspace.checkpointRef && params.currentManifestRef === workspace.manifestHash) {
    const acceptedRef = checkpointRef(workspace, workspace.checkpointRef);
    const companionRef = publicationRef(acceptedRef);
    const objects = await readWorkspaceResultRefObjects(root, [acceptedRef, companionRef]);
    const object = objects.get(acceptedRef);
    const companion = objects.get(companionRef);
    accepted ??= await loadStagedWorkspaceManifest(root, acceptedRef);
    assertBase(workspace, accepted);
    if (accepted.currentManifestRef !== params.currentManifestRef) {
      throw new Error("Repository accepted checkpoint manifest changed");
    }
    let samePublication = !params.publicationDigest && !params.publicationStagingRoot && !companion;
    if (params.publicationDigest && params.publicationStagingRoot && companion) {
      try {
        const binding: unknown = JSON.parse(await git(root, ["show", companion + ":binding.json"]));
        samePublication =
          isRecord(binding) &&
          binding.currentManifestRef === params.currentManifestRef &&
          binding.publicationDigest === params.publicationDigest;
      } catch {
        // Corrupt optional publication metadata cannot make a candidate reusable.
      }
    }
    // Files alone do not identify a result: empty/amended commits must survive.
    let sameHistory = false;
    try {
      const message = await git(root, ["show", "-s", "--format=%B", acceptedRef + "^"]);
      const record: unknown = message.startsWith(MARKER)
        ? JSON.parse(message.slice(MARKER.length))
        : undefined;
      sameHistory =
        isRecord(record) &&
        isDeepStrictEqual(record.gitHistory, params.gitHistory) &&
        record.gitHistoryNote === note;
    } catch {
      // Missing history is rebuilt by the ordinary preparation path.
    }
    if (object && samePublication && sameHistory) {
      const verify = async () => {
        const observed = await readWorkspaceResultRefObjects(root, [acceptedRef, companionRef]);
        if (observed.get(acceptedRef) !== object || observed.get(companionRef) !== companion) {
          throw new Error("Repository accepted checkpoint identity changed");
        }
        assertRevision();
      };
      await verify();
      const publishArtifacts = async (additionalRefs: readonly string[] = []) => {
        await verify();
        // Keep requested recovery identities and their companions atomic, even
        // when the accepted checkpoint needs no new objects or SQLite update.
        await publishCheckpointRefs(
          root,
          workspace,
          object,
          companion,
          [params.checkpointRef ? ref : acceptedRef, ...additionalRefs],
          assertRevision,
        );
      };
      return {
        checkpointRef: acceptedRef,
        verify,
        discard: async () => {},
        publishArtifacts,
        publish: async () => {
          await publishArtifacts();
          assertRevision();
          return currentWorkspace()!;
        },
      };
    }
  }
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  assertRevision();
  await requireWorkspaceResultGit(root, workspaceResultCheckpointInitArgs());
  assertRevision();
  /** The checkpoint owns this synthetic parent; the pack stays opaque until a base is fetched. */
  const { gitHistory: workerGitHistory, gitPackPath } = params;
  let blob: string | undefined;
  if (!note && workerGitHistory && workerGitHistory.headCommit !== workerGitHistory.baseCommit) {
    try {
      if (!gitPackPath) {
        throw new Error("worker Git history has no pack");
      }
      const pack = await fs.open(gitPackPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await pack.stat();
        if (!stat.isFile() || stat.size > MAX_WORKSPACE_RESULT_GIT_PACK_BYTES) {
          throw new Error("worker Git pack exceeds its byte limit");
        }
        assertRevision();
        blob = (
          await runExec(
            "git",
            workspaceResultGitCommand(root, ["hash-object", "-w", "--stdin"]).slice(1),
            {
              stdinFileDescriptor: pack.fd,
              timeoutMs: WORKSPACE_RESULT_GIT_TIMEOUT_MS,
            },
          )
        ).stdout.trim();
      } finally {
        await pack.close();
      }
    } catch (error) {
      assertRevision();
      if (params.requireGitHistory) {
        throw error;
      }
      note = workerHistoryNotAdopted(boundedWorkerError(error));
    }
  }
  assertRevision();
  const tree = await git(root, ["mktree"], {
    input: Buffer.from(blob ? `100644 blob ${blob}\thistory.pack\n` : ""),
  });
  assertRevision();
  const parentCommit = await git(
    root,
    [
      "-c",
      "user.name=OpenClaw",
      "-c",
      "user.email=openclaw@localhost",
      "-c",
      "commit.gpgSign=false",
      "commit-tree",
      tree,
    ],
    {
      input: Buffer.from(
        MARKER + JSON.stringify({ gitHistory: workerGitHistory, gitHistoryNote: note }) + "\n",
      ),
      baseEnv: {
        ...process.env,
        GIT_AUTHOR_NAME: "OpenClaw",
        GIT_COMMITTER_NAME: "OpenClaw",
        GIT_AUTHOR_EMAIL: "openclaw@localhost",
        GIT_COMMITTER_EMAIL: "openclaw@localhost",
        GIT_AUTHOR_DATE: "@0 +0000",
        GIT_COMMITTER_DATE: "@0 +0000",
      },
    },
  );
  const history = { parentCommit, ...(note ? { gitHistoryNote: note } : {}) };
  if (history.gitHistoryNote) {
    workspaceLog.info(history.gitHistoryNote);
  }
  let discardPromise: Promise<void> | undefined;
  const discard = () => {
    // These candidates are never recreated after preparation. Share completed
    // cleanup across publish/finally, but leave failed Git cleanup retryable.
    discardPromise ??= updateWorkspaceResultRefs(root, [
      { ref: candidateRef },
      { ref: companionCandidate },
    ]).catch((error: unknown) => {
      discardPromise = undefined;
      throw error;
    });
    return discardPromise;
  };
  try {
    const objectId = await workerWorkspaceResultStaging.stageWorkerWorkspaceResult({
      ...params,
      baseManifestRaw: originalBase.baseManifestRaw,
      baseManifestRef: originalBase.baseManifestRef,
      existingObjects,
      root,
      gitHistory: undefined,
      gitPackPath: undefined,
      parentCommit: history.parentCommit,
      stagedResultRef: candidateRef,
      assertCurrent: assertRevision,
    });
    assertRevision();
    let companionId: string | undefined;
    if (params.publicationStagingRoot || params.publicationDigest) {
      try {
        if (!params.publicationStagingRoot || !params.publicationDigest) {
          throw new Error("Repository publication checkpoint is incomplete");
        }
        const { publicationStagingRoot, publicationDigest, currentManifestRef } = params;
        assertRevision();
        const { raw: metadata, snapshot } = await readGitHubRepositoryPublicationMetadata(
          publicationStagingRoot,
          publicationDigest,
        );
        if (snapshot.baseCommit !== baseCommit) {
          throw new Error("Repository publication checkpoint base changed");
        }
        assertRevision();
        companionId = await workerWorkspaceResultStaging.stageWorkerWorkspaceResult({
          root,
          assertCurrent: assertRevision,
          stagedResultRef: companionCandidate,
          stagingRoot: publicationStagingRoot,
          publication: {
            metadata,
            publicationDigest,
            currentManifestRef,
            baseCommit,
          },
        });
      } catch (error) {
        // A rejected publication payload cannot discard independently validated
        // recovery bytes. Remove only its candidate, then recheck live authority.
        await deleteStagedWorkerWorkspaceResult({ root, stagedResultRef: companionCandidate });
        assertRevision();
        workspaceLog.warn(
          `Repository publication checkpoint unavailable: ${boundedWorkerError(error)}`,
        );
      }
    }
    const verify = async () => {
      const objects = (
        await requireWorkspaceResultGit(root, [
          "rev-parse",
          `${candidateRef}^{commit}`,
          ...(companionId ? [`${companionCandidate}^{commit}`] : []),
        ])
      ).split("\n");
      if (objects[0] !== objectId) {
        throw new Error("Repository checkpoint preparation changed");
      }
      if (companionId && objects[1] !== companionId) {
        throw new Error("Repository publication preparation changed");
      }
      assertRevision();
    };
    await verify();
    const publishArtifacts = (additionalRefs: readonly string[] = []) =>
      publishCheckpointRefs(
        root,
        workspace,
        objectId,
        companionId,
        [ref, ...additionalRefs],
        assertRevision,
      );
    return {
      checkpointRef: ref,
      verify,
      discard,
      publishArtifacts,
      publish: async () => {
        await publishArtifacts();
        // Publish immutable artifacts before the SQLite pointer: if the commit
        // fence fails or the Gateway exits, the pending turn can recover this ref.
        const published = await recoverSessionRepositoryCheckpoint({
          ...params,
          store,
          checkpointRef: ref,
        });
        await discard();
        return published;
      },
    };
  } catch (error) {
    await discard();
    throw error;
  }
}

export async function forkSessionRepositoryWorkspace(params: {
  branchPrefix?: string;
  runSetupScript?: boolean;
  /** Only supplied inside the fresh disk capture owner, while its quiescence is held. */
  diskExport?: { checkpointRef: string; verifyCurrent: () => Promise<void> };
  sourceWorkspaceId: string;
  agentId: string;
  sessionKey: string;
  assertCurrent: () => void;
  store?: SessionRepositoryWorkspaceStore;
}): Promise<SessionRepositoryWorkspaceRecord> {
  const store = params.store ?? getSessionRepositoryWorkspaceStore();
  const sourceContext = captureOpenClawStateWorkerContext({ path: store.path });
  const source = (await owner({ workspaceId: params.sourceWorkspaceId, store })).workspace;
  if (source.diskAuthority && !params.diskExport) {
    throw new Error(
      "Fork requires a fresh disk export; Move to Gateway before forking this workspace",
    );
  }
  const existing = await store.find(params);
  if (existing !== undefined) {
    throw new Error("Fork session already owns a repository workspace");
  }
  let allocatedWorkspaceId: string | undefined;
  try {
    // Git effects need the current parent predicates, not only later writer admission.
    const caller = await prepareSessionSourceAuthority(params.assertCurrent);
    await using callerScope = new AsyncDisposableStack();
    callerScope.defer(() => caller.release?.());
    const assertCurrent = () => {
      sourceContext.admission.assertCurrent();
      caller.assertCurrent();
    };
    let target = await store.create({
      ...params,
      url: source.url,
      requestedRef: source.requestedRef ?? undefined,
      runSetupScript: source.runSetupScript && params.runSetupScript !== false,
      assertCurrent,
    });
    allocatedWorkspaceId = target.workspaceId;
    assertCurrent();
    if (source.baseCommit) {
      target = await store.bindBase({
        workspaceId: target.workspaceId,
        expectedRevision: target.revision,
        baseCommit: source.baseCommit,
        baseManifestHash: source.baseManifestHash ?? undefined,
        assertCurrent,
      });
    }
    if (params.diskExport || source.checkpointRef) {
      target = await withSessionRepositoryCheckpoint(
        {
          workspaceId: source.workspaceId,
          store,
          checkpointRef: params.diskExport?.checkpointRef,
          requireGitHistory: Boolean(params.diskExport),
        },
        async (snapshot) => {
          const prepared = await stageSessionRepositoryCheckpoint({
            ...snapshot,
            store,
            workspaceId: target.workspaceId,
            expectedRevision: target.revision,
            requireGitHistory: Boolean(params.diskExport),
            assertCurrent,
          });
          try {
            return await prepared.publish();
          } finally {
            await prepared.discard();
          }
        },
      );
    }
    await params.diskExport?.verifyCurrent();
    assertCurrent();
    return target;
  } catch (error) {
    // This unexposed owner belongs exclusively to this failed fork operation.
    if (allocatedWorkspaceId) {
      await store.delete({
        workspaceId: allocatedWorkspaceId,
        assertCurrent: () => sourceContext.admission.assertCurrent(),
      });
    }
    throw error;
  }
}
