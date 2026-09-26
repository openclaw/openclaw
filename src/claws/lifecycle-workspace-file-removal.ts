import { removeClawWorkspaceFile } from "./lifecycle-delete-support.js";
import type { ClawRemovePlanAction } from "./lifecycle-remove-contract.js";
import type { RemovedWorkspaceFile } from "./lifecycle-remove-types.js";
import type { ClawStatusRecord } from "./lifecycle-status.js";
import {
  clawBootstrapPublicationMatches,
  openClawBootstrapRemovalAuthority,
} from "./workspace-origin.js";

function isUnclaimedAdoptedWorkspaceFile(
  record: ClawStatusRecord | undefined,
  unclaimed: boolean,
  path: string,
): boolean {
  return (
    unclaimed &&
    record?.workspaceOrigin.adopted === true &&
    record.workspaceOrigin.adoptedFiles.includes(path)
  );
}

function isUnclaimedAdoptedWorkspaceFileUnowned(
  record: ClawStatusRecord | undefined,
  unclaimed: boolean,
  file: Pick<ClawStatusRecord["workspaceFiles"][number], "workspace" | "path" | "state">,
): boolean {
  if (file.state === "missing" || !unclaimed || record?.workspaceOrigin.adopted !== true) {
    return false;
  }
  return (
    isUnclaimedAdoptedWorkspaceFile(record, unclaimed, file.path) ||
    !clawBootstrapPublicationMatches(
      file.workspace,
      record.workspaceOrigin.filePublications?.[file.path],
      file.path,
    )
  );
}

export function planClawWorkspaceFileRemoval(
  record: ClawStatusRecord,
  unclaimed: boolean,
): ClawRemovePlanAction[] {
  return record.workspaceFiles.map((file) => {
    const operatorOwned = isUnclaimedAdoptedWorkspaceFileUnowned(record, unclaimed, file);
    return {
      kind: "workspaceFile",
      id: file.path,
      action: !operatorOwned && file.state === "unchanged" ? "delete" : "retain",
      target: `${file.workspace}:${file.path}`,
      blocked: !operatorOwned && file.state === "unsafe",
      details: {
        expectedState: file.state,
        contentDigest: file.contentDigest,
        workspace: file.workspace,
      },
      ...(operatorOwned
        ? { reason: "This unclaimed adoption does not own the current workspace file." }
        : file.state === "modified"
          ? { reason: "Local content changed; preserve the file." }
          : {}),
    };
  });
}

export function clawWorkspaceFileRemovalBlockers(
  record: ClawStatusRecord | undefined,
  unclaimed: boolean,
): Array<{ code: "workspace_file_unsafe"; message: string }> {
  return (record?.workspaceFiles ?? []).flatMap((file) =>
    file.state === "unsafe" && !isUnclaimedAdoptedWorkspaceFileUnowned(record, unclaimed, file)
      ? [
          {
            code: "workspace_file_unsafe" as const,
            message: `${file.path}: ${file.message ?? "unsafe file"}`,
          },
        ]
      : [],
  );
}

export async function applyClawWorkspaceFileRemovals(
  record: ClawStatusRecord,
  unclaimed: boolean,
  assertCurrent: () => void,
  results: RemovedWorkspaceFile[],
): Promise<void> {
  for (const file of record.workspaceFiles) {
    assertCurrent();
    if (isUnclaimedAdoptedWorkspaceFileUnowned(record, unclaimed, file)) {
      results.push({ path: file.path, action: "retainedUnowned" });
      continue;
    }
    if (!unclaimed || !record.workspaceOrigin.adopted) {
      results.push(await removeClawWorkspaceFile(file, assertCurrent));
      continue;
    }
    const authority = openClawBootstrapRemovalAuthority({
      workspace: file.workspace,
      relativePath: file.path,
      publication: record.workspaceOrigin.filePublications?.[file.path],
    });
    try {
      results.push(
        authority.owned
          ? await removeClawWorkspaceFile(file, assertCurrent, undefined, authority.ownsFile)
          : { path: file.path, action: authority.missing ? "missing" : "retainedUnowned" },
      );
    } finally {
      if (authority.owned) {
        authority.close();
      }
    }
  }
}
