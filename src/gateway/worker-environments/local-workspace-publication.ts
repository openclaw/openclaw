import { serialize } from "node:v8";
import { deflateRawSync } from "node:zlib";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { localWorkspaceDigestBytes } from "./local-workspace-cas.js";
import type {
  LocalWorkspaceManifestMutation,
  LocalWorkspaceMutation,
  LocalWorkspaceProjection,
  LocalWorkspacePreparedUpdate,
} from "./local-workspace-store.types.js";

/** Publish source observations and retained target slots with the same accepted tree. */
export function localWorkspaceFingerprintPatch(
  fingerprints: LocalWorkspaceManifestMutation["fingerprints"],
) {
  const patch: Partial<
    Pick<LocalWorkspaceProjection, "canonical_fingerprints" | "projection_fingerprints">
  > = {};
  if (fingerprints) {
    const { target, blob, oppositeBlob } = fingerprints;
    for (const [side, value] of [
      [target, blob],
      [target === "canonical" ? "projection" : "canonical", oppositeBlob],
    ] as const) {
      if (value) {
        const bytes = Buffer.from(value, "base64");
        patch[`${side}_fingerprints`] = new Uint8Array(
          bytes.buffer,
          bytes.byteOffset,
          bytes.byteLength,
        );
      }
    }
  }
  return patch;
}

export function prepareLocalWorkspaceUpdate(
  mutation: Extract<LocalWorkspaceMutation, { kind: "update" }>,
  preparations: Uint8Array[] = [],
): LocalWorkspacePreparedUpdate {
  const manifest = mutation.manifest;
  const patch = {
    ...mutation.patch,
    ...(manifest ? { baseline_ref: manifest.resultingRoot, baseline_json: null } : {}),
    ...(manifest?.treeRoot
      ? { tree_root_digest: localWorkspaceDigestBytes(manifest.treeRoot) }
      : {}),
    ...localWorkspaceFingerprintPatch(manifest?.fingerprints),
  };
  return {
    revision: mutation.revision,
    patch,
    mutation: deflateRawSync(serialize({ ...mutation, patch })),
    preparations,
  };
}

function freezeProjection(row: LocalWorkspaceProjection): LocalWorkspaceProjection {
  const pack = row.journal_pack;
  if (Buffer.isBuffer(pack)) {
    // Worker/database rows expose plain byte views, without Node Buffer's JSON behavior.
    row.journal_pack = new Uint8Array(pack.buffer, pack.byteOffset, pack.byteLength);
  }
  return Object.freeze(row);
}

/** Reconstruct only the admitted mutation; caller-provided prior rows carry no authority. */
export function readLocalWorkspaceCommit(
  value: unknown,
  id: string,
  mutation: LocalWorkspaceMutation,
  previous: LocalWorkspaceProjection | undefined,
): LocalWorkspaceProjection | undefined {
  if (value === undefined) {
    throw new Error("Local workspace commit coverage is incomplete");
  }
  if (mutation.kind === "delete" && value === null) {
    return undefined;
  }
  if (isRecord(value) && value.worktree_id === id) {
    if (mutation.kind === "create" && value.revision === 0) {
      return freezeProjection({ ...mutation.row, revision: 0 });
    }
    if (
      mutation.kind === "update" &&
      previous?.worktree_id === id &&
      previous.revision === mutation.revision &&
      value.revision === mutation.revision + 1
    ) {
      return freezeProjection({
        ...previous,
        ...Object.fromEntries(
          Object.entries(mutation.patch).filter(([, entry]) => entry !== undefined),
        ),
        ...(mutation.rejectedResult
          ? { rejectedResult: mutation.rejectedResult }
          : mutation.patch.checkpoint_json !== undefined
            ? { rejectedResult: undefined }
            : {}),
        ...(mutation.manifest
          ? {
              baseline_ref: mutation.manifest.resultingRoot,
              baseline_json: null,
              ...(mutation.manifest.treeRoot
                ? { tree_root_digest: localWorkspaceDigestBytes(mutation.manifest.treeRoot) }
                : {}),
              ...localWorkspaceFingerprintPatch(mutation.manifest.fingerprints),
            }
          : {}),
        worktree_id: id,
        revision: mutation.revision + 1,
      });
    }
  }
  throw new Error("Local workspace commit identity is invalid");
}
