const pendingSpawnedWorkspaceOverrides = new Map<string, string>();

function normalizeSessionKey(value?: string | null): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeWorkspaceDir(value?: string | null): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function setPendingSpawnedWorkspaceOverride(params: {
  sessionKey?: string | null;
  workspaceDir?: string | null;
}) {
  const sessionKey = normalizeSessionKey(params.sessionKey);
  if (!sessionKey) {
    return;
  }
  const workspaceDir = normalizeWorkspaceDir(params.workspaceDir);
  if (!workspaceDir) {
    pendingSpawnedWorkspaceOverrides.delete(sessionKey);
    return;
  }
  pendingSpawnedWorkspaceOverrides.set(sessionKey, workspaceDir);
}

export function consumePendingSpawnedWorkspaceOverride(
  sessionKey?: string | null,
): string | undefined {
  const normalizedKey = normalizeSessionKey(sessionKey);
  if (!normalizedKey) {
    return undefined;
  }
  const workspaceDir = pendingSpawnedWorkspaceOverrides.get(normalizedKey);
  pendingSpawnedWorkspaceOverrides.delete(normalizedKey);
  return workspaceDir;
}

export function clearPendingSpawnedWorkspaceOverride(sessionKey?: string | null) {
  const normalizedKey = normalizeSessionKey(sessionKey);
  if (!normalizedKey) {
    return;
  }
  pendingSpawnedWorkspaceOverrides.delete(normalizedKey);
}
