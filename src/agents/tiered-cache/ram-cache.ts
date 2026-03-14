/**
 * RAM Cache Layer
 *
 * In-memory cache for KV slots with:
 * - LRU/LFU/FIFO eviction policies
 * - Pinned slot support
 * - Memory pressure awareness
 * - Prefetch budget management
 */

import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { CachedSlot, CacheLocation, RamTierConfig, TierStats } from "./types.js";
import { DEFAULT_RAM_CONFIG } from "./types.js";

const log = createSubsystemLogger("ram-cache");

// ============================================================================
// Eviction Policies
// ============================================================================

interface EvictionPolicy {
  name: string;
  selectForEviction(entries: Map<string, RamCacheEntry>, excludePinned: boolean): string | null;
  onAccess(entry: RamCacheEntry): void;
}

type RamCacheEntry = {
  slot: CachedSlot;
  data: Buffer;
  accessCount: number;
  lastAccessTime: number;
  insertTime: number;
  frequency: number; // For LFU decay
};

/** Least Recently Used */
const lruPolicy: EvictionPolicy = {
  name: "lru",
  selectForEviction(entries, excludePinned) {
    let oldest: string | null = null;
    let oldestTime = Infinity;

    for (const [id, entry] of entries) {
      if (excludePinned && entry.slot.isPinned) continue;

      if (entry.lastAccessTime < oldestTime) {
        oldestTime = entry.lastAccessTime;
        oldest = id;
      }
    }

    return oldest;
  },
  onAccess(entry) {
    entry.lastAccessTime = Date.now();
  },
};

/** Least Frequently Used */
const lfuPolicy: EvictionPolicy = {
  name: "lfu",
  selectForEviction(entries, excludePinned) {
    let leastFrequent: string | null = null;
    let lowestFreq = Infinity;

    for (const [id, entry] of entries) {
      if (excludePinned && entry.slot.isPinned) continue;

      // Combine frequency with recency (frequency decays over time)
      const age = (Date.now() - entry.lastAccessTime) / 1000;
      const adjustedFreq = entry.frequency / (1 + age / 3600);

      if (adjustedFreq < lowestFreq) {
        lowestFreq = adjustedFreq;
        leastFrequent = id;
      }
    }

    return leastFrequent;
  },
  onAccess(entry) {
    entry.frequency += 1;
    entry.lastAccessTime = Date.now();
  },
};

/** First In First Out */
const fifoPolicy: EvictionPolicy = {
  name: "fifo",
  selectForEviction(entries, excludePinned) {
    let oldest: string | null = null;
    let oldestTime = Infinity;

    for (const [id, entry] of entries) {
      if (excludePinned && entry.slot.isPinned) continue;

      if (entry.insertTime < oldestTime) {
        oldestTime = entry.insertTime;
        oldest = id;
      }
    }

    return oldest;
  },
  onAccess(entry) {
    // FIFO doesn't care about access order
  },
};

function getPolicy(name: "lru" | "lfu" | "fifo"): EvictionPolicy {
  switch (name) {
    case "lfu":
      return lfuPolicy;
    case "fifo":
      return fifoPolicy;
    default:
      return lruPolicy;
  }
}

// ============================================================================
// RAM Cache Implementation
// ============================================================================

export class RamCache {
  private readonly config: RamTierConfig;
  private readonly policy: EvictionPolicy;
  private readonly entries = new Map<string, RamCacheEntry>();
  private readonly stats: TierStats;
  private closed = false;

  // Memory tracking
  private currentBytes = 0;
  private readonly pinnedSlots: Set<string>;

