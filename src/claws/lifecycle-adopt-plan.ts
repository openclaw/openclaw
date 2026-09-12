// Decides which existing workspace files an adopting Claw add may claim without rewriting them.
import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { FsSafeError, root as fsSafeRoot, type Root } from "../infra/fs-safe.js";
import { MAX_MANAGED_FILE_BYTES } from "./source-limits.js";
import type { ClawAddCapabilityChange, ClawAddPlanAction, ClawDiagnostic } from "./types.js";
import type { PersistedClawWorkspaceFile } from "./workspace.js";

type AdoptionPendingFile = {
  action: ClawAddPlanAction;
  manifestPath: string;
};

type AdoptableTargetState =
  | { state: "absent" }
  | { state: "unsafe" }
  | { state: "adoptable"; digest: string };

type WorkspaceDiskState =
  | { state: "absent" }
  | { state: "uninspectable" }
  | { state: "present"; isDirectory: boolean };

// Only ENOENT proves absence. Permission, symlink-loop, and IO failures leave the path unknown, and
// planning must not read unknown as free space: apply already refuses an uninspectable workspace
// (`workspace_parent_failed` in add.ts), so a plan that approves one strands the operator mid-install.
async function readWorkspaceDiskState(workspace: string): Promise<WorkspaceDiskState> {
  try {
    return { state: "present", isDirectory: (await lstat(workspace)).isDirectory() };
  } catch (error) {
    const absent =
      typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
    return absent ? { state: "absent" } : { state: "uninspectable" };
  }
}

function adoptionBlocker(path: string, message: string): ClawDiagnostic {
  return { level: "error", code: "workspace_file_conflict", phase: "plan", path, message };
}

/** Describes the distinct consent required to claim an existing workspace directory. */
export function workspaceAdoptionCapabilityChange(
  agentId: string,
  workspace: string,
): Omit<ClawAddCapabilityChange, "classification" | "requiresDistinctConsent" | "digest"> {
  return {
    kind: "agent",
    id: agentId,
    path: "workspace",
    action: "configure",
    reason:
      "The Claw adopts an existing workspace directory; declared files must already match or be absent.",
    effect: { workspace, adoptExistingWorkspace: true },
  };
}

