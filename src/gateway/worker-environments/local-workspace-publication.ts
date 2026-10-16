import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Selectable } from "kysely";
import { hasSqliteCommitReceiptCoverage } from "../../infra/sqlite-commit-receipt.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import { createStateDomainPublication } from "../../state/state-domain-publication.js";

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

export const localWorkspacePublication = createStateDomainPublication<LocalWorkspaceProjection>({
  domain: "local-workspace",
  keyOf: (value) => value.worktree_id,
  isValue: isRow,
});

export function readLocalWorkspaceCommit(value: unknown, operationId: string, id: string) {
  if (!isRecord(value) || value.operationId !== operationId || !isRecord(value.receipt)) {
    throw new Error("Local workspace has no committed receipt");
  }
  const receipt = value.receipt;
  if (
    !isRecord(receipt.source) ||
    typeof receipt.source.identity !== "string" ||
    typeof receipt.source.incarnation !== "string" ||
    !hasSqliteCommitReceiptCoverage(receipt, {
      source: { identity: receipt.source.identity, incarnation: receipt.source.incarnation },
      domain: "local-workspace",
      keys: [id],
    }) ||
    !(receipt.facts instanceof Map)
  ) {
    throw new Error("Local workspace commit coverage is incomplete");
  }
  const fact: unknown = receipt.facts.get(id);
  if (isRecord(fact) && fact.kind === "absent") {
    return undefined;
  }
  if (
    isRecord(fact) &&
    fact.kind === "postimage" &&
    isRow(fact.value) &&
    fact.value.worktree_id === id
  ) {
    return Object.freeze(fact.value);
  }
  throw new Error("Local workspace committed row is invalid");
}
