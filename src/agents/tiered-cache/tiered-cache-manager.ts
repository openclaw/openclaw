/**
 * Tiered Cache Manager
 *
 * Orchestrates the three-tier cache system:
 * - GPU VRAM (hot): Active inference
 * - RAM (warm): Offload buffer
 * - Disk (cold): Persistence
 *
 * Features:
 * - Automatic promotion/demotion
 * - Predictive prefetching
 * - Speculative decoding monitoring
 * - Unified API
 */

import { createSubsystemLogger } from "../../logging/subsystem.js";
import { DiskCache } from "./disk-cache.js";
import { GpuCache } from "./gpu-cache.js";
import { Prefetcher } from "./prefetcher.js";
import { RamCache } from "./ram-cache.js";
import { SpeculativeMonitor, createSpeculativeMonitor } from "./speculative-monitor.js";
import type {
  CacheEventHandler,
  CacheEvent,
  CacheLookupResult,
  CacheStats,
  CacheStoreResult,
  CachedSlot,
  PromotionResult,
  TieredCacheConfig,
  PrefetchPrediction,
} from "./types.js";
import { DEFAULT_TIERED_CACHE_CONFIG } from "./types.js";

const log = createSubsystemLogger("tiered-cache");

// ============================================================================
// Tiered Cache Manager
// ============================================================================

export class TieredCacheManager {
  private readonly config: TieredCacheConfig;
  private readonly gpuCache: GpuCache;
  private readonly ramCache: RamCache;
  private readonly diskCache: DiskCache;
  private readonly prefetcher: Prefetcher;
  private readonly speculativeMonitor: SpeculativeMonitor;

  private readonly eventHandlers: CacheEventHandler[] = [];
  private evictionTimer?: NodeJS.Timeout;
  private statsTimer?: NodeJS.Timeout;
  private prefetchTimer?: NodeJS.Timeout;

  private startTime = 0;
  private closed = false;

