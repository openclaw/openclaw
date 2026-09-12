/** Coordinates plugin metadata snapshot and process memo cache lifecycle resets. */
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  clearCurrentPluginMetadataSnapshot,
  isGatewayPluginMetadataSnapshotActive,
  selectCurrentPluginMetadataCache,
} from "./current-plugin-metadata-state.js";
import type { PluginHostCleanupResult } from "./host-hook-cleanup.types.js";
import {
  getPluginCache,
  getPluginCacheRetention,
  getPluginMetadataSnapshotCache,
  getProcessPluginCache,
  resetPluginCache,
  retirePluginCache,
  withPluginCache,
  type PluginCache,
} from "./plugin-cache.js";
import type { PluginMetadataSnapshot } from "./plugin-metadata-snapshot.types.js";
import { PluginRuntimeCloseRetainedError } from "./runtime-close-error.js";

const pluginMetadataProcessMemoClears = new Set<() => void>();
type GatewayMetadataOwner = {
  cache?: PluginCache;
  phase: "booting" | "active" | "closing";
  closing?: Promise<void>;
  retirements: Set<{
    cache: PluginCache;
    beforeRetire?: () => Promise<PluginHostCleanupResult>;
    prerequisite?: Promise<PluginHostCleanupResult | undefined>;
    promise?: Promise<PluginHostCleanupResult>;
  }>;
};
const gatewayMetadataOwners = resolveGlobalSingleton<Set<GatewayMetadataOwner>>(
  Symbol.for("openclaw.gatewayPluginMetadataOwners"),
  () => new Set(),
);

function hasClosingGateway(): boolean {
  return [...gatewayMetadataOwners].some((owner) => owner.phase === "closing");
}

