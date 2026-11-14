import { asOptionalRecord as readRecord } from "@openclaw/normalization-core/record-coerce";

export type WorkerWorkspaceResultConflict = {
  paths: string[];
  stagedResultRef: string;
  totalCount?: number;
};

export type WorkerWorkspaceConflictReport =
  | Required<WorkerWorkspaceResultConflict>
  | { cleared: true };

export type WorkspaceResultConflictLookup =
  | { kind: "absent" }
  | { kind: "conflict"; conflict: Required<WorkerWorkspaceResultConflict> }
  | { kind: "unknown"; reason: WorkspaceResultConflictUnknownReason };
type WorkspaceResultConflictUnknownReason = "malformed-report" | "session-unavailable";

export const WORKSPACE_CONFLICT_TRANSCRIPT_TYPE = "cloud-workspace-conflict";
export const WORKSPACE_CONFLICT_CLEARED_TRANSCRIPT_TYPE = "cloud-workspace-conflict-cleared";
export const WORKSPACE_RECOVERY_FAILURE_TRANSCRIPT_TYPE = "cloud-workspace-recovery-failed";
export const WORKSPACE_HISTORY_NOTE_TRANSCRIPT_TYPE = "cloud-workspace-history-note";

const MAX_PROJECTED_CONFLICT_PATHS = 256;
const MAX_PROJECTED_CONFLICT_PATH_BYTES = 32 * 1024;

export function projectWorkspaceResultConflict(
  paths: readonly string[],
  stagedResultRef: string,
  knownTotalCount?: number,
): Required<WorkerWorkspaceResultConflict> {
  const uniquePaths = [...new Set(paths)].toSorted();
  const projectedPaths: string[] = [];
  let projectedBytes = 0;
  for (const entryPath of uniquePaths) {
    const bytes = Buffer.byteLength(entryPath);
    if (
      projectedPaths.length >= MAX_PROJECTED_CONFLICT_PATHS ||
      projectedBytes + bytes > MAX_PROJECTED_CONFLICT_PATH_BYTES
    ) {
      break;
    }
    projectedPaths.push(entryPath);
    projectedBytes += bytes;
  }
  if (projectedPaths.length === 0) {
    throw new Error("Cloud workspace result conflict projection has no bounded path");
  }
  return {
    paths: projectedPaths,
    stagedResultRef,
    totalCount: Math.max(knownTotalCount ?? uniquePaths.length, uniquePaths.length),
  };
}

export function projectWorkspaceConflictDetails(
  entry: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (entry.role !== "custom" || entry.customType !== WORKSPACE_CONFLICT_TRANSCRIPT_TYPE) {
    return undefined;
  }
  const details = readRecord(entry.details);
  const totalCount = details?.totalCount;
  if (
    !details ||
    !Array.isArray(details.paths) ||
    details.paths.length === 0 ||
    !details.paths.every(
      (entryPath): entryPath is string => typeof entryPath === "string" && entryPath.length > 0,
    ) ||
    typeof details.stagedResultRef !== "string" ||
    !/^refs\/openclaw\/worker-results\/[A-Za-z0-9-]+$/u.test(details.stagedResultRef) ||
    (totalCount !== undefined &&
      (typeof totalCount !== "number" ||
        !Number.isSafeInteger(totalCount) ||
        totalCount < details.paths.length))
  ) {
    return undefined;
  }
  try {
    return projectWorkspaceResultConflict(details.paths, details.stagedResultRef, totalCount);
  } catch {
    return undefined;
  }
}

export function formatWorkspaceConflictSummary(
  paths: readonly string[],
  stagedResultRef: string,
  totalCount = paths.length,
): string {
  const visibleLimit = 20;
  const visiblePaths = paths.slice(0, visibleLimit);
  const visible = visiblePaths.join(", ");
  const remainder =
    totalCount > visiblePaths.length ? ` (+${totalCount - visiblePaths.length} more)` : "";
  return `Cloud result applied with ${totalCount} conflict(s); kept local versions: ${visible}${remainder}. Cloud versions staged at ${stagedResultRef}.`;
}