  constructor(config: Partial<TieredCacheConfig> = {}) {
    this.config = { ...DEFAULT_TIERED_CACHE_CONFIG, ...config };

    this.gpuCache = new GpuCache(this.config.llamaServerUrl, this.config.gpu);

    this.ramCache = new RamCache(this.config.ram);
    this.diskCache = new DiskCache(this.config.disk);
    this.prefetcher = new Prefetcher(this.config.prefetcher);
    this.speculativeMonitor = createSpeculativeMonitor(this.config.speculative);
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  async initialize(): Promise<void> {
    log.info("Initializing tiered cache manager");
    this.startTime = Date.now();

    // Initialize all tiers
    await Promise.all([
      this.gpuCache.initialize(),
      this.ramCache.initialize(),
      this.diskCache.initialize(),
      this.prefetcher.initialize(),
    ]);

    // Start background tasks
    this.startEvictionTimer();
    this.startStatsTimer();
    this.startPrefetchTimer();

    log.info("Tiered cache manager initialized");
    this.emitEvent({ type: "stats_updated", stats: this.getStats() });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    // Stop timers
    if (this.evictionTimer) clearInterval(this.evictionTimer);
    if (this.statsTimer) clearInterval(this.statsTimer);
    if (this.prefetchTimer) clearInterval(this.prefetchTimer);

    // Close all tiers (order matters: GPU -> RAM -> Disk)
    await this.gpuCache.close();
    await this.ramCache.close();
    await this.diskCache.close();
    await this.prefetcher.close();

    log.info("Tiered cache manager closed");
  }

  // --------------------------------------------------------------------------
  // Core Operations
  // --------------------------------------------------------------------------

  async lookup(slotId: string): Promise<CacheLookupResult> {
    const startTime = Date.now();

    // 1. Check GPU (fastest)
    const gpuSlot = this.gpuCache.getSlotForSession(slotId);
    if (gpuSlot !== undefined) {
      const state = this.gpuCache.getSlotState(gpuSlot);
      if (state) {
        this.recordAccess(slotId, "hit", "gpu");

        return {
          found: true,
          slot: this.gpuSlotToCachedSlot(state),
          tier: "gpu",
          loadTimeMs: Date.now() - startTime,
        };
      }
    }

    // 2. Check RAM
    const ramResult = await this.ramCache.load(slotId);
    if (ramResult) {
      this.recordAccess(slotId, "hit", "ram");

      // Promote to GPU if possible
      const promoted = await this.promoteToGpu(ramResult.slot, ramResult.data);

      return {
        found: true,
        slot: promoted ?? ramResult.slot,
        tier: promoted ? "gpu" : "ram",
        loadTimeMs: Date.now() - startTime,
      };
    }

    // 3. Check Disk
    const diskResult = await this.diskCache.load(slotId);
    if (diskResult) {
      this.recordAccess(slotId, "hit", "disk");

      // Promote to RAM (and potentially GPU)
      const promoted = await this.promoteToRam(diskResult.slot, diskResult.data);

      return {
        found: true,
        slot: promoted ?? diskResult.slot,
        tier: promoted ? "ram" : "disk",
        loadTimeMs: Date.now() - startTime,
      };
    }

    // Not found anywhere
    this.recordAccess(slotId, "miss", "disk");

    return {
      found: false,
      loadTimeMs: Date.now() - startTime,
    };
  }

  async store(
    slotId: string,
    sessionId: string,
    data: Buffer,
    metadata: { tokenCount: number; sourcePaths?: string[] } = { tokenCount: 0 },
  ): Promise<CacheStoreResult> {
    const startTime = Date.now();

    const slot: CachedSlot = {
      id: slotId,
      sessionId,
      tokenCount: metadata.tokenCount,
      sizeBytes: data.length,
      location: { tier: "gpu" },
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
      accessCount: 1,
      isPinned: false,
      isPrefetch: false,
      metadata: {
        sourcePaths: metadata.sourcePaths,
      },
    };

    // Try to store in GPU first
    const gpuSlotId = await this.gpuCache.acquireSlot(sessionId);
    if (gpuSlotId !== null) {
      slot.location = { tier: "gpu", slotId: gpuSlotId };

      this.emitEvent({ type: "slot_created", slot });

      return {
        success: true,
        slot,
        storedAt: "gpu",
        storeTimeMs: Date.now() - startTime,
      };
    }

    // Fall back to RAM
    const stored = await this.ramCache.store(slot, data);
    if (stored) {
      slot.location = { tier: "ram", ramKey: slotId };

      this.emitEvent({ type: "slot_created", slot });

      return {
        success: true,
        slot,
        storedAt: "ram",
        storeTimeMs: Date.now() - startTime,
      };
    }

    // Fall back to Disk
    await this.diskCache.store(slot, data);
    slot.location = {
      tier: "disk",
      path: join(this.config.disk.basePath, "slots", `${slotId}.bin`),
    };

    this.emitEvent({ type: "slot_created", slot });

    return {
      success: true,
      slot,
      storedAt: "disk",
      storeTimeMs: Date.now() - startTime,
    };
  }

  async evict(slotId: string): Promise<boolean> {
    // Try each tier
    if (this.gpuCache.getSlotForSession(slotId) !== undefined) {
      this.gpuCache.releaseSlot(slotId);
      this.emitEvent({
        type: "slot_evicted",
        slot: { id: slotId } as CachedSlot,
        tier: "gpu",
        reason: "explicit",
      });
      return true;
    }

    if (await this.ramCache.evictSlot(slotId)) {
      this.emitEvent({
        type: "slot_evicted",
        slot: { id: slotId } as CachedSlot,
        tier: "ram",
        reason: "explicit",
      });
      return true;
    }

    if (await this.diskCache.delete(slotId)) {
      this.emitEvent({
        type: "slot_evicted",
        slot: { id: slotId } as CachedSlot,
        tier: "disk",
        reason: "explicit",
      });
      return true;
    }

    return false;
  }

  // --------------------------------------------------------------------------
  // Promotion / Demotion
  // --------------------------------------------------------------------------

  private async promoteToGpu(slot: CachedSlot, data: Buffer): Promise<CachedSlot | null> {
    const gpuSlotId = await this.gpuCache.acquireSlot(slot.sessionId);
    if (gpuSlotId === null) {
      return null;
    }

    try {
      // Warm up the GPU slot with the context
      // In practice, we'd use llama.cpp's slot load feature
      // For now, we just update the slot metadata
      const newSlot: CachedSlot = {
        ...slot,
        location: { tier: "gpu", slotId: gpuSlotId },
        lastAccessedAt: Date.now(),
      };

      this.emitEvent({
        type: "slot_promoted",
        slot: newSlot,
        from: "ram",
        to: "gpu",
      });

      return newSlot;
    } catch (err) {
      log.warn(`Failed to promote to GPU: ${String(err)}`);
      this.gpuCache.releaseSlot(slot.sessionId);
      return null;
    }
  }

  private async promoteToRam(slot: CachedSlot, data: Buffer): Promise<CachedSlot | null> {
    const stored = await this.ramCache.store(slot, data);
    if (!stored) {
      return null;
    }

    const newSlot: CachedSlot = {
      ...slot,
      location: { tier: "ram", ramKey: slot.id },
      lastAccessedAt: Date.now(),
    };

    this.emitEvent({
      type: "slot_promoted",
      slot: newSlot,
      from: "disk",
      to: "ram",
    });

    return newSlot;
  }

  async demote(slotId: string, fromTier: "gpu" | "ram"): Promise<boolean> {
    if (fromTier === "gpu") {
      // GPU -> RAM
      const gpuSlot = this.gpuCache.getSlotForSession(slotId);
      if (gpuSlot === undefined) return false;

      // Save slot to disk first (llama.cpp handles this)
      await this.gpuCache.saveSlot(gpuSlot);

      // Release GPU slot
      this.gpuCache.releaseSlot(slotId);

      this.emitEvent({
        type: "slot_demoted",
        slot: { id: slotId } as CachedSlot,
        from: "gpu",
        to: "ram",
      });

      return true;
    }

    if (fromTier === "ram") {
      // RAM -> Disk
      const ramResult = await this.ramCache.load(slotId);
      if (!ramResult) return false;

      await this.diskCache.store(ramResult.slot, ramResult.data);
      await this.ramCache.evictSlot(slotId);

      this.emitEvent({
        type: "slot_demoted",
        slot: ramResult.slot,
        from: "ram",
        to: "disk",
      });

      return true;
    }

    return false;
  }

  // --------------------------------------------------------------------------
  // Prefetching
  // --------------------------------------------------------------------------

  async prefetch(slotId: string, data: Buffer): Promise<boolean> {
    // Check if we should prefetch
    const confidence = this.prefetcher.getConfidence(slotId);
    if (confidence < this.config.prefetcher.minConfidence) {
      return false;
    }

    // Check RAM budget for prefetch
    if (!this.ramCache.canPrefetch(data.length)) {
      return false;
    }

    const slot: CachedSlot = {
      id: slotId,
      sessionId: slotId,
      tokenCount: 0,
      sizeBytes: data.length,
      location: { tier: "ram", ramKey: slotId },
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
      accessCount: 0,
      isPinned: false,
      isPrefetch: true,
      metadata: {},
    };

    const stored = await this.ramCache.store(slot, data);
    if (stored) {
      this.ramCache.markAsPrefetch(slotId);

      this.emitEvent({
        type: "slot_prefetched",
        slot,
        confidence,
      });

      log.info(`Prefetched slot ${slotId} (confidence: ${confidence.toFixed(2)})`);
      return true;
    }

    return false;
  }

  private async runPrefetch(): Promise<void> {
    if (!this.config.prefetcher.enabled) return;

    // Get predictions
    const predictions = this.prefetcher.predict();

    // Limit concurrent prefetches
    const toFetch = predictions.slice(0, this.config.prefetcher.maxPrefetchSlots);

    for (const pred of toFetch) {
      // Skip if already cached
      if (this.ramCache.has(pred.slotId)) continue;
      if (this.diskCache.has(pred.slotId)) {
        // Promote from disk
        const result = await this.diskCache.load(pred.slotId);
        if (result) {
          await this.prefetch(pred.slotId, result.data);
        }
        continue;
      }

      // Would need to generate the content somehow
      // This is where you'd integrate with your context generation logic
      log.debug(
        `Would prefetch ${pred.slotId} (confidence: ${pred.confidence.toFixed(2)}, reason: ${pred.reason})`,
      );
    }
  }

  // --------------------------------------------------------------------------
  // Event Handling
  // --------------------------------------------------------------------------

  onEvent(handler: CacheEventHandler): void {
    this.eventHandlers.push(handler);
  }

  offEvent(handler: CacheEventHandler): void {
    const idx = this.eventHandlers.indexOf(handler);
    if (idx !== -1) {
      this.eventHandlers.splice(idx, 1);
    }
  }

  private emitEvent(event: CacheEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch (err) {
        log.warn(`Event handler error: ${String(err)}`);
      }
    }
  }

