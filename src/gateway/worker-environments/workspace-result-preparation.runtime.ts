import { createHash } from "node:crypto";
import {
  parseGitHubRepositoryPublicationSnapshot,
  readGitHubRepositoryPublicationBlob,
} from "../github-repository-publication-snapshot.js";
import { readWorkspaceGitEntry, writeWorkspaceGitInput } from "./workspace-git-input.js";
import { parseChangedWorkspaceResult } from "./workspace-manifest-comparison.js";
import type {
  WorkspaceManifestValueInputs,
  WorkspaceStageInput,
} from "./workspace-manifest-computation.js";
import {
  parseWorkerWorkspaceManifest,
  serializeWorkerWorkspaceManifest,
  MAX_RECONCILIATION_TOTAL_BYTES,
  type WorkerWorkspaceManifestEntry,
} from "./workspace-manifest.js";
import { readWorkspaceTreeFile } from "./workspace-reconcile-fs.js";
import {
  requireWorkerResultStorageRef,
  STAGED_RESULT_MESSAGE,
} from "./workspace-result-inventory.js";

const bufferView = (bytes: Uint8Array) =>
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

function stagedResultMessage(params: {
  baseManifestRef: string;
  currentManifestRef: string;
  baseManifestRaw: Uint8Array<ArrayBuffer>;
  currentManifestRaw: Uint8Array<ArrayBuffer>;
}): { chunks: Buffer[]; byteLength: number } {
  const base = bufferView(params.baseManifestRaw);
  const current = bufferView(params.currentManifestRaw);
  const header = Buffer.from(
    `${STAGED_RESULT_MESSAGE}\nversion 2\nbase-ref ${params.baseManifestRef}\ncurrent-ref ${params.currentManifestRef}\nbase-bytes ${base.byteLength}\ncurrent-bytes ${current.byteLength}\n\n`,
  );
  return {
    chunks: [header, base, current],
    byteLength: header.byteLength + base.byteLength + current.byteLength,
  };
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function publicationStageSource(
  params: Extract<WorkspaceStageInput, { publication: unknown }>,
  assertBeforeMutation?: () => void,
) {
  const { publication, stagingRoot } = params;
  const metadata = bufferView(publication.metadata);
  const snapshot = parseGitHubRepositoryPublicationSnapshot(
    metadata.toString("utf8"),
    publication.publicationDigest,
  );
  if (snapshot.baseCommit !== publication.baseCommit) {
    throw new Error("Repository publication checkpoint base changed");
  }
  const inline = new Map([
    ["snapshot.json", metadata],
    [
      "binding.json",
      Buffer.from(
        JSON.stringify({
          currentManifestRef: publication.currentManifestRef,
          publicationDigest: publication.publicationDigest,
        }),
      ),
    ],
  ]);
  const file = (pathname: string, content: Uint8Array): WorkerWorkspaceManifestEntry => ({
    path: pathname,
    type: "file",
    mode: 0o644,
    size: content.byteLength,
    sha256: sha256(content),
  });
  const entries = [...inline].map(([pathname, content]) => file(pathname, content));
  const blobs = new Set(
    snapshot.entries.flatMap((entry) => (entry.sha && entry.mode !== "160000" ? [entry.sha] : [])),
  );
  let bytes = metadata.byteLength;
  for (const sha of blobs) {
    assertBeforeMutation?.();
    const content = await readGitHubRepositoryPublicationBlob(stagingRoot, sha);
    assertBeforeMutation?.();
    bytes += content.byteLength;
    if (bytes > MAX_RECONCILIATION_TOTAL_BYTES) {
      throw new Error("Repository publication checkpoint exceeds its byte budget");
    }
    entries.push(file(`blobs/${sha}`, content));
  }
  const manifestBytes = (files: WorkerWorkspaceManifestEntry[], directories: string[] = []) =>
    new TextEncoder().encode(
      serializeWorkerWorkspaceManifest({
        version: 1,
        baseCommit: null,
        directories,
        entries: files,
      }),
    );
  const baseManifestRaw = manifestBytes([]);
  const currentManifestRaw = manifestBytes(entries, ["blobs"]);
  return {
    baseManifestRaw,
    currentManifestRaw,
    baseManifestRef: `sha256:${sha256(baseManifestRaw)}`,
    currentManifestRef: `sha256:${sha256(currentManifestRaw)}`,
    readVerifiedContent: async (entry: WorkerWorkspaceManifestEntry) => {
      // Keep only metadata between passes; never retain the complete blob inventory.
      const content =
        inline.get(entry.path) ??
        (await readGitHubRepositoryPublicationBlob(stagingRoot, entry.path.slice("blobs/".length)));
      if (
        entry.type !== "file" ||
        content.byteLength !== entry.size ||
        sha256(content) !== entry.sha256
      ) {
        throw new Error("Repository publication blob changed during preparation");
      }
      return content;
    },
  };
}

export async function buildWorkspaceStageInput(
  params: WorkspaceStageInput,
  assertBeforeMutation?: () => void,
): Promise<null> {
  const stagedResultRef = requireWorkerResultStorageRef(params.stagedResultRef);
  const source =
    "publication" in params
      ? await publicationStageSource(params, assertBeforeMutation)
      : {
          ...params,
          readVerifiedContent: async (entry: WorkerWorkspaceManifestEntry) =>
            await readWorkspaceGitEntry(params.stagingRoot, entry).catch((error: unknown) => {
              throw new Error(`Cloud workspace staged payload is invalid: ${entry.path}`, {
                cause: error,
              });
            }),
        };
  const compared = parseChangedWorkspaceResult(
    parseWorkerWorkspaceManifest(
      bufferView(source.baseManifestRaw).toString("utf8"),
      source.baseManifestRef,
    ),
    parseWorkerWorkspaceManifest(
      bufferView(source.currentManifestRaw).toString("utf8"),
      source.currentManifestRef,
    ),
  );
  // Deletions are represented by the authenticated manifests and need no blob.
  await writeWorkspaceGitInput({
    assertBeforeMutation,
    inputPath: params.inputPath,
    ref: stagedResultRef,
    entries: compared.entries,
    message: stagedResultMessage(source),
    readVerifiedContent: source.readVerifiedContent,
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
