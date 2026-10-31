import { hasGitWorkerContext } from "../../infra/git-worker-context.js";
import type { GitWorkerCommand } from "../../infra/git-worker-contract.js";
import { runGitWorkerOperation, type GitWorkerOperationOptions } from "../../infra/git-worker.js";
import type { readActualWorkspaceManifestImpl } from "./workspace-actual-manifest.js";
import { activeWorkspaceHashContext, pruneWorkspaceHashMemo } from "./workspace-hash-memo.js";
import type {
  WorkspaceComputationHashes,
  WorkspaceComputationHashResult,
  WorkspaceManifestComputationCommand,
  WorkspaceManifestComputationOperations,
  WorkspaceManifestValueInputs,
  WorkspaceStageInput,
} from "./workspace-manifest-computation.js";
import type {
  WorkerWorkspaceManifest,
  WorkerWorkspaceManifestEntry,
} from "./workspace-manifest.js";
import { joinStagedWorkspaceManifestRead } from "./workspace-result-git.js";
import {
  resolveStagedWorkspaceReadEntry,
  stagedWorkspaceEntryBytes,
  STAGED_WORKSPACE_READ_MAX_BYTES,
  STAGED_WORKSPACE_READ_MAX_ENTRIES,
  type StagedWorkerWorkspaceInventory,
  type StagedWorkerWorkspaceReadEntry,
} from "./workspace-result-inventory.js";

type WorkspaceCaptureArguments = Parameters<typeof readActualWorkspaceManifestImpl>[0];

function computationInputBytes(input: unknown): number {
  if (typeof input === "string") {
    return input.length * 2;
  }
  if (ArrayBuffer.isView(input)) {
    return input.byteLength;
  }
  if (input && typeof input === "object") {
    return Object.entries(input).reduce(
      (bytes, [key, value]) => bytes + key.length * 2 + computationInputBytes(value),
      64,
    );
  }
  return 8;
}

function transferableManifestInput(command: GitWorkerCommand): ArrayBuffer[] {
  if ("payload" in command.input) {
    return [command.input.payload.buffer];
  }
  switch (command.type) {
    case "workspace.manifest.local":
      return [command.input.snapshot.buffer];
    case "workspace.manifest.paths":
    case "workspace.manifest.parse":
      return [command.input.raw.buffer];
    case "workspace.manifest.base-refresh":
      return [command.input.baseRaw.buffer];
    case "workspace.manifest.equal":
    case "workspace.manifest.pair":
      return [command.input.baseRaw.buffer, command.input.currentRaw.buffer];
    case "workspace.manifest.stage-input":
      return "publication" in command.input
        ? [command.input.publication.metadata.buffer]
        : [command.input.baseManifestRaw.buffer, command.input.currentManifestRaw.buffer];
    default:
      return [];
  }
}

export async function computeWorkspaceManifest<Command extends WorkspaceManifestComputationCommand>(
  command: Command,
  signal?: AbortSignal,
  git?: GitWorkerOperationOptions["git"],
): Promise<WorkspaceManifestComputationOperations[Command["type"]]["output"]> {
  if (hasGitWorkerContext()) {
    const { executeWorkspaceManifestComputation } =
      await import("./workspace-manifest-computation.runtime.js");
    return await executeWorkspaceManifestComputation(command);
  }
  return await runGitWorkerOperation(command, {
    signal,
    git,
    inputBytes: 256 + computationInputBytes(command.input),
    transferList: transferableManifestInput,
  });
}

function computeValue<Type extends keyof WorkspaceManifestValueInputs>(
  type: Type,
  input: WorkspaceManifestValueInputs[Type],
  signal?: AbortSignal,
): Promise<WorkspaceManifestComputationOperations[Type]["output"]>;
async function computeValue(
  type: keyof WorkspaceManifestValueInputs,
  input: WorkspaceManifestValueInputs[keyof WorkspaceManifestValueInputs],
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  return computeWorkspaceManifest(
    { type, input: { payload: new TextEncoder().encode(JSON.stringify(input)) } },
    signal,
  );
}

function captureHashes(includeMemo = true) {
  const context = activeWorkspaceHashContext();
  if (context && includeMemo) {
    pruneWorkspaceHashMemo(context.memo);
  }
  const hashes: WorkspaceComputationHashes | undefined = context
    ? { owner: context.owner, entries: includeMemo ? [...context.memo] : [] }
    : undefined;
  return {
    hashes,
    accept<Result extends WorkspaceComputationHashResult<unknown>>(
      result: Result,
    ): Result["value"] {
      if (context) {
        for (const [identity, digest] of result.hashes) {
          context.memo.set(identity, digest);
        }
        pruneWorkspaceHashMemo(context.memo);
        if (context.metrics) {
          context.metrics.contentHashCount += result.metrics.contentHashCount;
          context.metrics.memoHitCount += result.metrics.memoHitCount;
        }
      }
      return result.value;
    },
  };
}

