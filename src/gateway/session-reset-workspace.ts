import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { PreparedGatewaySessionLifecycle } from "./session-create-service.types.js";

/** Reset preserves source choices together unless the caller explicitly detaches the workspace. */
export function buildResetWorkspaceFields(
  currentEntry: InternalSessionEntry | undefined,
  params: Pick<InternalSessionEntry, "spawnedCwd" | "sessionRoot" | "permissionMode"> & {
    clearSpawnedCwd?: boolean;
  },
  preparedLifecycle?: PreparedGatewaySessionLifecycle,
) {
  return {
    spawnedWorkspaceDir: currentEntry?.spawnedWorkspaceDir,
    spawnedCwd: params.clearSpawnedCwd
      ? undefined
      : (preparedLifecycle?.spawnedCwd ?? params.spawnedCwd ?? currentEntry?.spawnedCwd),
    sessionRoot: params.clearSpawnedCwd
      ? undefined
      : (preparedLifecycle?.sessionRoot ?? params.sessionRoot ?? currentEntry?.sessionRoot),
    permissionMode: params.clearSpawnedCwd
      ? undefined
      : (params.permissionMode ?? currentEntry?.permissionMode),
    // Reset keeps this logical chat's authorized containment choice.
    sandboxMode: currentEntry?.sandboxMode,
    worktree: params.clearSpawnedCwd
      ? undefined
      : (preparedLifecycle?.worktree ?? currentEntry?.worktree),
    priorWorkspace: params.clearSpawnedCwd ? undefined : currentEntry?.priorWorkspace,
    repositoryWorkspaceId:
      preparedLifecycle?.repositoryWorkspaceId ?? currentEntry?.repositoryWorkspaceId,
    // Placement can be retired by reset; the logical chat must still stay on its device.
    deviceFolder: currentEntry?.deviceFolder ? { ...currentEntry.deviceFolder } : undefined,
  };
}
