import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { runGitWorkerOperation } from "../../infra/git-worker.js";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { runExec, spawnCommand } from "../../process/exec.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import {
  getSessionRepositoryWorkspaceStore,
  type SessionRepositoryWorkspaceStore,
} from "../../state/session-repository-workspaces.js";
import type { SessionRepositoryWorkspaceRecord } from "../../state/session-repository-workspaces.types.js";
import { MAX_WORKSPACE_RESULT_GIT_PACK_BYTES } from "../../worker/node-workspace-transfer-protocol.js";
import { readGitHubRepositoryPublicationMetadata } from "../github-repository-publication-snapshot.js";
import { boundedWorkerError } from "./worker-error.js";
import { parseWorkspaceManifestPair } from "./workspace-manifest-worker.js";
import {
  requireWorkspaceResultGit,
  requireWorkspaceResultGit as git,
  updateWorkspaceResultRefs,
  withWorkspaceResultRefMutation,
  workspaceResultCheckpointInitArgs,
  workspaceResultGitCommand,
  WORKSPACE_RESULT_GIT_TIMEOUT_MS,
} from "./workspace-result-git.js";
import { workerHistoryNotAdopted } from "./workspace-result-history.js";
import {
  WorkerWorkspaceGitHistorySchema,
  type WorkerWorkspaceGitHistory,
  type StagedWorkerArtifactInventory,
} from "./workspace-result-inventory.js";
import {
  deleteStagedWorkerWorkspaceResult,
  preparedWorkerWorkspaceResultRef,
  readStagedWorkerWorkspaceResult,
  withStagedWorkerWorkspaceResult,
  workerWorkspaceResultRef,
  workerWorkspaceResultStaging,
} from "./workspace-result-staging.js";

const MARKER = "OpenClaw repository Git delta\n";
type RepositoryGitHistory = {
  gitHistory?: WorkerWorkspaceGitHistory;
  gitPackPath?: string;
  gitHistoryNote?: string;
};

type CheckpointOwner = { workspaceId: string; store?: SessionRepositoryWorkspaceStore };
type CheckpointSource = CheckpointOwner & { checkpointRef?: string };
type CheckpointSnapshot = Awaited<ReturnType<typeof readStagedWorkerWorkspaceResult>>;
export type SessionRepositoryCheckpointPayload = CheckpointSnapshot &
  RepositoryGitHistory & {
    stagingRoot: string;
    publicationStagingRoot?: string;
    publicationDigest?: string;
  };
const publicationRef = (ref: string) =>
  workerWorkspaceResultRef(`publication-${createHash("sha256").update(ref).digest("hex")}`);
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