type WorkspaceCaptureCommand =
  | "workspace.manifest.capture"
  | "workspace.manifest.snapshot"
  | "workspace.manifest.document"
  | "workspace.manifest.reference";

function captureWorkspace<Type extends WorkspaceCaptureCommand>(
  type: Type,
  params: WorkspaceCaptureArguments,
): Promise<WorkspaceManifestComputationOperations[Type]["output"]["value"]>;
async function captureWorkspace(type: WorkspaceCaptureCommand, params: WorkspaceCaptureArguments) {
  const { root, baseCommit, preserveDirectories, includePaths, buildCacheInputs, signal } = params;
  if (hasGitWorkerContext()) {
    const { readActualWorkspaceManifestImpl } = await import("./workspace-actual-manifest.js");
    const snapshot = await readActualWorkspaceManifestImpl(params);
    if (type === "workspace.manifest.document") {
      const { manifestRef, rawManifest } = snapshot;
      return { manifestRef, rawManifest };
    }
    return type === "workspace.manifest.reference"
      ? snapshot.manifestRef
      : type === "workspace.manifest.snapshot"
        ? snapshot
        : { manifest: snapshot.manifest, manifestRef: snapshot.manifestRef };
  }
  signal?.throwIfAborted();
  const hashes = captureHashes();
  return hashes.accept(
    await computeValue(
      type,
      {
        root,
        baseCommit,
        includePaths: includePaths === undefined ? undefined : [...includePaths],
        buildCacheInputs: buildCacheInputs === undefined ? undefined : [...buildCacheInputs],
        preserveDirectories:
          preserveDirectories === undefined ? undefined : [...preserveDirectories],
        hashes: hashes.hashes,
      },
      signal,
    ),
  );
}

export async function captureWorkspaceManifest(params: WorkspaceCaptureArguments) {
  return await captureWorkspace("workspace.manifest.capture", params);
}

export async function captureWorkspaceSnapshot(params: WorkspaceCaptureArguments) {
  return await captureWorkspace("workspace.manifest.snapshot", params);
}

/** Keep complete source inventories in the worker; only the staged document returns. */
export async function prepareWorkspaceBaseRefresh(
  input: Omit<
    WorkspaceManifestComputationOperations["workspace.manifest.base-refresh"]["input"],
    "baseRaw" | "hashes"
  > & { baseRaw: string },
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const hashes = captureHashes();
  return hashes.accept(
    await computeWorkspaceManifest(
      {
        type: "workspace.manifest.base-refresh",
        input: {
          ...input,
          baseRaw: new TextEncoder().encode(input.baseRaw),
          hashes: hashes.hashes,
        },
      },
      signal,
    ),
  );
}

export async function workspaceSnapshotsEqual(
  left: { rawManifest: string; manifestRef: string },
  right: { rawManifest: string; manifestRef: string },
  buildCacheInputs?: string[],
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const encoder = new TextEncoder();
  return await computeWorkspaceManifest(
    {
      type: "workspace.manifest.equal",
      input: {
        baseRaw: encoder.encode(left.rawManifest),
        baseRef: left.manifestRef,
        currentRaw: encoder.encode(right.rawManifest),
        currentRef: right.manifestRef,
        buildCacheInputs,
      },
    },
    signal,
  );
}

export async function captureWorkspaceManifestDocument(params: WorkspaceCaptureArguments) {
  return await captureWorkspace("workspace.manifest.document", params);
}

export async function captureWorkspaceManifestReference(params: WorkspaceCaptureArguments) {
  return await captureWorkspace("workspace.manifest.reference", params);
}

export async function preflightWorkspaceApply(
  params: Omit<WorkspaceManifestValueInputs["workspace.reconcile.preflight"], "hashes"> & {
    signal?: AbortSignal;
  },
) {
  const { signal, ...input } = params;
  if (hasGitWorkerContext()) {
    const { preflightWorkspaceApplyImpl } = await import("./workspace-reconcile-preflight.js");
    return await preflightWorkspaceApplyImpl(input);
  }
  signal?.throwIfAborted();
  const hashes = captureHashes();
  return hashes.accept(
    await computeValue(
      "workspace.reconcile.preflight",
      { ...input, hashes: hashes.hashes },
      signal,
    ),
  );
}

export async function computeWorkspaceFileSnapshot(path: string, maxBytes: number, root?: string) {
  if (hasGitWorkerContext()) {
    const { readWorkspaceFileSnapshotWithLimit } = await import("./workspace-actual-manifest.js");
    return await readWorkspaceFileSnapshotWithLimit(path, maxBytes, root);
  }
  // Bulk capture/preflight carries the memo once. A single verification must not
  // clone a placement's complete cache for every file it observes.
  const hashes = captureHashes(false);
  return hashes.accept(
    await computeValue("workspace.manifest.file", { path, maxBytes, root, hashes: hashes.hashes }),
  );
}

export async function readWorkspaceNodes(root: string, paths: string[]) {
  const hashes = captureHashes();
  return new Map(
    hashes.accept(
      await computeValue("workspace.manifest.nodes", { root, paths, hashes: hashes.hashes }),
    ),
  );
}

