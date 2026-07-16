// Creates Claw-owned bootstrap and supporting files inside the new agent workspace.
import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { root as fsSafeRoot, FsSafeError } from "../infra/fs-safe.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import type { ClawAddPlan, ClawAddPlanAction, ClawDiagnostic } from "./types.js";

const CLAW_WORKSPACE_FILE_RECORD_SCHEMA_VERSION = "openclaw.clawWorkspaceFileRecord.v1" as const;

const MAX_CLAW_WORKSPACE_FILE_BYTES = 1024 * 1024;

export type PersistedClawWorkspaceFile = {
  schemaVersion: typeof CLAW_WORKSPACE_FILE_RECORD_SCHEMA_VERSION;
  agentId: string;
  workspace: string;
  path: string;
  sourcePath: string;
  contentDigest: string;
  status: "pending" | "complete" | "failed";
  createdAtMs: number;
  updatedAtMs: number;
};

export class ClawWorkspaceWriteError extends Error {
  constructor(
    readonly diagnostics: ClawDiagnostic[],
    readonly createdFiles: PersistedClawWorkspaceFile[],
  ) {
    super("Claw workspace file creation failed");
    this.name = "ClawWorkspaceWriteError";
  }
}

function diagnostic(action: ClawAddPlanAction, code: string, message: string): ClawDiagnostic {
  return {
    level: "error",
    code,
    phase: "mutation",
    path: `$.workspace[${JSON.stringify(action.id)}]`,
    message,
  };
}

function contentDigest(content: Uint8Array): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function containedRelativePath(root: string, path: string): string | undefined {
  const child = relative(root, path);
  if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    return undefined;
  }
  return child;
}

function persistWorkspaceFile(
  record: PersistedClawWorkspaceFile,
  options: OpenClawStateDatabaseOptions,
): void {
  runOpenClawStateWriteTransaction(({ db }) => {
    // sqlite-allow-raw: this Claw prototype state-table write is scoped to one owned row.
    db.prepare(
      `INSERT INTO claw_workspace_files (
         agent_id, target_path, schema_version, workspace, source_path,
         content_digest, status, created_at_ms, updated_at_ms
       ) VALUES (
         @agent_id, @target_path, @schema_version, @workspace, @source_path,
         @content_digest, @status, @created_at_ms, @updated_at_ms
       )`,
    ).run({
      agent_id: record.agentId,
      target_path: record.path,
      schema_version: record.schemaVersion,
      workspace: record.workspace,
      source_path: record.sourcePath,
      content_digest: record.contentDigest,
      status: record.status,
      created_at_ms: record.createdAtMs,
      updated_at_ms: record.updatedAtMs,
    });
  }, options);
}

function updateWorkspaceFileStatus(
  record: PersistedClawWorkspaceFile,
  options: OpenClawStateDatabaseOptions,
): void {
  runOpenClawStateWriteTransaction(({ db }) => {
    // sqlite-allow-raw: this Claw prototype state-table write is scoped to one owned row.
    db.prepare(
      `UPDATE claw_workspace_files
          SET status = @status, updated_at_ms = @updated_at_ms
        WHERE agent_id = @agent_id AND target_path = @target_path`,
    ).run({
      agent_id: record.agentId,
      target_path: record.path,
      status: record.status,
      updated_at_ms: record.updatedAtMs,
    });
  }, options);
}

function workspaceFileActions(plan: ClawAddPlan): ClawAddPlanAction[] {
  return plan.actions.filter((action) => action.kind === "workspaceFile");
}

export async function createClawWorkspaceFiles(
  plan: ClawAddPlan,
  options: OpenClawStateDatabaseOptions & { nowMs?: number } = {},
): Promise<PersistedClawWorkspaceFile[]> {
  const actions = workspaceFileActions(plan);
  if (actions.length === 0) {
    return [];
  }

  const workspaceRoot = resolve(plan.agent.workspace);
  const packageRoot = resolve(plan.claw.packageRoot);
  const source = await fsSafeRoot(packageRoot, {
    hardlinks: "reject",
    maxBytes: MAX_CLAW_WORKSPACE_FILE_BYTES,
    symlinks: "reject",
  });
  const workspace = await fsSafeRoot(workspaceRoot, {
    hardlinks: "reject",
    maxBytes: MAX_CLAW_WORKSPACE_FILE_BYTES,
    symlinks: "reject",
  });
  const createdFiles: PersistedClawWorkspaceFile[] = [];
  const nowMs = options.nowMs ?? Date.now();

  for (const action of actions) {
    try {
      if (!action.source || !action.digest) {
        throw new ClawWorkspaceWriteError(
          [
            diagnostic(
              action,
              "workspace_file_plan_invalid",
              "File action lacks source or digest.",
            ),
          ],
          createdFiles,
        );
      }
      const sourcePath = resolve(action.source);
      const targetPath = resolve(action.target);
      const sourceRelative = containedRelativePath(packageRoot, sourcePath);
      const targetRelative = containedRelativePath(workspaceRoot, targetPath);
      if (!sourceRelative || !targetRelative) {
        throw new ClawWorkspaceWriteError(
          [
            diagnostic(
              action,
              "workspace_file_path_escape",
              "Workspace file source and destination must remain inside their owned roots.",
            ),
          ],
          createdFiles,
        );
      }
      const content = await source.readBytes(sourceRelative, {
        maxBytes: MAX_CLAW_WORKSPACE_FILE_BYTES,
      });
      const digest = contentDigest(content);
      if (digest !== action.digest) {
        throw new ClawWorkspaceWriteError(
          [
            diagnostic(
              action,
              "workspace_source_changed",
              `Workspace source for ${JSON.stringify(action.id)} changed after planning.`,
            ),
          ],
          createdFiles,
        );
      }
      if (await workspace.exists(targetRelative)) {
        throw new ClawWorkspaceWriteError(
          [
            diagnostic(
              action,
              "workspace_file_collision",
              `Workspace destination ${JSON.stringify(targetRelative)} already exists.`,
            ),
          ],
          createdFiles,
        );
      }
      const record: PersistedClawWorkspaceFile = {
        schemaVersion: CLAW_WORKSPACE_FILE_RECORD_SCHEMA_VERSION,
        agentId: plan.agent.finalId,
        workspace: workspace.rootReal,
        path: targetRelative.replaceAll(sep, "/"),
        sourcePath: sourceRelative.replaceAll(sep, "/"),
        contentDigest: digest,
        status: "pending",
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
      };
      persistWorkspaceFile(record, options);
      let wroteFile = false;
      try {
        await workspace.write(targetRelative, content, { mkdir: true, overwrite: false });
        wroteFile = true;
        record.status = "complete";
        updateWorkspaceFileStatus(record, options);
        createdFiles.push(record);
      } catch (error) {
        record.status = "failed";
        if (wroteFile) {
          createdFiles.push(record);
        }
        try {
          updateWorkspaceFileStatus(record, options);
        } catch {
          // A pending row intentionally remains as evidence of uncertain owner state.
        }
        throw error;
      }
    } catch (error) {
      if (error instanceof ClawWorkspaceWriteError) {
        throw error;
      }
      const code =
        error instanceof FsSafeError ? `workspace_file_${error.code}` : "workspace_file_io_error";
      throw new ClawWorkspaceWriteError(
        [diagnostic(action, code, error instanceof Error ? error.message : String(error))],
        createdFiles,
      );
    }
  }
  return createdFiles;
}
