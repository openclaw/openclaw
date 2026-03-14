/**
 * KV Cache startup for OpenClaw gateway
 *
 * Initializes the KV cache manager and connects it to the memory system
 * for context preloading.
 */

import { listAgentIds } from "../agents/agent-scope.js";
import { createKvCacheManager, type KvCacheManager } from "../agents/kv-cache-manager.js";
import { resolveMemorySearchConfig } from "../agents/memory-search.js";
import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getMemorySearchManager } from "../memory/index.js";

const log = createSubsystemLogger("kv-cache-startup");

// Singleton KV cache manager instance
let kvCacheManagerInstance: KvCacheManager | null = null;

/**
 * Get the singleton KV cache manager instance
 */
export function getKvCacheManager(): KvCacheManager | null {
  return kvCacheManagerInstance;
}

/**
 * Start the KV cache manager and connect it to memory for preloading
 */
export async function startGatewayKvCache(params: {
  cfg: OpenClawConfig;
  log: { info?: (msg: string) => void; warn: (msg: string) => void };
}): Promise<KvCacheManager | null> {
  const agentIds = listAgentIds(params.cfg);

  // Find the first agent with memory search enabled
  let memoryManager = null;
  let memoryAgentId: string | null = null;

  for (const agentId of agentIds) {
    const memoryConfig = resolveMemorySearchConfig(params.cfg, agentId);
    if (!memoryConfig) {
      continue;
    }

    const { manager, error } = await getMemorySearchManager({
      cfg: params.cfg,
      agentId,
    });

    if (manager) {
      memoryManager = manager;
      memoryAgentId = agentId;
      break;
    }

    if (error) {
      params.log.warn(`kv-cache: memory manager unavailable for agent "${agentId}": ${error}`);
    }
  }

  // Create and initialize the KV cache manager
  try {
    const manager = await createKvCacheManager({
      cfg: params.cfg,
      memoryManager: memoryManager ?? undefined,
    });

    if (!manager) {
      params.log.info?.("kv-cache: manager disabled or unavailable");
      return null;
    }

    kvCacheManagerInstance = manager;

    const status = manager.getStatus();
    params.log.info?.(
      `kv-cache: initialized with ${status.totalSlots} slots` +
        (memoryAgentId ? ` (memory: ${memoryAgentId})` : ""),
    );

    return manager;
  } catch (err) {
    params.log.warn(`kv-cache: failed to initialize: ${String(err)}`);
    return null;
  }
}

/**
 * Preload context into KV cache for a session
 */
export async function preloadKvCacheContext(params: {
  sessionKey: string;
  query: string;
}): Promise<{ preloaded: boolean; tokens?: number; sources?: string[] }> {
  const manager = kvCacheManagerInstance;
  if (!manager) {
    return { preloaded: false };
  }

  try {
    const result = await manager.preloadContext(params.sessionKey, params.query);

    if (result) {
      return {
        preloaded: true,
        tokens: result.tokensPreloaded,
        sources: result.sources,
      };
    }

    return { preloaded: false };
  } catch (err) {
    log.warn(`preload failed for session ${params.sessionKey}: ${String(err)}`);
    return { preloaded: false };
  }
}

/**
 * Get KV cache status
 */
export function getKvCacheStatus() {
  const manager = kvCacheManagerInstance;
  if (!manager) {
    return { enabled: false, slots: [], totalSlots: 0 };
  }
  return manager.getStatus();
}
