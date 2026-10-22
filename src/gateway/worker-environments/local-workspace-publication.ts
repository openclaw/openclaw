import { serialize } from "node:v8";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Selectable } from "kysely";
import { SQLITE_WORKER_MAX_MESSAGE_BYTES } from "../../infra/sqlite-worker-contract.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";

type LocalWorkspaceProjection = Selectable<DB["local_workspace_projections"]>;

function isRow(value: unknown): value is LocalWorkspaceProjection {
  return (
    isRecord(value) &&
    [
      "worktree_id",
      "agent_id",
      "session_key",
      "session_id",
      "projection_path",
      "base_commit",
      "source_paths_json",
    ].every((key) => typeof value[key] === "string") &&
    [
      "lifecycle_revision",
      "baseline_json",
      "baseline_ref",
      "pending_ref",
      "pending_target",
      "journal_json",
      "paused_runtimes_json",
    ].every((key) => value[key] === null || typeof value[key] === "string") &&
    (value.journal_pack === null || value.journal_pack instanceof Uint8Array) &&
    typeof value.created_at_ms === "number" &&
    typeof value.revision === "number"
  );
}

/** Undefined is unknown coverage; only an explicit null certifies deletion. */
export function boundLocalWorkspaceCommit(value: LocalWorkspaceProjection | null | undefined) {
  return serialize(value).byteLength <= SQLITE_WORKER_MAX_MESSAGE_BYTES / 4 ? value : undefined;
}

export function readLocalWorkspaceCommit(value: unknown, id: string) {
  if (value === undefined) {
    throw new Error("Local workspace commit coverage is incomplete");
  }
  if (value === null) {
    return undefined;
  }
  if (isRow(value) && value.worktree_id === id) {
    return Object.freeze(value);
  }
  throw new Error("Local workspace committed row is invalid");
}
