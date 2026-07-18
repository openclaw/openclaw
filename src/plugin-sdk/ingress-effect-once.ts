import { createClaimableDedupe } from "./persistent-dedupe.js";

/**
 * Create a durable per-event side-effect guard for channel ingress drains.
 *
 * Create one factory per ingress queue/account scope and give that scope a stable, unique
 * `namespacePrefix`; `eventId` only needs to be unique within that queue. Storage failures
 * reject instead of falling back to process memory.
 *
 * `ttlMs` must cover the maximum effect-commit-to-tombstone delay plus the channel's
 * ingress tombstone retention. Older records are dead weight once the tombstone prevents
 * replay. A process death after `run()` succeeds but before the claim commits can still
 * execute the effect again on recovery, as can a storage failure during that commit.
 */
export function createIngressEffectOnce(params: {
  pluginId: string;
  namespacePrefix: string;
  ttlMs: number;
  stateMaxEntries: number;
  memoryMaxSize?: number;
  onDiskError?: (error: unknown) => void;
}): {
  runOnce: <T>(params: {
    eventId: string;
    effect: string;
    run: () => Promise<T>;
  }) => Promise<{ kind: "executed"; value: T } | { kind: "replayed" }>;
} {
  const dedupe = createClaimableDedupe({
    pluginId: params.pluginId,
    namespacePrefix: params.namespacePrefix,
    ttlMs: params.ttlMs,
    stateMaxEntries: params.stateMaxEntries,
    memoryMaxSize: params.memoryMaxSize ?? params.stateMaxEntries,
    onDiskError: (error) => {
      params.onDiskError?.(error);
      throw error;
    },
  });

  return {
    runOnce: async <T>(effectParams: {
      eventId: string;
      effect: string;
      run: () => Promise<T>;
    }): Promise<{ kind: "executed"; value: T } | { kind: "replayed" }> => {
      const key = JSON.stringify([effectParams.effect, effectParams.eventId]);

      while (true) {
        const claim = await dedupe.claim(key);
        if (claim.kind === "duplicate") {
          return { kind: "replayed" };
        }
        if (claim.kind === "inflight") {
          try {
            await claim.pending;
            return { kind: "replayed" };
          } catch {
            // A failed commit clears its optimistic memory marker in the owner continuation.
            await Promise.resolve();
            continue;
          }
        }

        let value: T;
        try {
          value = await effectParams.run();
        } catch (error) {
          dedupe.release(key, { error });
          throw error;
        }
        try {
          await dedupe.commit(key);
        } catch (error) {
          try {
            // forget clears the failed commit's memory marker before its durable delete attempt.
            await dedupe.forget(key, {
              onDiskError: (cleanupError) => {
                throw cleanupError;
              },
            });
          } catch {
            // Keep the original commit error; the configured hook already reported it.
          }
          throw error;
        }
        return { kind: "executed", value };
      }
    },
  };
}
