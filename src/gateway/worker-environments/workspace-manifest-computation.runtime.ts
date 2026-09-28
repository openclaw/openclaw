import { createHash } from "node:crypto";
import { ownedWorkerBytes } from "../../infra/worker-transfer-bytes.js";
import { runTasksWithConcurrency } from "../../utils/run-with-concurrency.js";
import {
  pruneWorkspaceHashMemo,
  withWorkerWorkspaceHashMemo,
  withWorkspaceHashMemo,
  withoutWorkspaceHashContext,
  type WorkspaceHashMetrics,
} from "./workspace-hash-memo.js";
import {
  parseChangedWorkspaceResult,
  type WorkspaceNode,
} from "./workspace-manifest-comparison.js";
import type {
  WorkspaceComputationHashes,
  WorkspaceComputationHashResult,
  WorkspaceManifestComputationCommand,
  WorkspaceManifestComputationResult,
  WorkspaceManifestComputationOperations,
  WorkspaceManifestValueInputs,
} from "./workspace-manifest-computation.js";
import { applyWorkspaceSourceOverlay } from "./workspace-manifest-overlay.js";
import {
  parseWorkerWorkspaceManifest,
  serializeWorkerWorkspaceManifest,
} from "./workspace-manifest.js";

function decodeManifestValue<Type extends keyof WorkspaceManifestValueInputs>(command: {
  type: Type;
  input: { payload: Uint8Array<ArrayBuffer> };
}): WorkspaceManifestValueInputs[Type] {
  const payload = command.input.payload;
  const parsed: unknown = JSON.parse(
    Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).toString("utf8"),
  );
  // SAFETY: Only the private host adapter creates these typed serialized payloads.
  return parsed as WorkspaceManifestValueInputs[Type];
}

function captureArguments(input: WorkspaceManifestValueInputs["workspace.manifest.capture"]) {
  return {
    root: input.root,
    baseCommit: input.baseCommit,
    includePaths: input.includePaths === undefined ? undefined : new Set(input.includePaths),
    preserveDirectories:
      input.preserveDirectories === undefined ? undefined : new Set(input.preserveDirectories),
  };
}

async function withHashes<T>(
  input: WorkspaceComputationHashes | undefined,
  run: () => Promise<T>,
): Promise<WorkspaceComputationHashResult<T>> {
  const metrics: WorkspaceHashMetrics = {
    contentHashCount: 0,
    contentHashDurationMs: 0,
    memoHitCount: 0,
  };
  if (!input) {
    return { value: await withoutWorkspaceHashContext(run), hashes: [], metrics };
  }
  const initial = new Map(input.entries);
  const hashes = new Map(initial);
  const value = await (input.owner === "worker"
    ? withWorkerWorkspaceHashMemo(hashes, run, metrics)
    : withWorkspaceHashMemo(hashes, run, metrics));
  pruneWorkspaceHashMemo(hashes);
  return {
    value,
    hashes: [...hashes].filter(([identity, digest]) => initial.get(identity) !== digest),
    metrics,
  };
}

export function executeWorkspaceManifestComputation<
  Command extends WorkspaceManifestComputationCommand,
