import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  LocalWorkspaceMutation,
  LocalWorkspaceProjection,
} from "./local-workspace-store.types.js";

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
        ...(mutation.manifest
          ? { baseline_ref: mutation.manifest.resultingRoot, baseline_json: null }
          : {}),
        worktree_id: id,
        revision: mutation.revision + 1,
      });
    }
  }
  throw new Error("Local workspace commit identity is invalid");
}
