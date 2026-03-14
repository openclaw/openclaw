/**
 * GPU Cache Layer
 *
 * Interface to llama.cpp server for GPU VRAM management:
 * - Slot allocation and management
 * - KV cache warmup
 * - Prefix caching
 * - Slot save/load operations
 */

import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { CachedSlot, CacheLocation, GpuTierConfig, TierStats } from "./types.js";
import { DEFAULT_GPU_CONFIG } from "./types.js";

const log = createSubsystemLogger("gpu-cache");

// ============================================================================
// LLaMA Server API Types
// ============================================================================

type LlamaSlotInfo = {
  id: number;
  n_ctx: number;
  n_tokens: number;
  is_processing: boolean;
  params?: {
    prompt?: string;
    cache_prompt?: boolean;
  };
};

type LlamaSlotsResponse = LlamaSlotInfo[];

type LlamaHealthResponse = {
  status: string;
  slots_idle: number;
  slots_processing: number;
};

type SaveSlotResponse = {
  id: number;
  n_tokens: number;
  size_bytes: number;
  path: string;
};

// ============================================================================
// GPU Cache Implementation
// ============================================================================

export class GpuCache {
  private readonly config: GpuTierConfig;
  private readonly serverUrl: string;
  private readonly slots = new Map<number, GpuSlotState>();
  private readonly sessionToSlot = new Map<string, number>();
  private readonly stats: TierStats;
  private closed = false;

  // Estimate bytes per token for q8_0 (approximately 0.5KB per token pair)
  private readonly bytesPerToken = 512; // For q8_0 KV cache