/** Plans the workspace-level adoption decision before declared files are inspected. */
export async function planWorkspaceAdoption(params: {
  agentId: string;
  workspace: string;
  requested: boolean;
  configuredWorkspaceConflict: boolean;
  resumableWorkspace?: string;
}): Promise<{
  adopted: boolean;
  action: ClawAddPlanAction;
  blockers: ClawDiagnostic[];
}> {
  const disk = await readWorkspaceDiskState(params.workspace);
  if (disk.state === "uninspectable") {
    const message = `Workspace ${JSON.stringify(params.workspace)} cannot be inspected; adoption requires a workspace path this account can read.`;
    return {
      adopted: false,
      blockers: [
        {
          level: "error",
          code: "workspace_parent_failed",
          phase: "plan",
          path: "$.workspace",
          message,
        },
      ],
      action: {
        kind: "workspace",
        id: params.agentId,
        action: "create",
        target: params.workspace,
        details: { expectedState: "uninspectable" },
        blocked: true,
        reason: message,
      },
    };
  }
  const workspaceExistsOnDisk = disk.state === "present";
  const adopted =
    params.requested &&
    disk.state === "present" &&
    disk.isDirectory &&
    !params.configuredWorkspaceConflict;
  const blocked =
    !adopted &&
    (params.configuredWorkspaceConflict ||
      (workspaceExistsOnDisk && params.resumableWorkspace !== params.workspace));
  // Overlap gets its own message regardless of requested/disk state: the conflicting path is
  // frequently absent on disk (a brand-new subdirectory of another agent's workspace), so the
  // "already exists" wording below would misstate why the plan blocked.
  const conflictMessage = `Workspace ${JSON.stringify(params.workspace)} overlaps another agent's configured workspace.`;
  const blockers: ClawDiagnostic[] = [];
  if (blocked) {
    blockers.push({
      level: "error",
      code: "workspace_collision",
      phase: "plan",
      path: "$.workspace",
      message: params.configuredWorkspaceConflict
        ? conflictMessage
        : params.requested && workspaceExistsOnDisk
          ? `Workspace ${JSON.stringify(params.workspace)} cannot be adopted; it is not a directory.`
          : `Workspace ${JSON.stringify(params.workspace)} already exists; a Claw requires a new workspace.`,
    });
  }
  return {
    adopted,
    blockers,
    action: {
      kind: "workspace",
      id: params.agentId,
      action: adopted ? "adopt" : "create",
      target: params.workspace,
      details: { expectedState: adopted ? "existing-directory" : "absent" },
      blocked,
      ...(blocked
        ? {
            reason: params.configuredWorkspaceConflict
              ? conflictMessage
              : `Workspace ${JSON.stringify(params.workspace)} already exists.`,
          }
        : {}),
    },
  };
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

/** Ownership evidence from a prior attempt of the same resumed adoption, used to re-plan by
 * consent instead of disk presence: everything the operator already consented to adopt or that
 * this install already wrote must round-trip to the same action, even though both now exist. */
export type WorkspaceAdoptionOwnership = {
  adoptedFiles: readonly string[];
  ownedFiles: readonly PersistedClawWorkspaceFile[];
  bootstrapSeeded: boolean;
};

/**
 * Marks every declared file that already exists with identical content as an `adopt` action and
 * blocks the rest. Mutates the passed actions in place and returns the plan blockers to record.
 */
export async function planWorkspaceAdoptionTargets(params: {
  workspace: string;
  pendingFiles: readonly AdoptionPendingFile[];
  packageBootstrap?: ClawAddPlanAction;
  ownership?: WorkspaceAdoptionOwnership;
}): Promise<ClawDiagnostic[]> {
  const workspaceRoot = await fsSafeRoot(params.workspace);
  const blockers: ClawDiagnostic[] = [];

  if (params.packageBootstrap && !params.packageBootstrap.blocked) {
    const existing = await readAdoptableTarget(workspaceRoot, params.packageBootstrap.id);
    // A prior attempt of this same adoption seeds BOOTSTRAP.md before later phases can fail; a
    // resume sees the identical digest it already wrote and must not read its own seed as a
    // fresh operator conflict (seedWorkspaceBootstrap treats it as "already-seeded"). The waiver
    // requires this install's own recorded seed, not just a matching digest: an operator-created
    // BOOTSTRAP.md that happens to match byte-for-byte must still block, never adopt silently.
    const alreadySeeded =
      existing.state === "adoptable" &&
      params.ownership?.bootstrapSeeded === true &&
      existing.digest === params.packageBootstrap.digest;
    if (existing.state !== "absent" && !alreadySeeded) {
      const diagnostic = adoptionBlocker(
        "$packageBootstrap",
        existing.state === "unsafe"
          ? `Package BOOTSTRAP.md destination ${JSON.stringify(params.packageBootstrap.target)} must be absent; the existing path is not a safe regular file.`
          : `Package BOOTSTRAP.md destination ${JSON.stringify(params.packageBootstrap.target)} already exists; adoption never claims operator-owned native bootstrap content.`,
      );
      params.packageBootstrap.blocked = true;
      params.packageBootstrap.reason = diagnostic.message;
      blockers.push(diagnostic);
    }
  }

  const consentedAdopted = params.ownership ? new Set(params.ownership.adoptedFiles) : undefined;
  const ownedByPath = params.ownership
    ? new Map(params.ownership.ownedFiles.map((file) => [file.path, file] as const))
    : undefined;
  const block = (pending: AdoptionPendingFile, message: string): void => {
    const diagnostic = adoptionBlocker(pending.manifestPath, message);
    pending.action.blocked = true;
    pending.action.reason = diagnostic.message;
    blockers.push(diagnostic);
  };
  const unsafeMessage = (target: string): string =>
    `Adoptable workspace destination ${JSON.stringify(target)} must be a readable regular file inside the workspace, with no symlink or hardlink, within managed size limits.`;

  for (const pending of params.pendingFiles) {
    if (pending.action.blocked || !pending.action.digest) {
      continue;
    }
    const existing = await readAdoptableTarget(workspaceRoot, pending.action.id);
    const identical = existing.state === "adoptable" && existing.digest === pending.action.digest;

    // No resume in progress, or this id was itself consented to adopt on the plan the operator
    // already approved: identical content adopts, anything else blocks as a first attempt would.
    if (!consentedAdopted || consentedAdopted.has(pending.action.id)) {
      if (existing.state === "absent") {
        continue;
      }
      if (identical) {
        pending.action.action = "adopt";
        pending.action.details = { ...pending.action.details, expectedState: "existing-identical" };
        continue;
      }
      block(
        pending,
        existing.state === "unsafe"
          ? unsafeMessage(pending.action.target)
          : `Workspace destination ${JSON.stringify(pending.action.target)} exists with different content; adoption never overwrites existing files.`,
      );
      continue;
    }

    // Not consented to adopt: this destination stays a `write`. It may already exist because a
    // prior attempt of this same resumed install wrote it; the writer (workspace.ts) re-verifies
    // the recorded digest and completes it. Anything else here is genuinely unowned or drifted.
    if (existing.state === "absent") {
      continue;
    }
    const owned = ownedByPath?.get(pending.action.id);
    if (
      identical &&
      owned &&
      owned.contentDigest === pending.action.digest &&
      owned.status !== "failed"
    ) {
      continue;
    }
    block(
      pending,
      existing.state === "unsafe"
        ? unsafeMessage(pending.action.target)
        : `Workspace destination ${JSON.stringify(pending.action.target)} exists but is not owned by this install; adoption never claims content it was not consented to adopt.`,
    );
  }
  return blockers;
}