function checkpointRef(workspace: SessionRepositoryWorkspaceRecord, ref?: string): string {
  const selected = ref ?? workspace.checkpointRef;
  if (!selected || !/^refs\/openclaw\/worker-results\/[A-Za-z0-9-]+$/u.test(selected)) {
    throw new Error("Repository workspace has no valid checkpoint");
  }
  return selected;
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

async function refObjects(
  root: string,
  refs: readonly string[],
  baseEnv?: NodeJS.ProcessEnv,
): Promise<Map<string, string>> {
  const output = await requireWorkspaceResultGit(
    root,
    ["for-each-ref", "--format=%(refname) %(objectname)", ...refs],
    { baseEnv },
  );
  const objects = new Map<string, string>();
  for (const line of output.split("\n")) {
    const separator = line.indexOf(" ");
    const ref = line.slice(0, separator);
    if (refs.includes(ref)) {
      objects.set(ref, line.slice(separator + 1));
    }
  }
  return objects;
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
  params: CheckpointSource,
  use: (snapshot: SessionRepositoryCheckpointPayload) => Promise<T>,
): Promise<T> {
  const { workspace, root } = await owner(params);
  const ref = checkpointRef(workspace, params.checkpointRef);
  return await withStagedWorkerWorkspaceResult({ root, stagedResultRef: ref }, async (files) => {
    const historyReadInput = { root, checkpointRef: ref, baseCommit: assertBase(workspace, files) };
    let directory: string | undefined;
    let retained: RepositoryGitHistory = {};
    try {
      try {
        const parents = (
          await git(historyReadInput.root, [
            "rev-list",
            "--parents",
            "-n",
            "1",
            historyReadInput.checkpointRef,
          ])
        ).split(" ");
        if (parents.length === 1) {
          retained = {
            gitHistoryNote: workerHistoryNotAdopted("checkpoint has no retained Git history"),
          };
        } else {
          const parent = parents[1]!;
          const message = await git(historyReadInput.root, ["show", "-s", "--format=%B", parent]);
          if (!message.startsWith(MARKER)) {
            throw new Error("repository Git history metadata is missing");
          }
          const record: unknown = JSON.parse(message.slice(MARKER.length));
          if (!isRecord(record)) {
            throw new Error("repository Git history metadata is invalid");
          }
          const retainedGitHistory =
            record.gitHistory === undefined
              ? undefined
              : WorkerWorkspaceGitHistorySchema.parse(record.gitHistory);
          if (retainedGitHistory && retainedGitHistory.baseCommit !== historyReadInput.baseCommit) {
            throw new Error("repository Git history base changed");
          }
          if (typeof record.gitHistoryNote === "string") {
            retained = { gitHistory: retainedGitHistory, gitHistoryNote: record.gitHistoryNote };
          } else if (
            retainedGitHistory &&
            retainedGitHistory.headCommit !== retainedGitHistory.baseCommit
          ) {
            const object = `${parent}:history.pack`;
            const size = Number(await git(historyReadInput.root, ["cat-file", "-s", object]));
            if (!Number.isSafeInteger(size) || size > MAX_WORKSPACE_RESULT_GIT_PACK_BYTES) {
              throw new Error("retained Git pack exceeds its byte limit");
            }
            directory = await fs.mkdtemp(
              path.join(resolvePreferredOpenClawTmpDir(), "repository-history-"),
            );
            const gitPackPath = path.join(directory, "history.pack");
            await spawnCommand(
              workspaceResultGitCommand(historyReadInput.root, ["cat-file", "blob", object]),
              {
                stdout: { file: gitPackPath },
                executionTimeoutMs: WORKSPACE_RESULT_GIT_TIMEOUT_MS,
              },
            );
            retained = { gitHistory: retainedGitHistory, gitPackPath };
          }
        }
      } catch (error) {
        retained = { gitHistoryNote: workerHistoryNotAdopted(boundedWorkerError(error)) };
      }
      const history = retained;
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
        if (!(await refObjects(root, [companion])).get(companion)) {
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
    } finally {
      if (directory) {
        await fs.rm(directory, { recursive: true, force: true });
      }
    }
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
  const baseCommit = assertBase(workspace, {
    base,
    current,
    baseManifestRef: params.baseManifestRef,
  });
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
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  assertRevision();
  await requireWorkspaceResultGit(root, workspaceResultCheckpointInitArgs());
  assertRevision();
  /** The checkpoint owns this synthetic parent; the pack stays opaque until a base is fetched. */
  const historyInput = {
    ...params,
    root,
    baseCommit,
    assertCurrent: assertRevision,
  };
  const workerGitHistory = historyInput.gitHistory;
  let note = historyInput.gitHistoryNote;
  let blob: string | undefined;
  if (!note) {
    if (!workerGitHistory) {
      note = workerHistoryNotAdopted("worker did not provide Git history");
    } else if (workerGitHistory.baseCommit !== historyInput.baseCommit) {
      note = workerHistoryNotAdopted("worker history does not descend from the dispatch base");
    } else if (workerGitHistory.unavailableReason) {
      note = workerHistoryNotAdopted(workerGitHistory.unavailableReason);
    } else if (!workerGitHistory.descendsFromBase) {
      note = workerHistoryNotAdopted("worker history does not descend from the dispatch base");
    } else if (workerGitHistory.headCommit !== workerGitHistory.baseCommit) {
      try {
        if (!historyInput.gitPackPath) {
          throw new Error("worker Git history has no pack");
        }
        const pack = await fs.open(
          historyInput.gitPackPath,
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        try {
          const stat = await pack.stat();
          if (!stat.isFile() || stat.size > MAX_WORKSPACE_RESULT_GIT_PACK_BYTES) {
            throw new Error("worker Git pack exceeds its byte limit");
          }
          historyInput.assertCurrent();
          blob = (
            await runExec(
              "git",
              workspaceResultGitCommand(historyInput.root, ["hash-object", "-w", "--stdin"]).slice(
                1,
              ),
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
        historyInput.assertCurrent();
        note = workerHistoryNotAdopted(boundedWorkerError(error));
      }
    }
  }
  historyInput.assertCurrent();
  const tree = await git(historyInput.root, ["mktree"], {
    input: Buffer.from(blob ? `100644 blob ${blob}\thistory.pack\n` : ""),
  });
  historyInput.assertCurrent();
  const parentCommit = await git(
    historyInput.root,
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
    return {
      checkpointRef: ref,
      verify,
      discard,
      publish: async () => {
        await withWorkspaceResultRefMutation(root, async (baseEnv) => {
          const updates: string[] = [];
          const targets = [
            [ref, objectId],
            [publicationRef(ref), companionId],
          ] as const;
          const existingObjects = await refObjects(
            root,
            targets.map(([target]) => target),
            baseEnv,
          );
          for (const [target, expected] of targets) {
            const existing = existingObjects.get(target);
            if (existing !== undefined && existing !== expected) {
              throw new Error("Repository checkpoint identity already contains a different result");
            }
            if (expected !== undefined && existing === undefined) {
              updates.push(`create ${target}\0${expected}\0`);
            }
          }
          assertRevision();
          if (updates.length) {
            await requireWorkspaceResultGit(root, ["update-ref", "--stdin", "-z"], {
              input: Buffer.from(updates.join("")),
              baseEnv,
              beforeInput: assertRevision,
            });
          }
        });
        // Publish immutable artifacts before the SQLite pointer: if the commit
        // fence fails or the Gateway exits, the pending turn can recover this ref.
        const accepted = await recoverSessionRepositoryCheckpoint({
          ...params,
          store,
          checkpointRef: ref,
        });
        await discard();
        return accepted;
      },
    };
  } catch (error) {
    await discard();
    throw error;
  }
}

export async function forkSessionRepositoryWorkspace(params: {
  sourceWorkspaceId: string;
  agentId: string;
  sessionKey: string;
  assertCurrent: () => void;
  store?: SessionRepositoryWorkspaceStore;
}): Promise<SessionRepositoryWorkspaceRecord> {
  const store = params.store ?? getSessionRepositoryWorkspaceStore();
  const sourceContext = captureOpenClawStateWorkerContext({ path: store.path });
  const assertCurrent = () => {
    sourceContext.admission.assertCurrent();
    params.assertCurrent();
  };
  const source = (await owner({ workspaceId: params.sourceWorkspaceId, store })).workspace;
  const existing = await store.find(params);
  if (existing !== undefined) {
    throw new Error("Fork session already owns a repository workspace");
  }
  let target = await store.create({
    ...params,
    url: source.url,
    requestedRef: source.requestedRef ?? undefined,
    runSetupScript: source.runSetupScript,
    assertCurrent,
  });
  try {
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
    if (source.checkpointRef) {
      target = await withSessionRepositoryCheckpoint(
        { workspaceId: source.workspaceId, store },
        async (snapshot) => {
          const prepared = await stageSessionRepositoryCheckpoint({
            ...snapshot,
            store,
            workspaceId: target.workspaceId,
            expectedRevision: target.revision,
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
    assertCurrent();
    return target;
  } catch (error) {
    // This unexposed owner belongs exclusively to this failed fork operation.
    await store.delete({
      workspaceId: target.workspaceId,
      assertCurrent: () => sourceContext.admission.assertCurrent(),
    });
    throw error;
  }
}