  constructor(serverUrl: string, config: Partial<GpuTierConfig> = {}) {
    this.config = { ...DEFAULT_GPU_CONFIG, ...config };
    this.serverUrl = serverUrl;

    this.stats = {
      tier: "gpu",
      itemsCount: 0,
      bytesUsed: 0,
      bytesAvailable: this.config.maxMemoryBytes - this.config.reservedForModelBytes,
      hitCount: 0,
      missCount: 0,
      evictionCount: 0,
      promotionCount: 0,
      demotionCount: 0,
      avgLatencyMs: 0,
    };
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  async initialize(): Promise<void> {
    log.info(`Initializing GPU cache (server: ${this.serverUrl})`);

    // Wait for server to be available
    const healthy = await this.waitForServer(30000);
    if (!healthy) {
      throw new Error("LLaMA server not available");
    }

    // Fetch initial slot state
    await this.refreshSlots();

    log.info(`GPU cache initialized (${this.slots.size} slots)`);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = false;

    // Save all active slots before closing
    for (const [slotId, state] of this.slots) {
      if (state.sessionId && state.n_tokens > 0) {
        await this.saveSlot(slotId);
      }
    }

    log.info("GPU cache closed");
  }

  // --------------------------------------------------------------------------
  // Slot Management
  // --------------------------------------------------------------------------

  async refreshSlots(): Promise<LlamaSlotInfo[]> {
    const startTime = Date.now();

    try {
      const response = await fetch(`${this.serverUrl}/slots`);
      if (!response.ok) {
        throw new Error(`Failed to fetch slots: ${response.status}`);
      }

      const slots = (await response.json()) as LlamaSlotsResponse;

      // Update internal state
      for (const slot of slots) {
        const existing = this.slots.get(slot.id);
        this.slots.set(slot.id, {
          id: slot.id,
          n_ctx: slot.n_ctx,
          n_tokens: slot.n_tokens,
          is_processing: slot.is_processing,
          sessionId: existing?.sessionId,
          lastUsedAt: existing?.lastUsedAt ?? Date.now(),
          isPrefetch: existing?.isPrefetch ?? false,
        });
      }

      this.stats.itemsCount = slots.length;
      this.updateByteUsage();

      const latency = Date.now() - startTime;
      this.updateAvgLatency(latency);

      return slots;
    } catch (err) {
      log.warn(`Failed to refresh slots: ${String(err)}`);
      return [];
    }
  }

  async acquireSlot(sessionId: string): Promise<number | null> {
    // Check if session already has a slot
    const existingSlot = this.sessionToSlot.get(sessionId);
    if (existingSlot !== undefined) {
      const state = this.slots.get(existingSlot);
      if (state && !state.is_processing) {
        state.lastUsedAt = Date.now();
        this.stats.hitCount++;
        return existingSlot;
      }
    }

    // Find available slot
    const slots = await this.refreshSlots();
    const available = slots.find((s) => !s.is_processing && !this.sessionToSlot.has(String(s.id)));

    if (available) {
      this.sessionToSlot.set(sessionId, available.id);
      const state = this.slots.get(available.id);
      if (state) {
        state.sessionId = sessionId;
        state.lastUsedAt = Date.now();
      }
      this.stats.missCount++;
      return available.id;
    }

    // Try to evict idle slot
    const evicted = await this.evictIdleSlot();
    if (evicted !== null) {
      this.sessionToSlot.set(sessionId, evicted);
      const state = this.slots.get(evicted);
      if (state) {
        state.sessionId = sessionId;
        state.lastUsedAt = Date.now();
      }
      this.stats.missCount++;
      return evicted;
    }

    log.warn(`No available GPU slots for session ${sessionId}`);
    return null;
  }

  releaseSlot(sessionId: string): void {
    const slotId = this.sessionToSlot.get(sessionId);
    if (slotId !== undefined) {
      this.sessionToSlot.delete(sessionId);
      const state = this.slots.get(slotId);
      if (state) {
        state.sessionId = undefined;
        state.lastUsedAt = Date.now();
      }
      log.debug(`Released GPU slot ${slotId}`);
    }
  }

  // --------------------------------------------------------------------------
  // KV Cache Operations
  // --------------------------------------------------------------------------

  async warmupSlot(
    slotId: number,
    content: string,
    options: {
      systemPrompt?: string;
      maxTokens?: number;
    } = {},
  ): Promise<{ tokensProcessed: number }> {
    const startTime = Date.now();

    try {
      const response = await fetch(`${this.serverUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "current",
          messages: [
            ...(options.systemPrompt ? [{ role: "system", content: options.systemPrompt }] : []),
            { role: "user", content },
          ],
          max_tokens: options.maxTokens ?? 1,
          temperature: 0,
          slot_id: slotId,
          cache_prompt: true,
        }),
      });

      if (!response.ok) {
        throw new Error(`Warmup failed: ${response.status}`);
      }

      const result = (await response.json()) as any;
      const tokensProcessed = result.usage?.prompt_tokens ?? 0;

      // Update slot state
      const state = this.slots.get(slotId);
      if (state) {
        state.n_tokens = tokensProcessed;
        state.lastUsedAt = Date.now();
      }

      this.updateByteUsage();
      this.stats.promotionCount++;

      const latency = Date.now() - startTime;
      this.updateAvgLatency(latency);

      log.debug(`Warmed up slot ${slotId} (${tokensProcessed} tokens, ${latency}ms)`);

      return { tokensProcessed };
    } catch (err) {
      log.warn(`Failed to warmup slot ${slotId}: ${String(err)}`);
      throw err;
    }
  }

  async saveSlot(slotId: number): Promise<SaveSlotResponse | null> {
    const startTime = Date.now();

    try {
      const response = await fetch(`${this.serverUrl}/slots/${slotId}/save`, {
        method: "POST",
      });

      if (!response.ok) {
        throw new Error(`Save failed: ${response.status}`);
      }

      const result = (await response.json()) as SaveSlotResponse;

      const latency = Date.now() - startTime;
      this.updateAvgLatency(latency);

      log.info(`Saved slot ${slotId} (${result.n_tokens} tokens, ${result.size_bytes} bytes)`);

      return result;
    } catch (err) {
      log.warn(`Failed to save slot ${slotId}: ${String(err)}`);
      return null;
    }
  }

  async loadSlot(slotId: number, path: string): Promise<boolean> {
    const startTime = Date.now();

    try {
      const response = await fetch(`${this.serverUrl}/slots/${slotId}/load`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });

      if (!response.ok) {
        throw new Error(`Load failed: ${response.status}`);
      }

      const latency = Date.now() - startTime;
      this.updateAvgLatency(latency);

      log.info(`Loaded slot ${slotId} from ${path}`);

      return true;
    } catch (err) {
      log.warn(`Failed to load slot ${slotId}: ${String(err)}`);
      return false;
    }
  }

  // --------------------------------------------------------------------------
  // Prefix Caching
  // --------------------------------------------------------------------------

  async cachePrefix(
    sessionId: string,
    prefix: string,
    options: { hash?: string } = {},
  ): Promise<{ slotId: number; tokensCached: number }> {
    const slotId = await this.acquireSlot(sessionId);
    if (slotId === null) {
      throw new Error("No available slot for prefix caching");
    }

    const result = await this.warmupSlot(slotId, prefix, { maxTokens: 1 });

    // Mark as prefix cache
    const state = this.slots.get(slotId);
    if (state) {
      state.isPrefetch = true;
    }

    log.debug(`Cached prefix for session ${sessionId} (${result.tokensProcessed} tokens)`);

    return { slotId, tokensCached: result.tokensProcessed };
  }

  // --------------------------------------------------------------------------
  // Eviction
  // --------------------------------------------------------------------------

  private async evictIdleSlot(): Promise<number | null> {
    let oldestSlot: number | null = null;
    let oldestTime = Infinity;

    for (const [slotId, state] of this.slots) {
      if (state.is_processing) continue;

      // Free slot
      if (!state.sessionId) {
        return slotId;
      }

      // Find oldest used
      if (state.lastUsedAt && state.lastUsedAt < oldestTime) {
        oldestTime = state.lastUsedAt;
        oldestSlot = slotId;
      }
    }

    if (oldestSlot !== null) {
      // Save before evicting
      const state = this.slots.get(oldestSlot);
      if (state?.sessionId) {
        await this.saveSlot(oldestSlot);
        this.releaseSlot(state.sessionId);
      }

      this.stats.evictionCount++;
      log.info(`Evicted idle slot ${oldestSlot}`);

      return oldestSlot;
    }

    return null;
  }

  // --------------------------------------------------------------------------
  // Health & Monitoring
  // --------------------------------------------------------------------------

  async checkHealth(): Promise<boolean> {
    try {
      const response = await fetch(`${this.serverUrl}/health`);
      return response.ok;
    } catch {
      return false;
    }
  }

  private async waitForServer(timeoutMs: number): Promise<boolean> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      if (await this.checkHealth()) {
        return true;
      }
      await sleep(500);
    }

    return false;
  }

  // --------------------------------------------------------------------------
  // Stats
  // --------------------------------------------------------------------------

  getStats(): TierStats {
    return { ...this.stats };
  }

  getSlotState(slotId: number): GpuSlotState | undefined {
    return this.slots.get(slotId);
  }

  getAllSlotStates(): GpuSlotState[] {
    return Array.from(this.slots.values());
  }

  getSlotForSession(sessionId: string): number | undefined {
    return this.sessionToSlot.get(sessionId);
  }

  private updateByteUsage(): void {
    let totalTokens = 0;
    for (const state of this.slots.values()) {
      totalTokens += state.n_tokens;
    }
    this.stats.bytesUsed = totalTokens * this.bytesPerToken;
  }

  private updateAvgLatency(latencyMs: number): void {
    const alpha = 0.1;
    this.stats.avgLatencyMs = this.stats.avgLatencyMs * (1 - alpha) + latencyMs * alpha;
  }
}

// ============================================================================
// Types
// ============================================================================

type GpuSlotState = {
  id: number;
  n_ctx: number;
  n_tokens: number;
  is_processing: boolean;
  sessionId?: string;
  lastUsedAt: number;
  isPrefetch: boolean;
};

// ============================================================================
// Helpers
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
