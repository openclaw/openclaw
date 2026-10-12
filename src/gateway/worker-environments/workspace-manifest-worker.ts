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
    case "workspace.manifest.parse":
      return [command.input.raw.buffer];
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
  return await computeWorkspaceManifest(
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
    accept<T>(result: WorkspaceComputationHashResult<T>): T {
      if (context) {
        for (const [identity, digest] of result.hashes) {
          context.memo.set(identity, digest);
        }
        pruneWorkspaceHashMemo(context.memo);
        if (context.metrics) {
          context.metrics.contentHashCount += result.metrics.contentHashCount;
          context.metrics.contentHashDurationMs += result.metrics.contentHashDurationMs;
          context.metrics.memoHitCount += result.metrics.memoHitCount;
        }
      }
      return result.value;
    },
  };
}

type WorkspaceCaptureCommand = "workspace.manifest.capture" | "workspace.manifest.snapshot";

function captureWorkspace<Type extends WorkspaceCaptureCommand>(
  type: Type,
  params: WorkspaceCaptureArguments,
): Promise<WorkspaceManifestComputationOperations[Type]["output"]["value"]>;
async function captureWorkspace(type: WorkspaceCaptureCommand, params: WorkspaceCaptureArguments) {
  const { root, baseCommit, preserveDirectories, includePaths, signal } = params;
  if (hasGitWorkerContext()) {
    const { readActualWorkspaceManifestImpl } = await import("./workspace-actual-manifest.js");
    const snapshot = await readActualWorkspaceManifestImpl(params);
    return type === "workspace.manifest.snapshot"
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

export async function preflightWorkspaceApply(
  params: Omit<WorkspaceManifestValueInputs["workspace.reconcile.preflight"], "hashes"> & {
    signal?: AbortSignal;
  },
) {
  const { root, base, current, signal } = params;
  const input = { root, base, current };
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

export async function computeWorkspaceFileSnapshot(
  path: string,
  maxBytes: number,
  root?: string,
  signal?: AbortSignal,
) {
  if (hasGitWorkerContext()) {
    const { readWorkspaceFileSnapshotWithLimit } = await import("./workspace-actual-manifest.js");
    return await readWorkspaceFileSnapshotWithLimit(path, maxBytes, root, signal);
  }
  // Bulk capture/preflight carries the memo once. A single verification must not
  // clone a placement's complete cache for every file it observes.
  signal?.throwIfAborted();
  const hashes = captureHashes(false);
  return hashes.accept(
    await computeValue(
      "workspace.manifest.file",
      { path, maxBytes, root, hashes: hashes.hashes },
      signal,
    ),
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

export async function parseWorkspaceManifestPair(
  input: { baseRaw: string; baseRef: string; currentRaw: string; currentRef: string },
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const encoder = new TextEncoder();
  return await computeWorkspaceManifest(
    {
      type: "workspace.manifest.pair",
      input: {
        baseRef: input.baseRef,
        currentRef: input.currentRef,
        baseRaw: encoder.encode(input.baseRaw),
        currentRaw: encoder.encode(input.currentRaw),
      },
    },
    signal,
  );
}

export async function loadStagedWorkspaceManifest(root: string, ref: string, signal?: AbortSignal) {
  return await computeWorkspaceManifest(
    { type: "workspace.manifest.staged", input: { root, ref } },
    signal,
  );
}

export async function* readStagedWorkspaceManifestEntries(
  input: {
    root: string;
    entries: readonly WorkerWorkspaceManifestEntry[];
    objectsByPath: StagedWorkerWorkspaceInventory["objectsByPath"];
  },
  signal?: AbortSignal,
) {
  let nextEntry = 0;
  while (nextEntry < input.entries.length) {
    signal?.throwIfAborted();
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
    const contents = await computeWorkspaceManifest(
      { type: "workspace.manifest.entries", input: { root: input.root, entries } },
      signal,
    );
    let offset = 0;
    for (const { entry } of entries) {
      signal?.throwIfAborted();
      const content =
        entry.type === "file" ? contents.subarray(offset, offset + entry.size) : undefined;
      offset += entry.type === "file" ? entry.size : 0;
      yield { entry, content };
    }
  }
}

export async function prepareWorkspaceStageInput(
  input: WorkspaceStageInput<string>,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const encoder = new TextEncoder();
  return await computeWorkspaceManifest(
    {
      type: "workspace.manifest.stage-input",
      input: {
        inputPath: input.inputPath,
        stagingRoot: input.stagingRoot,
        stagedResultRef: input.stagedResultRef,
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
            }),
      },
    },
    signal,
  );
}

export async function prepareWorkspaceTreeInput(
  input: WorkspaceManifestValueInputs["workspace.manifest.tree-input"],
): Promise<null> {
  return await computeValue("workspace.manifest.tree-input", input);
}
