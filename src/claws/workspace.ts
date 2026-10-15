// Creates Claw-owned bootstrap and supporting files inside the new agent workspace.
import { realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { coerceErrorMessage } from "@openclaw/normalization-core/error-coercion";
import { root as fsSafeRoot, FsSafeError, type Root } from "../infra/fs-safe.js";
import {
  persistClawWorkspaceFileForAdd,
  readClawWorkspaceFileForAdd,
  updateClawWorkspaceFileStatusForAdd,
  type ClawAddStateOptions,
} from "./add-state-write.js";
import { digestClawBytes } from "./digest.js";
import { clawContainedRelativePath } from "./path-containment.js";
import { parseClawMarkdown } from "./reader.js";
import type { ClawAddPlan, ClawAddPlanAction, ClawDiagnostic } from "./types.js";
import {
  CLAW_WORKSPACE_FILE_RECORD_SCHEMA_VERSION,
  type PersistedClawWorkspaceFile,
} from "./workspace-state.js";

export type { PersistedClawWorkspaceFile } from "./workspace-state.js";

const MAX_CLAW_WORKSPACE_FILE_BYTES = 1024 * 1024;

class ClawWorkspaceWriteError extends Error {
  constructor(
    readonly diagnostics: ClawDiagnostic[],
    readonly createdFiles: PersistedClawWorkspaceFile[],
  ) {
    super("Claw workspace file creation failed");
    this.name = "ClawWorkspaceWriteError";
  }
}

class ClawWorkspaceSourceAliasError extends Error {}

function diagnostic(action: ClawAddPlanAction, code: string, message: string): ClawDiagnostic {
  return {
    level: "error",
    code,
    phase: "mutation",
    path: `$.workspace[${JSON.stringify(action.id)}]`,
    message,
  };
}

async function readClawWorkspaceActionSource(params: {
  action: ClawAddPlanAction;
  packageRoot: string;
  sourceRoot: Root;
}): Promise<{ content: Buffer; sourceRelative: string }> {
  if (!params.action.source) {
    throw new Error("Workspace file action lacks a source.");
  }
  const sourcePath = resolve(params.action.source);
  const sourceRelative = clawContainedRelativePath(params.packageRoot, sourcePath);
  if (!sourceRelative) {
    throw new Error("Workspace file source must remain inside the Claw package.");
  }
  const read = await params.sourceRoot.read(sourceRelative, {
    hardlinks: "reject",
    maxBytes: MAX_CLAW_WORKSPACE_FILE_BYTES,
    symlinks: "reject",
  });
  if (resolve(read.realPath) !== sourcePath) {
    throw new ClawWorkspaceSourceAliasError(
      "Workspace source no longer resolves to the consented file.",
    );
  }
  if (params.action.sourceKind !== "clawMarkdownBody") {
    return { content: read.buffer, sourceRelative };
  }
  const parsed = parseClawMarkdown(read.buffer, sourcePath);
  if (!parsed.ok) {
    throw new Error(parsed.diagnostics.map((item) => item.message).join("; "));
  }
  return { content: parsed.body, sourceRelative };
}

function sameWorkspaceFileOwner(
  existing: PersistedClawWorkspaceFile,
  expected: PersistedClawWorkspaceFile,
): boolean {
  return (
    existing.schemaVersion === expected.schemaVersion &&
    existing.agentId === expected.agentId &&
    existing.workspace === expected.workspace &&
    existing.path === expected.path &&
    existing.sourcePath === expected.sourcePath &&
    existing.contentDigest === expected.contentDigest
  );
}

export async function createClawWorkspaceFiles(
  plan: ClawAddPlan,
  options: ClawAddStateOptions & {
    nowMs?: number;
    assertForwardCurrent?: () => void;
    stateless?: boolean;
  } = {},
): Promise<PersistedClawWorkspaceFile[]> {
  const actions = plan.actions.filter((action) => action.kind === "workspaceFile");
  if (actions.length === 0) {
    return [];
  }

  const workspaceRoot = await realpath(resolve(plan.agent.workspace));
  const packageRoot = await realpath(resolve(plan.claw.packageRoot));
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
  const assertForwardCurrent = () => {
    options.assertCurrent?.();
    options.assertForwardCurrent?.();
  };
  const forwardStateOptions = { ...options, assertCurrent: assertForwardCurrent };

  for (const action of actions) {
    const writeError = (code: string, message: string) =>
      new ClawWorkspaceWriteError([diagnostic(action, code, message)], createdFiles);
    try {
      assertForwardCurrent();
      if (!action.source || !action.digest) {
        throw writeError("workspace_file_plan_invalid", "File action lacks source or digest.");
      }
      const targetPath = resolve(action.target);
      const targetRelative = clawContainedRelativePath(workspaceRoot, targetPath);
      if (!targetRelative) {
        throw writeError(
          "workspace_file_path_escape",
          "Workspace file source and destination must remain inside their owned roots.",
        );
      }
      const resolvedSource = await readClawWorkspaceActionSource({
        action,
        packageRoot,
        sourceRoot: source,
      });
      const digest = digestClawBytes(resolvedSource.content);
      if (digest !== action.digest) {
        throw writeError(
          "workspace_source_changed",
          `Workspace source for ${JSON.stringify(action.id)} changed after planning.`,
        );
      }
      assertForwardCurrent();
      const expectedRecord: PersistedClawWorkspaceFile = {
        schemaVersion: CLAW_WORKSPACE_FILE_RECORD_SCHEMA_VERSION,
        agentId: plan.agent.finalId,
        workspace: workspace.rootReal,
        path: targetRelative.replaceAll(sep, "/"),
        sourcePath: resolvedSource.sourceRelative.replaceAll(sep, "/"),
        contentDigest: digest,
        status: "pending",
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
      };
      if (options.stateless) {
        if (await workspace.exists(targetRelative)) {
          throw writeError(
            "workspace_file_collision",
            `Workspace destination ${JSON.stringify(targetRelative)} already exists.`,
          );
        }
        await workspace.write(targetRelative, resolvedSource.content, {
          mkdir: true,
          overwrite: false,
          assertBeforeMutation: assertForwardCurrent,
        });
        createdFiles.push({ ...expectedRecord, status: "complete" });
        continue;
      }
      const existingRecord = await readClawWorkspaceFileForAdd(
        expectedRecord.agentId,
        expectedRecord.path,
        options,
      );
      if (existingRecord && !sameWorkspaceFileOwner(existingRecord, expectedRecord)) {
        throw writeError(
          "workspace_file_ownership_conflict",
          `Workspace destination ${JSON.stringify(targetRelative)} is already claimed by different Claw provenance.`,
        );
      }
      if (await workspace.exists(targetRelative)) {
        if (!existingRecord || existingRecord.status === "failed") {
          throw writeError(
            "workspace_file_collision",
            `Workspace destination ${JSON.stringify(targetRelative)} already exists.`,
          );
        }
        const existingTarget = await workspace.read(targetRelative, {
          hardlinks: "reject",
          maxBytes: MAX_CLAW_WORKSPACE_FILE_BYTES,
          symlinks: "reject",
        });
        if (digestClawBytes(existingTarget.buffer) !== expectedRecord.contentDigest) {
          throw writeError(
            "workspace_file_drift",
            `Claw-owned workspace destination ${JSON.stringify(targetRelative)} no longer matches its recorded content.`,
          );
        }
        const previousStatus = existingRecord.status;
        existingRecord.status = "complete";
        existingRecord.updatedAtMs = nowMs;
        await updateClawWorkspaceFileStatusForAdd(
          existingRecord,
          [previousStatus],
          forwardStateOptions,
        );
        createdFiles.push(existingRecord);
        continue;
      }
      const record = existingRecord ?? expectedRecord;
      if (existingRecord) {
        const previousStatus = record.status;
        record.status = "pending";
        record.updatedAtMs = nowMs;
        await updateClawWorkspaceFileStatusForAdd(record, [previousStatus], forwardStateOptions);
      } else {
        await persistClawWorkspaceFileForAdd(record, forwardStateOptions);
      }
      try {
        assertForwardCurrent();
        await workspace.write(targetRelative, resolvedSource.content, {
          mkdir: true,
          overwrite: false,
          assertBeforeMutation: assertForwardCurrent,
        });
        record.status = "complete";
        await updateClawWorkspaceFileStatusForAdd(record, ["pending"], forwardStateOptions);
        createdFiles.push(record);
      } catch (error) {
        record.status = "failed";
        try {
          await updateClawWorkspaceFileStatusForAdd(record, ["pending"], options);
        } catch {
          // A pending row intentionally remains as evidence of uncertain owner state.
          record.status = "pending";
        }
        createdFiles.push(record);
        throw error;
      }
    } catch (error) {
      if (error instanceof ClawWorkspaceWriteError) {
        throw error;
      }
      const code =
        error instanceof ClawWorkspaceSourceAliasError
          ? "workspace_file_path_alias"
          : error instanceof FsSafeError
            ? `workspace_file_${error.code}`
            : "workspace_file_io_error";
      throw writeError(code, coerceErrorMessage(error));
    }
  }
  return createdFiles;
}
