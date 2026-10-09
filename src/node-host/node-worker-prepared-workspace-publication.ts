import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { createStateDomainPublication } from "../state/state-domain-publication.js";
import type { NodeWorkerPreparedWorkspaceRow } from "./node-worker-prepared-workspace-store.kernel.js";

export const nodePreparedWorkspacePublication =
  createStateDomainPublication<NodeWorkerPreparedWorkspaceRow>({
    domain: "node-prepared-workspace",
    keyOf: (row) => row.preparation_key,
    isValue: (row): row is NodeWorkerPreparedWorkspaceRow =>
      isRecord(row) &&
      [
        "preparation_key",
        "cache_key",
        "gateway_namespace",
        "environment_id",
        "workspace_dir",
        "home_dir",
        "source_manifest_ref",
        "prepared_manifest_ref",
        "state",
      ].every((key) => typeof row[key] === "string") &&
      ["session_id", "session_key"].every(
        (key) => row[key] === null || typeof row[key] === "string",
      ) &&
      typeof row.created_at_ms === "number" &&
      ["owner_epoch", "bound_at_ms", "retired_at_ms"].every(
        (key) => row[key] === null || typeof row[key] === "number",
      ),
  });