/** The kernel owns bootstrap acquisition, published inventory, and unfinished retirement. */
export function retainGatewayPluginMetadata() {
  const bootstrapCache = getPluginCache();
  if (hasClosingGateway() || bootstrapCache.retirement) {
    throw new Error(
      "Gateway plugin metadata is shutting down; finish cleanup before starting another Gateway. If cleanup failed, resolve the failure and restart.",
    );
  }
  const owner: GatewayMetadataOwner = {
    cache: bootstrapCache,
    phase: "booting",
    retirements: new Set(),
  };
  gatewayMetadataOwners.add(owner);
  const releaseCache = (
    cache: PluginCache | undefined,
    beforeRetire?: () => Promise<PluginHostCleanupResult>,
  ) => {
    if (cache) {
      owner.retirements.add({ cache, beforeRetire });
    }
  };
  const waitForRetirement = async (
    required: readonly Promise<void | PluginHostCleanupResult>[] = [],
  ): Promise<PluginHostCleanupResult> => {
    const results = await Promise.allSettled([
      ...required,
      ...[...owner.retirements].map((retirement) => {
        const prerequisite = (retirement.prerequisite ??= Promise.resolve().then(() =>
          retirement.beforeRetire?.(),
        ));
        const pending = (retirement.promise ??= prerequisite.then(async (previous) => {
          const { cache } = retirement;
          let cleanup: PluginHostCleanupResult | undefined;
          // A startup admitted before this join can still acquire the released inventory.
          if (![...gatewayMetadataOwners].some((other) => other.cache === cache)) {
            cleanup = await retirePluginCache(cache, () => {
              // Keep shared setup entries visible to borrowed old scopes until teardown starts.
              const retained = new Set(
                [...gatewayMetadataOwners].flatMap((other) =>
                  Array.from(other.cache?.setupModules.values() ?? []),
                ),
              );
              for (const [key, instance] of cache.setupModules) {
                if (retained.has(instance)) {
                  cache.setupModules.delete(key);
                }
              }
            });
          }
          owner.retirements.delete(retirement);
          return {
            cleanupCount: (previous?.cleanupCount ?? 0) + (cleanup?.cleanupCount ?? 0),
            failures: [...(previous?.failures ?? []), ...(cleanup?.failures ?? [])],
          };
        }));
        // Publication must not await the conversation that requested it. Its exact
        // generation releases the borrow; shutdown and later joins retain failures.
        void pending.catch(() => {});
        return owner.phase !== "closing" &&
          retirement.cache.kind === "process" &&
          getPluginCacheRetention(retirement.cache)
          ? prerequisite
          : pending;
      }),
    ]);
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length) {
      throw new AggregateError(failures, "Gateway plugin metadata cleanup failed");
    }
    const completed = results.flatMap((result) =>
      result.status === "fulfilled" && result.value ? [result.value] : [],
    );
    return {
      cleanupCount: completed.reduce((count, result) => count + result.cleanupCount, 0),
      failures: completed.flatMap((result) => result.failures),
    };
  };
  const beginClose = () => {
    owner.phase = "closing";
  };
  return {
    // Fence admission before teardown can fail, without retiring a live sibling's inventory.
    beginClose,
    runBootstrap<T>(run: () => T): T {
      if (owner.phase !== "booting" || !owner.cache) {
        throw new Error("Gateway plugin bootstrap has already finished");
      }
      return withPluginCache(owner.cache, run);
    },
    publish(
      snapshot: PluginMetadataSnapshot | undefined,
      changedPluginIds: ReadonlySet<string> = new Set(),
      beforeRetire?: () => Promise<PluginHostCleanupResult>,
    ) {
      if (owner.phase === "closing" || !gatewayMetadataOwners.has(owner)) {
        throw new Error("Gateway plugin metadata owner is closing");
      }
      const previous = owner.cache;
      // An absent snapshot does not release bootstrap facts still used by this Gateway.
      const next = snapshot ? getPluginMetadataSnapshotCache(snapshot) : previous;
      if (previous && next && previous !== next) {
        // Shared boot inventories keep their entry while each successor retains the exact handle.
        for (const [key, instance] of previous.setupModules) {
          if (!changedPluginIds.has(instance.pluginId) && !next.setupModules.has(key)) {
            next.setupModules.set(key, instance);
          }
        }
      }
      owner.cache = next;
      if (owner.phase === "booting") {
        owner.phase = "active";
        gatewayMetadataOwners.delete(owner);
        gatewayMetadataOwners.add(owner);
      }
      if (previous !== next) {
        releaseCache(previous, beforeRetire);
      }
    },
    waitForRetirement,
    close(
      onFinal?: (retire: () => Promise<void>) => void | Promise<void>,
      retireRegistry?: () => Promise<void | PluginHostCleanupResult>,
    ): Promise<void> {
      beginClose();
      if (owner.closing) {
        return owner.closing;
      }
      if (!gatewayMetadataOwners.has(owner)) {
        return Promise.resolve();
      }
      const otherOwners = [...gatewayMetadataOwners].filter((other) => other !== owner);
      const precedingCloses = otherOwners.flatMap((other) =>
        other.closing ? [other.closing] : [],
      );
      // The last entrant owns shared close, including when prior retirements are still pending.
      const final = precedingCloses.length === otherOwners.length;
      let retirement: Promise<void> | undefined;
      const retire = () =>
        (retirement ??= Promise.resolve().then(async () => {
          const previous = owner.cache;
          owner.cache = undefined;
          releaseCache(previous);
          if (previous && getProcessPluginCache() === previous) {
            // Closing admission is not cache retirement: a sibling may still be joining memory.
            const others = [...gatewayMetadataOwners].filter(
              (other) => other.cache && !other.cache.retirement,
            );
            const survivor = others.findLast((other) => other.phase === "active") ?? others.at(-1);
            if (survivor?.cache) {
              selectCurrentPluginMetadataCache(survivor.cache);
            }
          }
          await waitForRetirement([
            ...(retireRegistry ? [Promise.resolve().then(retireRegistry)] : []),
            ...(final ? precedingCloses : []),
          ]);
        }));
      owner.closing = Promise.resolve().then(async () => {
        try {
          // Keep the final cache bound until model publication has joined through onFinal.
          if (final) {
            await onFinal?.(retire);
          }
          await retire();
          if (final) {
            clearPluginMetadataCaches();
          }
        } catch (error) {
          throw new PluginRuntimeCloseRetainedError(error);
        }
        gatewayMetadataOwners.delete(owner);
      });
      return owner.closing;
    },
  };
}

export type GatewayPluginMetadataOwner = ReturnType<typeof retainGatewayPluginMetadata>;

/** Registers a process-local plugin metadata memo clear hook. */
export function registerPluginMetadataProcessMemoLifecycleClear(
  clearProcessMemo: () => void,
): void {
  pluginMetadataProcessMemoClears.add(clearProcessMemo);
}

/** Clears plugin metadata snapshots and registered process memo caches. */
export function clearPluginMetadataLifecycleCaches(): void {
  // Installs and a sibling Gateway's teardown cannot retire a running inventory.
  // Pre-publication planning remains refreshable until boot metadata is pinned.
  if (
    gatewayMetadataOwners.size > 0 &&
    ([...gatewayMetadataOwners].some((owner) => owner.phase !== "booting") ||
      isGatewayPluginMetadataSnapshotActive() ||
      getProcessPluginCache().retirement)
  ) {
    return;
  }
  clearPluginMetadataCaches();
}

function clearPluginMetadataCaches(): void {
  clearCurrentPluginMetadataSnapshot();
  for (const clearProcessMemo of pluginMetadataProcessMemoClears) {
    clearProcessMemo();
  }
  resetPluginCache();
}