  constructor(config: Partial<RamTierConfig> = {}) {
    this.config = { ...DEFAULT_RAM_CONFIG, ...config };
    this.policy = getPolicy(this.config.evictionPolicy);
    this.pinnedSlots = new Set(this.config.pinnedSlots);

    this.stats = {
      tier: "ram",
      itemsCount: 0,
      bytesUsed: 0,
      bytesAvailable: this.config.maxMemoryBytes,
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
    log.info(`Initializing RAM cache (${formatBytes(this.config.maxMemoryBytes)})`);
    log.info(`Eviction policy: ${this.policy.name}`);
    log.info(`Prefetch budget: ${formatBytes(this.config.prefetchBudgetBytes)}`);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    // Clear entries to free memory
    this.entries.clear();
    this.currentBytes = 0;

    log.info("RAM cache closed");
  }

  // --------------------------------------------------------------------------
  // Core Operations
  // --------------------------------------------------------------------------

  async store(slot: CachedSlot, data: Buffer): Promise<boolean> {
    const startTime = Date.now();
    const sizeBytes = data.length;

    // Check if we need to make room
    const available = this.config.maxMemoryBytes - this.currentBytes;
    if (sizeBytes > available) {
      const freed = await this.evict(sizeBytes - available);
      if (freed < sizeBytes - available) {
        log.warn(`Not enough RAM cache space for slot ${slot.id}`);
        return false;
      }
    }

    // Check if slot is pinned
    if (this.pinnedSlots.has(slot.id)) {
      slot.isPinned = true;
    }

    // Create entry
    const entry: RamCacheEntry = {
      slot: { ...slot, location: { tier: "ram", ramKey: slot.id } },
      data,
      accessCount: 1,
      lastAccessTime: Date.now(),
      insertTime: Date.now(),
      frequency: 1,
    };

    // Remove old entry if exists
    if (this.entries.has(slot.id)) {
      const old = this.entries.get(slot.id)!;
      this.currentBytes -= old.data.length;
    }

    // Store entry
    this.entries.set(slot.id, entry);
    this.currentBytes += sizeBytes;

    // Update stats
    this.stats.itemsCount = this.entries.size;
    this.stats.bytesUsed = this.currentBytes;
    this.stats.demotionCount++;

    const latency = Date.now() - startTime;
    this.updateAvgLatency(latency);

    log.debug(`Stored slot ${slot.id} in RAM (${sizeBytes} bytes)`);

    return true;
  }

  async load(slotId: string): Promise<{ data: Buffer; slot: CachedSlot } | null> {
    const startTime = Date.now();

    const entry = this.entries.get(slotId);
    if (!entry) {
      this.stats.missCount++;
      return null;
    }

    // Update access stats
    entry.accessCount++;
    this.policy.onAccess(entry);
    entry.slot.lastAccessedAt = Date.now();
    entry.slot.accessCount = entry.accessCount;

    this.stats.hitCount++;
    this.stats.promotionCount++;

    const latency = Date.now() - startTime;
    this.updateAvgLatency(latency);

    log.debug(`Loaded slot ${slotId} from RAM (${entry.data.length} bytes, ${latency}ms)`);

    return {
      data: entry.data,
      slot: { ...entry.slot },
    };
  }

  async delete(slotId: string): Promise<boolean> {
    const entry = this.entries.get(slotId);
    if (!entry) return false;

    if (entry.slot.isPinned) {
      log.debug(`Skipping deletion of pinned slot ${slotId}`);
      return false;
    }

    this.entries.delete(slotId);
    this.currentBytes -= entry.data.length;

    this.stats.itemsCount = this.entries.size;
    this.stats.bytesUsed = this.currentBytes;
    this.stats.evictionCount++;

    log.debug(`Deleted slot ${slotId} from RAM`);

    return true;
  }

  has(slotId: string): boolean {
    return this.entries.has(slotId);
  }

  getSlot(slotId: string): CachedSlot | null {
    const entry = this.entries.get(slotId);
    return entry ? { ...entry.slot } : null;
  }

  // --------------------------------------------------------------------------
  // Pinning
  // --------------------------------------------------------------------------

  pin(slotId: string): boolean {
    const entry = this.entries.get(slotId);
    if (!entry) return false;

    entry.slot.isPinned = true;
    this.pinnedSlots.add(slotId);

    log.debug(`Pinned slot ${slotId}`);
    return true;
  }

  unpin(slotId: string): boolean {
    const entry = this.entries.get(slotId);
    if (!entry) return false;

    entry.slot.isPinned = false;
    this.pinnedSlots.delete(slotId);

    log.debug(`Unpinned slot ${slotId}`);
    return true;
  }

  isPinned(slotId: string): boolean {
    return this.pinnedSlots.has(slotId);
  }

  // --------------------------------------------------------------------------
  // Eviction
  // --------------------------------------------------------------------------

  private async evict(bytesNeeded: number): Promise<number> {
    let freed = 0;

    while (freed < bytesNeeded) {
      const toEvict = this.policy.selectForEviction(this.entries, true);

      if (!toEvict) {
        // Nothing left to evict (all pinned or empty)
        break;
      }

      const entry = this.entries.get(toEvict)!;
      const size = entry.data.length;

      if (await this.delete(toEvict)) {
        freed += size;
        log.debug(`Evicted slot ${toEvict} (${size} bytes)`);
      }
    }

    if (freed > 0) {
      log.info(`Eviction freed ${formatBytes(freed)}`);
    }

    return freed;
  }

  async evictSlot(slotId: string): Promise<boolean> {
    return this.delete(slotId);
  }

  // --------------------------------------------------------------------------
  // Prefetch Budget
  // --------------------------------------------------------------------------

  getPrefetchBudgetAvailable(): number {
    const prefetchBytes = Array.from(this.entries.values())
      .filter((e) => e.slot.isPrefetch)
      .reduce((sum, e) => sum + e.data.length, 0);

    return this.config.prefetchBudgetBytes - prefetchBytes;
  }

  canPrefetch(sizeBytes: number): boolean {
    return this.getPrefetchBudgetAvailable() >= sizeBytes;
  }

  markAsPrefetch(slotId: string): void {
    const entry = this.entries.get(slotId);
    if (entry) {
      entry.slot.isPrefetch = true;
    }
  }

  // --------------------------------------------------------------------------
  // Memory Pressure
  // --------------------------------------------------------------------------

  getMemoryPressure(): number {
    // Returns 0-1, where 1 is critically full
    return this.currentBytes / this.config.maxMemoryBytes;
  }

  getFreeSpace(): number {
    return this.config.maxMemoryBytes - this.currentBytes;
  }

  // --------------------------------------------------------------------------
  // Stats
  // --------------------------------------------------------------------------

  getStats(): TierStats {
    return {
      ...this.stats,
      bytesAvailable: this.config.maxMemoryBytes,
    };
  }

  getAllSlots(): CachedSlot[] {
    return Array.from(this.entries.values()).map((e) => ({ ...e.slot }));
  }

  private updateAvgLatency(latencyMs: number): void {
    const alpha = 0.1;
    this.stats.avgLatencyMs = this.stats.avgLatencyMs * (1 - alpha) + latencyMs * alpha;
  }
}

// ============================================================================
// Helpers
// ============================================================================

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let value = bytes;

  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }

  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
