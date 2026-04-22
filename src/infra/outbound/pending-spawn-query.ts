export type PendingSpawnedChildrenQuery = (sessionKey?: string) => boolean;

let pendingSpawnedChildrenQuery: PendingSpawnedChildrenQuery | undefined;

export function registerPendingSpawnedChildrenQuery(
  query: PendingSpawnedChildrenQuery | undefined,
): void {
  pendingSpawnedChildrenQuery = query;
}

export function resolvePendingSpawnedChildren(sessionKey: string | undefined): boolean {
  if (!pendingSpawnedChildrenQuery) {
    return false;
  }
  try {
    return pendingSpawnedChildrenQuery(sessionKey);
  } catch {
    return false;
  }
}
