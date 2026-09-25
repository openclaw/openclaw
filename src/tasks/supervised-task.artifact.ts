import { createHash } from "node:crypto";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import {
  readSupervisedWorkflow,
  type SupervisedWorkflowDatabaseOptions as Options,
} from "./supervised-workflow.persistence.js";
import { readSupervisedWorkflowContractInTransaction } from "./supervised-workflow.store.js";
import { supervisedWorkspaceVersionPath } from "./supervised-workspace-versions.js";
import { captureSupervisedWorkspace, readSupervisedWorkspaceFile } from "./supervised-workspace.js";

/** Read only a retained version owned by this flow. No caller-supplied absolute
 * path, current checkout, live draft, or other task's artifact can be selected. */
export async function inspectSupervisedArtifact(
  params: {
    flowId: string;
    versionId: string;
    sourceHash: string;
    after?: string;
    path?: string;
    offset?: number;
  },
  assertCurrent: () => void,
  options: Options = {},
) {
  assertCurrent();
  const stored = readSupervisedWorkflow((db) => {
    if (!tableExists(db, "task_flow_workspace_versions")) {
      return undefined;
    }
    const row = executeSqliteQueryTakeFirstSync(
      db,
      getNodeSqliteKysely<DB>(db)
        .selectFrom("task_flow_workspace_versions")
        .selectAll()
        .where("version_id", "=", params.versionId)
        .where("flow_id", "=", params.flowId)
        .where("source_hash", "=", params.sourceHash),
    );
    if (!row) {
      return undefined;
    }
    if (tableExists(db, "task_flow_workspace_allocations")) {
      const allocation = executeSqliteQueryTakeFirstSync(
        db,
        getNodeSqliteKysely<DB>(db)
          .selectFrom("task_flow_workspace_allocations")
          .select("state")
          .where("allocation_id", "=", row.version_id),
      );
      if (allocation && ["deleting", "deleted"].includes(allocation.state)) {
        throw new Error("Task artifact retention expired; its receipt is still retained");
      }
    }
    const contract = readSupervisedWorkflowContractInTransaction(db, row.flow_id, row.episode);
    return contract ? { row, contract: contract.contract } : undefined;
  }, options);
  if (!stored) {
    throw new Error("Retained task artifact unavailable");
  }
  const workspace = supervisedWorkspaceVersionPath(stored.row.version_id, options);
  const manifest = await captureSupervisedWorkspace({ ...stored.contract, workspace });
  assertCurrent();
  if (manifest.hash !== stored.row.source_hash) {
    throw new Error("Retained task artifact changed");
  }
  const files = manifest.files
    .filter((entry) => !params.after || entry.path > params.after)
    .slice(0, 257);
  const result = {
    versionId: stored.row.version_id,
    sourceHash: manifest.hash,
    files: files.slice(0, 256),
    ...(files.length > 256 ? { next: files[255]!.path } : {}),
  };
  if (params.path === undefined) {
    return result;
  }
  const selected = manifest.files.find((file) => file.path === params.path);
  if (!selected) {
    throw new Error("File is not part of this retained artifact");
  }
  const offset = params.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > selected.bytes) {
    throw new Error("Invalid artifact byte offset");
  }
  const bytes = await readSupervisedWorkspaceFile(workspace, selected.path, selected.bytes);
  if (
    bytes.length !== selected.bytes ||
    createHash("sha256").update(bytes).digest("hex") !== selected.sha256
  ) {
    throw new Error("Retained artifact bytes changed");
  }
  assertCurrent();
  const end = Math.min(bytes.length, offset + 64 * 1024);
  return {
    ...result,
    file: {
      path: selected.path,
      sha256: selected.sha256,
      bytes: selected.bytes,
      offset,
      base64: bytes.subarray(offset, end).toString("base64"),
      ...(end < bytes.length ? { nextOffset: end } : {}),
    },
  };
}
