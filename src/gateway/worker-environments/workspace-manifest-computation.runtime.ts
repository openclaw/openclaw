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
  manifestNodes,
  parseChangedWorkspaceResult,
  sameEntry,
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

function decodeUtf8(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8");
}

function decodeManifestValue<Type extends keyof WorkspaceManifestValueInputs>(command: {
  type: Type;
  input: { payload: Uint8Array<ArrayBuffer> };
}): WorkspaceManifestValueInputs[Type] {
  const parsed: unknown = JSON.parse(decodeUtf8(command.input.payload));
  // SAFETY: Only the private host adapter creates these typed serialized payloads.
  return parsed as WorkspaceManifestValueInputs[Type];
}

async function withHashes<T>(
  input: WorkspaceComputationHashes | undefined,
  run: () => Promise<T>,
): Promise<WorkspaceComputationHashResult<T>> {
  const metrics: WorkspaceHashMetrics = {
    contentHashCount: 0,
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
    case "workspace.manifest.base-refresh": {
      const { readActualWorkspaceManifestImpl } = await import("./workspace-actual-manifest.js");
      const input = command.input;
      return await withHashes(input.hashes, async () => {
        const { manifest: before } = await readActualWorkspaceManifestImpl({
          root: input.beforeRoot,
          baseCommit: input.baseCommit,
        });
        const { manifest: after } = await readActualWorkspaceManifestImpl({
          root: input.afterRoot,
          baseCommit: input.baseCommit,
        });
        const accepted = parseWorkerWorkspaceManifest(
          decodeUtf8(input.baseRaw),
          input.baseRef,
          input.buildCacheInputs,
        );
        const current = applyWorkspaceSourceOverlay(before, accepted, after);
        current.buildCacheInputs = [
          ...new Set([...input.buildCacheInputs, ...after.entries.map((entry) => entry.path)]),
        ];
        const priorNodes = manifestNodes(before);
        const currentNodes = manifestNodes(current);
        for (const [file, entry] of manifestNodes(accepted)) {
          if (!priorNodes.has(file) && !sameEntry(entry, currentNodes.get(file))) {
            throw new Error(
              `The selected base conflicts with saved workspace data at ${file}; move that saved file before retrying ${input.action}.`,
            );
          }
        }
        const rawManifest = serializeWorkerWorkspaceManifest(current);
        return {
          rawManifest,
          manifestRef: `sha256:${createHash("sha256").update(rawManifest).digest("hex")}`,
          buildCacheInputs: current.buildCacheInputs,
        };
      });
    }
    case "workspace.manifest.equal": {
      const input = command.input;
      const left = manifestNodes(
        parseWorkerWorkspaceManifest(
          decodeUtf8(input.baseRaw),
          input.baseRef,
          input.buildCacheInputs,
        ),
      );
      const right = manifestNodes(
        parseWorkerWorkspaceManifest(
          decodeUtf8(input.currentRaw),
          input.currentRef,
          input.buildCacheInputs,
        ),
      );
      return (
        left.size === right.size &&
        [...left].every(([file, entry]) => sameEntry(entry, right.get(file)))
      );
    }
    case "workspace.manifest.remote-capture": {
      const { captureNodeWorkspaceManifestImpl } =
        await import("./workspace-manifest-script.runtime.js");
      return await captureNodeWorkspaceManifestImpl(command.input, assertBeforeMutation);
    }
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
      return await loadStagedWorkerWorkspace(
        command.input.root,
        command.input.ref,
        command.input.buildCacheInputs,
      );
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
    case "workspace.manifest.snapshot":
    case "workspace.manifest.document":
    case "workspace.manifest.reference": {
      const { readActualWorkspaceManifestImpl } = await import("./workspace-actual-manifest.js");
      const input = decodeManifestValue(command);
      const result = await withHashes(input.hashes, () =>
        readActualWorkspaceManifestImpl({
          ...input,
          includePaths: input.includePaths && new Set(input.includePaths),
          buildCacheInputs: input.buildCacheInputs && new Set(input.buildCacheInputs),
          preserveDirectories: input.preserveDirectories && new Set(input.preserveDirectories),
        }),
      );
      if (command.type === "workspace.manifest.document") {
        const { manifestRef, rawManifest } = result.value;
        return { ...result, value: { manifestRef, rawManifest } };
      }
      return command.type === "workspace.manifest.reference"
        ? { ...result, value: result.value.manifestRef }
        : command.type === "workspace.manifest.snapshot"
          ? result
          : {
              ...result,
              value: { manifest: result.value.manifest, manifestRef: result.value.manifestRef },
            };
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
    case "workspace.manifest.paths": {
      const input = command.input;
      const manifest = parseWorkerWorkspaceManifest(
        decodeUtf8(input.raw),
        input.expectedRef,
        input.buildCacheInputs,
      );
      // Parsing already projects eligible entries; keep the directory-first path order.
      return new Set([
        ...(manifest.directories ?? []),
        ...manifest.entries.map((entry) => entry.path),
      ]);
    }
    case "workspace.manifest.parse": {
      const raw = decodeUtf8(command.input.raw);
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
      const baseRaw = decodeUtf8(command.input.baseRaw);
      const currentRaw = decodeUtf8(command.input.currentRaw);
      const base = parseWorkerWorkspaceManifest(baseRaw, command.input.baseRef);
      const current = parseWorkerWorkspaceManifest(currentRaw, command.input.currentRef);
      const compared = parseChangedWorkspaceResult(base, current);
      return { base, current, ...compared, paths: compared.entries.map((entry) => entry.path) };
    }
  }
  command satisfies never;
  throw new Error("Unsupported workspace computation");
}
