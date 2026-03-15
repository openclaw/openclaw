import type { EmbeddingProvider } from "./embedding-runtime.js";
import {
  type EmbeddingIndexMeta,
  type EmbeddingMemorySource,
  resolveEmbeddingSyncPlan,
} from "./embedding-sync-planning.js";

type EmbeddingSyncProgress = unknown;

type EmbeddingSyncMemoryFiles<TProgress = EmbeddingSyncProgress> = (params: {
  needsFullReindex: boolean;
  progress?: TProgress;
}) => Promise<void>;

type EmbeddingSyncSessionFiles<TProgress = EmbeddingSyncProgress> = (params: {
  needsFullReindex: boolean;
  targetSessionFiles?: string[];
  progress?: TProgress;
}) => Promise<void>;

type EmbeddingReindex<TProgress = EmbeddingSyncProgress> = (params: {
  reason?: string;
  force?: boolean;
  progress?: TProgress;
}) => Promise<void>;

export async function runExtensionHostEmbeddingSync<TProgress = EmbeddingSyncProgress>(params: {
  reason?: string;
  force?: boolean;
  targetSessionFiles: Set<string> | null;
  vectorReady: boolean;
  meta: EmbeddingIndexMeta | null;
  configuredSources: EmbeddingMemorySource[];
  configuredScopeHash: string;
  provider: EmbeddingProvider | null;
  providerKey: string | null;
  chunkTokens: number;
  chunkOverlap: number;
  sessionsEnabled: boolean;
  dirty: boolean;
  shouldSyncSessions: boolean;
  useUnsafeReindex: boolean;
  hasDirtySessionFiles: boolean;
  progress?: TProgress;
  syncMemoryFiles: EmbeddingSyncMemoryFiles<TProgress>;
  syncSessionFiles: EmbeddingSyncSessionFiles<TProgress>;
  clearSyncedSessionFiles: (targetSessionFiles?: Iterable<string> | null) => void;
  clearAllSessionDirtyFiles: () => void;
  setDirty: (value: boolean) => void;
  setSessionsDirty: (value: boolean) => void;
  shouldFallbackOnError: (message: string) => boolean;
  activateFallbackProvider: (reason: string) => Promise<boolean>;
  runSafeReindex: EmbeddingReindex<TProgress>;
  runUnsafeReindex: EmbeddingReindex<TProgress>;
}): Promise<void> {
  const hasTargetSessionFiles = params.targetSessionFiles !== null;
  const syncPlan = resolveEmbeddingSyncPlan({
    force: params.force,
    hasTargetSessionFiles,
    targetSessionFiles: params.targetSessionFiles,
    sessionsEnabled: params.sessionsEnabled,
    dirty: params.dirty,
    shouldSyncSessions: params.shouldSyncSessions,
    useUnsafeReindex: params.useUnsafeReindex,
    vectorReady: params.vectorReady,
    meta: params.meta,
    provider: params.provider,
    providerKey: params.providerKey,
    configuredSources: params.configuredSources,
    configuredScopeHash: params.configuredScopeHash,
    chunkTokens: params.chunkTokens,
    chunkOverlap: params.chunkOverlap,
  });

  if (syncPlan.kind === "targeted-sessions") {
    try {
      await params.syncSessionFiles({
        needsFullReindex: false,
        targetSessionFiles: syncPlan.targetSessionFiles,
        progress: params.progress,
      });
      params.clearSyncedSessionFiles(new Set(syncPlan.targetSessionFiles));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const activated =
        params.shouldFallbackOnError(reason) && (await params.activateFallbackProvider(reason));
      if (activated) {
        const reindexParams = {
          reason: params.reason,
          force: true,
          progress: params.progress,
        };
        if (params.useUnsafeReindex) {
          await params.runUnsafeReindex(reindexParams);
        } else {
          await params.runSafeReindex(reindexParams);
        }
        return;
      }
      throw err;
    }
    return;
  }

  try {
    if (syncPlan.kind === "full-reindex") {
      const reindexParams = {
        reason: params.reason,
        force: params.force,
        progress: params.progress,
      };
      if (syncPlan.unsafe) {
        await params.runUnsafeReindex(reindexParams);
      } else {
        await params.runSafeReindex(reindexParams);
      }
      return;
    }

    if (syncPlan.shouldSyncMemory) {
      await params.syncMemoryFiles({
        needsFullReindex: false,
        progress: params.progress,
      });
      params.setDirty(false);
    }

    if (syncPlan.shouldSyncSessions) {
      await params.syncSessionFiles({
        needsFullReindex: false,
        targetSessionFiles: syncPlan.targetSessionFiles,
        progress: params.progress,
      });
      params.setSessionsDirty(false);
      params.clearAllSessionDirtyFiles();
    } else {
      params.setSessionsDirty(params.hasDirtySessionFiles);
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const activated =
      params.shouldFallbackOnError(reason) && (await params.activateFallbackProvider(reason));
    if (activated) {
      await params.runSafeReindex({
        reason: params.reason ?? "fallback",
        force: true,
        progress: params.progress,
      });
      return;
    }
    throw err;
  }
}