>(
  command: Command,
  assertBeforeMutation?: () => void,
): Promise<WorkspaceManifestComputationOperations[Command["type"]]["output"]>;
export async function executeWorkspaceManifestComputation(
  command: WorkspaceManifestComputationCommand,
  assertBeforeMutation?: () => void,
): Promise<WorkspaceManifestComputationResult> {
  switch (command.type) {
    case "workspace.manifest.nodes": {
      const { localWorkspaceNode } = await import("./workspace-reconcile-fs.js");
      const input = decodeManifestValue(command);
      return await withHashes(input.hashes, async () => {
        const result = await runTasksWithConcurrency({
          tasks: input.paths.map((entryPath) => async (): Promise<[string, WorkspaceNode]> => [
            entryPath,
            await localWorkspaceNode(input.root, entryPath),
          ]),
          limit: 4,
          errorMode: "stop",
        });
        if (result.hasError) {
          throw result.firstError;
        }
        return result.results;
      });
    }
    case "workspace.manifest.staged": {
      const { loadStagedWorkerWorkspace } = await import("./workspace-result-inventory.runtime.js");
      return await loadStagedWorkerWorkspace(command.input.root, command.input.ref);
    }
    case "workspace.manifest.stage-input": {
      const { buildWorkspaceStageInput } =
        await import("./workspace-result-preparation.runtime.js");
      return await buildWorkspaceStageInput(command.input, assertBeforeMutation);
    }
    case "workspace.manifest.tree-input": {
      const { buildWorkspaceTreeInput } = await import("./workspace-result-preparation.runtime.js");
      return await buildWorkspaceTreeInput(decodeManifestValue(command), assertBeforeMutation);
    }
    case "workspace.manifest.entries": {
      const { readStagedWorkerWorkspaceEntries } =
        await import("./workspace-result-inventory.runtime.js");
      return ownedWorkerBytes(await readStagedWorkerWorkspaceEntries(command.input));
    }
    case "workspace.manifest.capture":
    case "workspace.manifest.snapshot": {
      const { readActualWorkspaceManifestImpl } = await import("./workspace-actual-manifest.js");
      const input = decodeManifestValue(command);
      return await withHashes(input.hashes, async () => {
        const snapshot = await readActualWorkspaceManifestImpl(captureArguments(input));
        return command.type === "workspace.manifest.snapshot"
          ? snapshot
          : { manifest: snapshot.manifest, manifestRef: snapshot.manifestRef };
      });
    }
    case "workspace.manifest.file": {
      const { readWorkspaceFileSnapshotWithLimit } = await import("./workspace-actual-manifest.js");
      const input = decodeManifestValue(command);
      return await withHashes(input.hashes, () =>
        readWorkspaceFileSnapshotWithLimit(input.path, input.maxBytes, input.root),
      );
    }
    case "workspace.reconcile.preflight": {
      const { preflightWorkspaceApplyImpl } = await import("./workspace-reconcile-preflight.js");
      const input = decodeManifestValue(command);
      return await withHashes(input.hashes, () => preflightWorkspaceApplyImpl(input));
    }
    case "workspace.manifest.parse": {
      const raw = Buffer.from(
        command.input.raw.buffer,
        command.input.raw.byteOffset,
        command.input.raw.byteLength,
      ).toString("utf8");
      const manifestRef =
        command.input.expectedRef ?? `sha256:${createHash("sha256").update(raw).digest("hex")}`;
      return {
        manifest: parseWorkerWorkspaceManifest(raw, manifestRef),
        manifestRef,
      };
    }
    case "workspace.manifest.overlay": {
      const input = decodeManifestValue(command);
      const raw = serializeWorkerWorkspaceManifest(
        applyWorkspaceSourceOverlay(input.source, input.prepared, input.incoming),
      );
      const manifestRef = `sha256:${createHash("sha256").update(raw).digest("hex")}`;
      return { manifest: parseWorkerWorkspaceManifest(raw, manifestRef), manifestRef };
    }
    case "workspace.manifest.serialize": {
      const input = decodeManifestValue(command);
      const raw = serializeWorkerWorkspaceManifest(input.manifest);
      return { raw, manifestRef: `sha256:${createHash("sha256").update(raw).digest("hex")}` };
    }
    case "workspace.manifest.pair": {
      const baseRaw = Buffer.from(
        command.input.baseRaw.buffer,
        command.input.baseRaw.byteOffset,
        command.input.baseRaw.byteLength,
      ).toString("utf8");
      const currentRaw = Buffer.from(
        command.input.currentRaw.buffer,
        command.input.currentRaw.byteOffset,
        command.input.currentRaw.byteLength,
      ).toString("utf8");
      const base = parseWorkerWorkspaceManifest(baseRaw, command.input.baseRef);
      const current = parseWorkerWorkspaceManifest(currentRaw, command.input.currentRef);
      const compared = parseChangedWorkspaceResult(base, current);
      return { base, current, ...compared, paths: compared.entries.map((entry) => entry.path) };
    }
  }
  command satisfies never;
  throw new Error("Unsupported workspace computation");
}
