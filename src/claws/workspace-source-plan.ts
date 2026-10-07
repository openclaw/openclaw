import { resolve } from "node:path";
import { assertNoSymlinkParents } from "@openclaw/fs-safe/advanced";
import { FsSafeError, type Root } from "../infra/fs-safe.js";
import { MAX_MANAGED_FILE_BYTES, MAX_MANAGED_WORKSPACE_BYTES } from "./source-limits.js";
import type { ClawAddPlanAction, ClawDiagnostic, ClawSourceIdentity } from "./types.js";

export type PendingWorkspaceFileAction = {
  action: ClawAddPlanAction;
  sourcePath: string;
  manifestPath: string;
  byteLength: number;
  content?: Buffer;
};

export function workspaceSourceErrorCode(
  error: unknown,
): "workspace_source_invalid" | "workspace_source_unsafe" | "workspace_source_too_large" {
  if (error instanceof FsSafeError) {
    if (error.code === "too-large") {
      return "workspace_source_too_large";
    }
    if (error.code === "symlink" || error.code === "hardlink" || error.code === "path-mismatch") {
      return "workspace_source_unsafe";
    }
  }
  if (error instanceof Error && error.message.includes("symlinked directory")) {
    return "workspace_source_unsafe";
  }
  return "workspace_source_invalid";
}

export function workspaceSourceMessage(code: string, sourcePath: string): string {
  if (code === "workspace_source_too_large") {
    return `Workspace source ${JSON.stringify(sourcePath)} exceeds ${MAX_MANAGED_FILE_BYTES} bytes.`;
  }
  if (code === "workspace_sources_too_large") {
    return `Workspace sources exceed ${MAX_MANAGED_WORKSPACE_BYTES} aggregate bytes.`;
  }
  if (code === "workspace_source_unsafe") {
    return `Workspace source ${JSON.stringify(sourcePath)} must be a regular, non-symlinked, non-hardlinked file.`;
  }
  return `Workspace source ${JSON.stringify(sourcePath)} must resolve to a file inside the Claw package.`;
}

export async function inspectWorkspaceFileAction(params: {
  sourceRoot: Root;
  source: ClawSourceIdentity;
  workspace: string;
  sourcePath: string;
  targetPath: string;
  id: string;
  manifestPath: string;
}): Promise<PendingWorkspaceFileAction | { action: ClawAddPlanAction; blocker: ClawDiagnostic }> {
  const requestedSource = resolve(params.source.packageRoot, params.sourcePath);
  const requestedTarget = resolve(params.workspace, params.targetPath);
  try {
    await assertNoSymlinkParents({
      rootDir: params.source.packageRoot,
      targetPath: requestedSource,
      allowMissing: false,
      messagePrefix: "Workspace source",
    });
    const opened = await params.sourceRoot.open(params.sourcePath, {
      hardlinks: "reject",
      symlinks: "reject",
    });
    await opened[Symbol.asyncDispose]();
    if (opened.stat.size > MAX_MANAGED_FILE_BYTES) {
      throw new FsSafeError(
        "too-large",
        `file exceeds limit of ${MAX_MANAGED_FILE_BYTES} bytes (got ${opened.stat.size})`,
      );
    }
    return {
      sourcePath: params.sourcePath,
      manifestPath: params.manifestPath,
      byteLength: opened.stat.size,
      action: {
        kind: "workspaceFile",
        id: params.id,
        action: "write",
        target: requestedTarget,
        source: opened.realPath,
        details: { expectedState: "absent" },
        blocked: false,
      },
    };
  } catch (error) {
    const code = workspaceSourceErrorCode(error);
    const message = workspaceSourceMessage(code, params.sourcePath);
    const diagnostic: ClawDiagnostic = {
      level: "error",
      code,
      phase: "plan",
      path: params.manifestPath,
      message,
    };
    return {
      action: {
        kind: "workspaceFile",
        id: params.id,
        action: "write",
        target: requestedTarget,
        source: requestedSource,
        blocked: true,
        reason: diagnostic.message,
      },
      blocker: diagnostic,
    };
  }
}
