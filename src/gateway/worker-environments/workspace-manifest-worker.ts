import { hasGitWorkerContext } from "../../infra/git-worker-context.js";
import type { GitWorkerCommand } from "../../infra/git-worker-contract.js";
import { runGitWorkerOperation } from "../../infra/git-worker.js";
import { activeWorkspaceHashContext, pruneWorkspaceHashMemo } from "./workspace-hash-memo.js";
import type {
  WorkspaceComputationHashes,
  WorkspaceComputationHashResult,
  WorkspaceManifestComputationCommand,
  WorkspaceManifestComputationOperations,
  WorkspaceManifestValueInputs,
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

function encodeManifestValue(
  input: WorkspaceManifestValueInputs[keyof WorkspaceManifestValueInputs],
) {
  return { payload: new TextEncoder().encode(JSON.stringify(input)) };
}

type WorkspaceCaptureArguments = Omit<
  WorkspaceManifestValueInputs["workspace.manifest.capture"],
  "hashes" | "includePaths" | "preserveDirectories"
> & {
  includePaths?: ReadonlySet<string>;
  preserveDirectories?: ReadonlySet<string>;
  signal?: AbortSignal;
};

function computationInputBytes(command: WorkspaceManifestComputationCommand): number {
  const bytes = 256;
  switch (command.type) {
    case "workspace.manifest.capture":
    case "workspace.manifest.snapshot":
    case "workspace.manifest.file":
    case "workspace.manifest.nodes":
      return bytes + command.input.payload.byteLength;
    case "workspace.manifest.parse":
      return bytes + command.input.raw.byteLength;
    case "workspace.manifest.pair":
      return bytes + command.input.baseRaw.byteLength + command.input.currentRaw.byteLength;
    case "workspace.manifest.stage-input":
      return (
        bytes +
        command.input.baseManifestRaw.byteLength +
        command.input.currentManifestRaw.byteLength
      );
    case "workspace.manifest.serialize":
    case "workspace.reconcile.preflight":
    case "workspace.manifest.overlay":
    case "workspace.manifest.tree-input":
      return bytes + command.input.payload.byteLength;
    case "workspace.manifest.staged":
      return bytes + (command.input.root.length + command.input.ref.length) * 2;
    case "workspace.manifest.entries":
      return (
        bytes +
        command.input.root.length * 2 +
        command.input.entries.reduce(
          (total, { object, entry }) =>
            total +
            (object.objectId.length + object.mode.length + entry.path.length) * 2 +
            (entry.type === "symlink" ? entry.target.length * 2 : 128),
          0,
        )
      );
  }
  command satisfies never;
  throw new Error("Unsupported workspace computation");
}

function transferableManifestInput(command: GitWorkerCommand): ArrayBuffer[] {
  switch (command.type) {
    case "workspace.manifest.capture":
    case "workspace.manifest.snapshot":
    case "workspace.manifest.file":
    case "workspace.manifest.nodes":
      return [command.input.payload.buffer];
    case "workspace.manifest.parse":
      return [command.input.raw.buffer];
    case "workspace.manifest.pair":
      return [command.input.baseRaw.buffer, command.input.currentRaw.buffer];
    case "workspace.manifest.stage-input":
      return [command.input.baseManifestRaw.buffer, command.input.currentManifestRaw.buffer];
    case "workspace.manifest.serialize":
    case "workspace.reconcile.preflight":
    case "workspace.manifest.overlay":
    case "workspace.manifest.tree-input":
      return [command.input.payload.buffer];
    default:
      return [];
  }
}

async function compute<Command extends WorkspaceManifestComputationCommand>(
  command: Command,
  signal?: AbortSignal,
): Promise<WorkspaceManifestComputationOperations[Command["type"]]["output"]> {
  if (hasGitWorkerContext()) {
    const { executeWorkspaceManifestComputation } =
      await import("./workspace-manifest-computation.runtime.js");
    return await executeWorkspaceManifestComputation(command);
  }
  return await runGitWorkerOperation(command, {
    signal,
    inputBytes: computationInputBytes(command),
    transferList: transferableManifestInput,
  });
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
  const input = { root, baseCommit, preserveDirectories, includePaths };
  if (hasGitWorkerContext()) {
    const { readActualWorkspaceManifestImpl } = await import("./workspace-actual-manifest.js");
    const snapshot = await readActualWorkspaceManifestImpl({ ...input, signal });
    return type === "workspace.manifest.snapshot"
      ? snapshot
      : { manifest: snapshot.manifest, manifestRef: snapshot.manifestRef };
  }
  signal?.throwIfAborted();
  const hashes = captureHashes();
  return hashes.accept(
    await compute(
      {
        type,
        input: encodeManifestValue({
          root,
          baseCommit,
          includePaths: includePaths === undefined ? undefined : [...includePaths],
          preserveDirectories:
            preserveDirectories === undefined ? undefined : [...preserveDirectories],
          hashes: hashes.hashes,
        }),
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
    await compute(
      {
        type: "workspace.reconcile.preflight",
        input: encodeManifestValue({ ...input, hashes: hashes.hashes }),
      },
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
    await compute(
      {
        type: "workspace.manifest.file",
        input: encodeManifestValue({ path, maxBytes, root, hashes: hashes.hashes }),
      },
      signal,
    ),
  );
}

export async function readWorkspaceNodes(root: string, paths: string[]) {
  const hashes = captureHashes();
  return new Map(
    hashes.accept(
      await compute({
        type: "workspace.manifest.nodes",
        input: encodeManifestValue({ root, paths, hashes: hashes.hashes }),
      }),
    ),
  );
}

export async function parseWorkspaceManifest(
  raw: string,
  expectedRef: string,
  signal?: AbortSignal,
) {
  return (await decodeWorkspaceManifest(raw, expectedRef, signal)).manifest;
}

export async function decodeWorkspaceManifest(
  raw: string,
  expectedRef?: string,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const bytes = new TextEncoder().encode(raw);
  return await compute(
    { type: "workspace.manifest.parse", input: { raw: bytes, expectedRef } },
    signal,
  );
}

export async function serializeWorkspaceManifest(
  manifest: WorkerWorkspaceManifest,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  return await compute(
    { type: "workspace.manifest.serialize", input: encodeManifestValue({ manifest }) },
    signal,
  );
}

export async function overlayWorkspaceManifest(
  source: WorkerWorkspaceManifest,
  prepared: WorkerWorkspaceManifest,
  incoming: WorkerWorkspaceManifest,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  return await compute(
    {
      type: "workspace.manifest.overlay",
      input: encodeManifestValue({ source, prepared, incoming }),
    },
    signal,
  );
}

export async function parseWorkspaceManifestPair(
  input: { baseRaw: string; baseRef: string; currentRaw: string; currentRef: string },
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const encoder = new TextEncoder();
  return await compute(
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
  return await compute({ type: "workspace.manifest.staged", input: { root, ref } }, signal);
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
    const contents = await compute(
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
  input: Omit<
    WorkspaceManifestComputationOperations["workspace.manifest.stage-input"]["input"],
    "baseManifestRaw" | "currentManifestRaw"
  > & { baseManifestRaw: string; currentManifestRaw: string },
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const encoder = new TextEncoder();
  return await compute(
    {
      type: "workspace.manifest.stage-input",
      input: {
        inputPath: input.inputPath,
        stagingRoot: input.stagingRoot,
        stagedResultRef: input.stagedResultRef,
        baseManifestRef: input.baseManifestRef,
        currentManifestRef: input.currentManifestRef,
        baseManifestRaw: encoder.encode(input.baseManifestRaw),
        currentManifestRaw: encoder.encode(input.currentManifestRaw),
      },
    },
    signal,
  );
}

export async function prepareWorkspaceTreeInput(
  input: WorkspaceManifestValueInputs["workspace.manifest.tree-input"],
): Promise<null> {
  return await compute({
    type: "workspace.manifest.tree-input",
    input: encodeManifestValue(input),
  });
}