export async function decodeWorkspaceManifest(
  raw: string,
  expectedRef?: string,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const bytes = new TextEncoder().encode(raw);
  return await computeWorkspaceManifest(
    { type: "workspace.manifest.parse", input: { raw: bytes, expectedRef } },
    signal,
  );
}

export async function workspaceManifestPaths(
  document: { rawManifest: string; manifestRef: string },
  buildCacheInputs: string[],
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  return await computeWorkspaceManifest(
    {
      type: "workspace.manifest.paths",
      input: {
        raw: new TextEncoder().encode(document.rawManifest),
        expectedRef: document.manifestRef,
        buildCacheInputs,
      },
    },
    signal,
  );
}

export async function serializeWorkspaceManifest(
  manifest: WorkerWorkspaceManifest,
  signal?: AbortSignal,
) {
  return await computeValue("workspace.manifest.serialize", { manifest }, signal);
}

export async function overlayWorkspaceManifest(
  source: WorkerWorkspaceManifest,
  prepared: WorkerWorkspaceManifest,
  incoming: WorkerWorkspaceManifest,
  signal?: AbortSignal,
) {
  return await computeValue("workspace.manifest.overlay", { source, prepared, incoming }, signal);
}

export async function parseWorkspaceManifestPair(input: {
  buildCacheInputs?: string[];
  baseRaw: string;
  baseRef: string;
  currentRaw: string;
  currentRef: string;
}) {
  const encoder = new TextEncoder();
  return await computeWorkspaceManifest({
    type: "workspace.manifest.pair",
    input: {
      baseRef: input.baseRef,
      currentRef: input.currentRef,
      buildCacheInputs: input.buildCacheInputs,
      baseRaw: encoder.encode(input.baseRaw),
      currentRaw: encoder.encode(input.currentRaw),
    },
  });
}

export async function loadStagedWorkspaceManifest(
  root: string,
  ref: string,
  signal?: AbortSignal,
  buildCacheInputs?: string[],
) {
  const input = { root, ref, buildCacheInputs };
  const read = () => computeWorkspaceManifest({ type: "workspace.manifest.staged", input }, signal);
  // A worker's host exchange context owns its policy and authority independently.
  return hasGitWorkerContext()
    ? await read()
    : await joinStagedWorkspaceManifestRead(input, signal, read);
}

export async function* readStagedWorkspaceManifestEntries(input: {
  root: string;
  entries: readonly WorkerWorkspaceManifestEntry[];
  objectsByPath: StagedWorkerWorkspaceInventory["objectsByPath"];
}) {
  let nextEntry = 0;
  while (nextEntry < input.entries.length) {
    const entries: StagedWorkerWorkspaceReadEntry[] = [];
    let bytes = 0;
    while (nextEntry < input.entries.length) {
      const entry = input.entries[nextEntry]!;
      const entryBytes = stagedWorkspaceEntryBytes(entry);
      if (
        entries.length > 0 &&
        (entries.length === STAGED_WORKSPACE_READ_MAX_ENTRIES ||
          bytes + entryBytes > STAGED_WORKSPACE_READ_MAX_BYTES)
      ) {
        break;
      }
      entries.push(resolveStagedWorkspaceReadEntry(input.objectsByPath, entry));
      bytes += entryBytes;
      nextEntry++;
    }
    const contents = await computeWorkspaceManifest({
      type: "workspace.manifest.entries",
      input: { root: input.root, entries },
    });
    let offset = 0;
    for (const { entry } of entries) {
      const content =
        entry.type === "file" ? contents.subarray(offset, offset + entry.size) : undefined;
      offset += entry.type === "file" ? entry.size : 0;
      yield { entry, content };
    }
  }
}

export async function prepareWorkspaceStageInput(input: WorkspaceStageInput<string>) {
  const encoder = new TextEncoder();
  return await computeWorkspaceManifest({
    type: "workspace.manifest.stage-input",
    input: {
      inputPath: input.inputPath,
      stagingRoot: input.stagingRoot,
      stagedResultRef: input.stagedResultRef,
      buildCacheInputs: input.buildCacheInputs,
      gitHistory: input.gitHistory,
      parentCommit: input.parentCommit,
      ...("publication" in input
        ? {
            publication: {
              ...input.publication,
              metadata: encoder.encode(input.publication.metadata),
            },
          }
        : {
            baseManifestRef: input.baseManifestRef,
            currentManifestRef: input.currentManifestRef,
            baseManifestRaw: encoder.encode(input.baseManifestRaw),
            currentManifestRaw: encoder.encode(input.currentManifestRaw),
            existingObjects: input.existingObjects,
          }),
    },
  });
}

export async function prepareWorkspaceTreeInput(
  input: WorkspaceManifestValueInputs["workspace.manifest.tree-input"],
): Promise<null> {
  return computeValue("workspace.manifest.tree-input", input);
}
