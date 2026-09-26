import { readWorkspaceGitEntry, writeWorkspaceGitInput } from "./workspace-git-input.js";
import { parseChangedWorkspaceResult } from "./workspace-manifest-comparison.js";
import type {
  WorkspaceManifestComputationOperations,
  WorkspaceManifestValueInputs,
} from "./workspace-manifest-computation.js";
import { parseWorkerWorkspaceManifest } from "./workspace-manifest.js";
import { readWorkspaceTreeFile } from "./workspace-reconcile-fs.js";
import {
  requireWorkerResultStorageRef,
  STAGED_RESULT_MESSAGE,
} from "./workspace-result-inventory.js";

function stagedResultMessage(params: {
  baseManifestRef: string;
  currentManifestRef: string;
  baseManifestRaw: Uint8Array<ArrayBuffer>;
  currentManifestRaw: Uint8Array<ArrayBuffer>;
}): { chunks: Buffer[]; byteLength: number } {
  const base = Buffer.from(
    params.baseManifestRaw.buffer,
    params.baseManifestRaw.byteOffset,
    params.baseManifestRaw.byteLength,
  );
  const current = Buffer.from(
    params.currentManifestRaw.buffer,
    params.currentManifestRaw.byteOffset,
    params.currentManifestRaw.byteLength,
  );
  const header = Buffer.from(
    `${STAGED_RESULT_MESSAGE}\nversion 2\nbase-ref ${params.baseManifestRef}\ncurrent-ref ${params.currentManifestRef}\nbase-bytes ${base.byteLength}\ncurrent-bytes ${current.byteLength}\n\n`,
  );
  return {
    chunks: [header, base, current],
    byteLength: header.byteLength + base.byteLength + current.byteLength,
  };
}

export async function buildWorkspaceStageInput(
  params: WorkspaceManifestComputationOperations["workspace.manifest.stage-input"]["input"],
  assertBeforeMutation?: () => void,
): Promise<null> {
  const stagedResultRef = requireWorkerResultStorageRef(params.stagedResultRef);
  const compared = parseChangedWorkspaceResult(
    parseWorkerWorkspaceManifest(
      Buffer.from(
        params.baseManifestRaw.buffer,
        params.baseManifestRaw.byteOffset,
        params.baseManifestRaw.byteLength,
      ).toString("utf8"),
      params.baseManifestRef,
    ),
    parseWorkerWorkspaceManifest(
      Buffer.from(
        params.currentManifestRaw.buffer,
        params.currentManifestRaw.byteOffset,
        params.currentManifestRaw.byteLength,
      ).toString("utf8"),
      params.currentManifestRef,
    ),
  );
  // Deletions are represented by the authenticated manifests and need no blob.
  await writeWorkspaceGitInput({
    assertBeforeMutation,
    inputPath: params.inputPath,
    ref: stagedResultRef,
    entries: compared.entries,
    message: stagedResultMessage(params),
    readVerifiedContent: async (entry) =>
      await readWorkspaceGitEntry(params.stagingRoot, entry).catch((error: unknown) => {
        throw new Error(`Cloud workspace staged payload is invalid: ${entry.path}`, {
          cause: error,
        });
      }),
  });
  return null;
}

export async function buildWorkspaceTreeInput(
  params: WorkspaceManifestValueInputs["workspace.manifest.tree-input"],
  assertBeforeMutation?: () => void,
): Promise<null> {
  const source = params.source;
  await writeWorkspaceGitInput({
    ...params,
    assertBeforeMutation,
    readVerifiedContent: async (entry) =>
      source.tree === undefined
        ? await readWorkspaceGitEntry(source.root, entry)
        : entry.type === "file"
          ? await readWorkspaceTreeFile({
              repositoryRoot: source.root,
              tree: source.tree,
              entry,
            })
          : Buffer.from(entry.target),
  });
  return null;
}
