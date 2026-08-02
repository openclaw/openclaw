// Decides which existing workspace files an adopting Claw add may claim without rewriting them.
import { createHash } from "node:crypto";
import { FsSafeError, root as fsSafeRoot, type Root } from "../infra/fs-safe.js";
import { MAX_MANAGED_FILE_BYTES } from "./source-limits.js";
import type { ClawAddPlanAction, ClawDiagnostic } from "./types.js";

type AdoptionPendingFile = {
  action: ClawAddPlanAction;
  manifestPath: string;
};

type AdoptableTargetState =
  | { state: "absent" }
  | { state: "unsafe" }
  | { state: "adoptable"; digest: string };

function adoptionBlocker(path: string, message: string): ClawDiagnostic {
  return { level: "error", code: "workspace_file_conflict", phase: "plan", path, message };
}

// Planning reads adoptable destinations through the same safe-file contract the mutation path
// uses. A destination only apply would reject (symlink, hardlink, oversized) has to block before
// consent, or apply commits the agent config first and leaves the operator a partial install.
async function readAdoptableTarget(
  workspaceRoot: Root,
  targetPath: string,
): Promise<AdoptableTargetState> {
  try {
    const read = await workspaceRoot.read(targetPath, {
      hardlinks: "reject",
      maxBytes: MAX_MANAGED_FILE_BYTES,
      symlinks: "reject",
    });
    return {
      state: "adoptable",
      digest: `sha256:${createHash("sha256").update(read.buffer).digest("hex")}`,
    };
  } catch (error) {
    if (error instanceof FsSafeError && error.code === "not-found") {
      return { state: "absent" };
    }
    return { state: "unsafe" };
  }
}

/**
 * Marks every declared file that already exists with identical content as an `adopt` action and
 * blocks the rest. Mutates the passed actions in place and returns the plan blockers to record.
 */
export async function planWorkspaceAdoptionTargets(params: {
  workspace: string;
  pendingFiles: readonly AdoptionPendingFile[];
}): Promise<ClawDiagnostic[]> {
  const workspaceRoot = await fsSafeRoot(params.workspace);
  const blockers: ClawDiagnostic[] = [];
  for (const pending of params.pendingFiles) {
    if (pending.action.blocked || !pending.action.digest) {
      continue;
    }
    const existing = await readAdoptableTarget(workspaceRoot, pending.action.id);
    if (existing.state === "absent") {
      continue;
    }
    if (existing.state === "adoptable" && existing.digest === pending.action.digest) {
      pending.action.action = "adopt";
      pending.action.details = { ...pending.action.details, expectedState: "existing-identical" };
      continue;
    }
    const diagnostic = adoptionBlocker(
      pending.manifestPath,
      existing.state === "unsafe"
        ? `Adoptable workspace destination ${JSON.stringify(pending.action.target)} must be a readable regular file inside the workspace, with no symlink or hardlink, within managed size limits.`
        : `Workspace destination ${JSON.stringify(pending.action.target)} exists with different content; adoption never overwrites existing files.`,
    );
    pending.action.blocked = true;
    pending.action.reason = diagnostic.message;
    blockers.push(diagnostic);
  }
  return blockers;
}
