/**
 * Synchronous predicate: does `sessionKey` have pending spawned subagent runs?
 * Runs on the outbound plan hot path, so implementations must be cheap/bounded
 * (default in `subagent-registry.ts` is an in-memory map lookup). Internal to
 * core; not re-exported through `openclaw/plugin-sdk`.
 */
export type PendingSpawnedChildrenQuery = (sessionKey?: string) => boolean;
export declare function registerPendingSpawnedChildrenQuery(query: PendingSpawnedChildrenQuery | undefined): PendingSpawnedChildrenQuery | undefined;
export declare function resolvePendingSpawnedChildren(sessionKey: string | undefined): boolean;