  // --------------------------------------------------------------------------
  // Background Tasks
  // --------------------------------------------------------------------------

  private startEvictionTimer(): void {
    this.evictionTimer = setInterval(() => {
      void this.runEviction();
    }, this.config.evictionIntervalMs);
  }

  private startStatsTimer(): void {
    this.statsTimer = setInterval(() => {
      const stats = this.getStats();
      this.emitEvent({ type: "stats_updated", stats });
    }, this.config.statsIntervalMs);
  }

  private startPrefetchTimer(): void {
    // Run prefetch every 30 seconds
    this.prefetchTimer = setInterval(() => {
      void this.runPrefetch();
    }, 30000);
  }

  private async runEviction(): Promise<void> {
    // Check RAM pressure
    const ramPressure = this.ramCache.getMemoryPressure();
    if (ramPressure > 0.9) {
      log.warn(`RAM cache pressure high: ${(ramPressure * 100).toFixed(1)}%`);

      // Demote oldest to disk
      const slots = this.ramCache
        .getAllSlots()
        .filter((s) => !s.isPinned)
        .sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);

      for (const slot of slots.slice(0, 2)) {
        await this.demote(slot.id, "ram");
      }
    }
  }

  // --------------------------------------------------------------------------
  // Stats
  // --------------------------------------------------------------------------

  getStats(): CacheStats {
    const gpuStats = this.gpuCache.getStats();
    const ramStats = this.ramCache.getStats();
    const diskStats = this.diskCache.getStats();
    const speculativeStats = this.speculativeMonitor.getStats();

    const totalHits = gpuStats.hitCount + ramStats.hitCount + diskStats.hitCount;
    const totalMisses = gpuStats.missCount + ramStats.missCount + diskStats.missCount;
    const overallHitRate = totalHits / (totalHits + totalMisses) || 0;

    const avgLatency = (gpuStats.avgLatencyMs + ramStats.avgLatencyMs + diskStats.avgLatencyMs) / 3;

    return {
      gpu: gpuStats,
      ram: ramStats,
      disk: diskStats,
      speculative: speculativeStats,
      overallHitRate,
      overallLatencyMs: avgLatency,
      prefetchAccuracy: 0, // Would need to track prefetch hits
      uptimeMs: Date.now() - this.startTime,
    };
  }

  getPrefetchPredictions(): PrefetchPrediction[] {
    return this.prefetcher.getPredictions();
  }

  // --------------------------------------------------------------------------
  // Speculative Decoding
  // --------------------------------------------------------------------------

  /**
   * Process log lines for speculative decoding statistics
   * Call this when reading from llama.cpp server logs
   */
  processSpeculativeLogLines(lines: string[]): number {
    return this.speculativeMonitor.processLogLines(lines);
  }

  /**
   * Process a single log line
   */
  processSpeculativeLogLine(line: string): boolean {
    return this.speculativeMonitor.processLogLine(line);
  }

  /**
   * Get speculative decoding statistics
   */
  getSpeculativeStats() {
    return {
      stats: this.speculativeMonitor.getStats(),
      acceptanceRatePercent: this.speculativeMonitor.getAcceptanceRatePercent(),
      estimatedThroughputImprovement: this.speculativeMonitor.getEstimatedThroughputImprovement(),
      summary: this.speculativeMonitor.getSummary(),
    };
  }

  /**
   * Log speculative decoding stats
   */
  logSpeculativeStats(): void {
    this.speculativeMonitor.logStats();
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private recordAccess(
    slotId: string,
    accessType: "hit" | "miss" | "prefetch_hit" | "prefetch_miss",
    sourceTier: "gpu" | "ram" | "disk",
  ): void {
    this.prefetcher.recordAccess({
      sessionId: slotId,
      slotId,
      accessType,
      sourceTier,
    });
  }

  private gpuSlotToCachedSlot(state: any): CachedSlot {
    return {
      id: String(state.id),
      sessionId: state.sessionId ?? String(state.id),
      tokenCount: state.n_tokens ?? 0,
      sizeBytes: state.n_tokens * 512, // Estimate
      location: { tier: "gpu", slotId: state.id },
      createdAt: Date.now(),
      lastAccessedAt: state.lastUsedAt ?? Date.now(),
      accessCount: 1,
      isPinned: false,
      isPrefetch: state.isPrefetch ?? false,
      metadata: {},
    };
  }
}

// ============================================================================
// Factory
// ============================================================================

export async function createTieredCacheManager(
  config: Partial<TieredCacheConfig> = {},
): Promise<TieredCacheManager> {
  const manager = new TieredCacheManager(config);
  await manager.initialize();
  return manager;
}

// ============================================================================
// Helper
// ============================================================================

function join(...paths: string[]): string {
  return paths.filter(Boolean).join("/").replace(/\/+/g, "/");
}
