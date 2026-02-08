/**
 * Tab Manager & Recovery
 * 
 * Tracks browser tabs and recovers lost references when tabs are disconnected.
 * Maintains a registry of tab metadata to enable URL-based recovery.
 */

import type { BrowserTab } from "./client.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("browser").child("tab-manager");

export type TrackedTab = {
  targetId: string;
  url: string;
  title?: string;
  type?: string;
  lastSeen: number;
};

export type TabRecoveryConfig = {
  /** Enable tab tracking and recovery */
  enabled: boolean;
  /** Maximum tabs to track */
  maxTabs: number;
  /** TTL for tracked tabs (ms) */
  ttlMs: number;
};

export type RecoveryResult = {
  recovered: boolean;
  newTargetId?: string;
  reason: string;
};

export const DEFAULT_CONFIG: TabRecoveryConfig = {
  enabled: true,
  maxTabs: 50,
  ttlMs: 3600000, // 1 hour
};

/**
 * Tab Manager
 * 
 * Tracks tabs and provides recovery functionality.
 */
export class TabManager {
  private registry: Map<string, TrackedTab>;
  private config: TabRecoveryConfig;
  private profileName: string;

  constructor(profileName: string, config: Partial<TabRecoveryConfig> = {}) {
    this.profileName = profileName;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.registry = new Map();
  }

  /**
   * Track a tab (add or update in registry)
   */
  track(tab: BrowserTab): void {
    if (!this.config.enabled) {
      return;
    }

    const tracked: TrackedTab = {
      targetId: tab.targetId,
      url: tab.url,
      title: tab.title,
      type: tab.type,
      lastSeen: Date.now(),
    };

    this.registry.set(tab.targetId, tracked);

    // Prune old entries if we exceed maxTabs
    if (this.registry.size > this.config.maxTabs) {
      this.pruneOldest();
    }

    log.debug(
      `[${this.profileName}] Tracked tab ${tab.targetId} (${tab.url}) - registry size: ${this.registry.size}`
    );
  }

  /**
   * Track multiple tabs
   */
  trackMany(tabs: BrowserTab[]): void {
    for (const tab of tabs) {
      this.track(tab);
    }
  }

  /**
   * Update last seen timestamp for a tab
   */
  touch(targetId: string): void {
    const tab = this.registry.get(targetId);
    if (tab) {
      tab.lastSeen = Date.now();
    }
  }

  /**
   * Remove a tab from tracking
   */
  untrack(targetId: string): void {
    this.registry.delete(targetId);
    log.debug(
      `[${this.profileName}] Untracked tab ${targetId} - registry size: ${this.registry.size}`
    );
  }

  /**
   * Get a tracked tab
   */
  get(targetId: string): TrackedTab | undefined {
    return this.registry.get(targetId);
  }

  /**
   * Check if a tab is tracked
   */
  has(targetId: string): boolean {
    return this.registry.has(targetId);
  }

  /**
   * Get all tracked tabs
   */
  getAll(): TrackedTab[] {
    return Array.from(this.registry.values());
  }

  /**
   * Get registry size
   */
  size(): number {
    return this.registry.size;
  }

  /**
   * Attempt to recover a lost tab by URL
   */
  async recover(
    lostTargetId: string,
    currentTabs: BrowserTab[]
  ): Promise<RecoveryResult> {
    if (!this.config.enabled) {
      return {
        recovered: false,
        reason: "Tab recovery disabled",
      };
    }

    // Get tracked info for lost tab
    const tracked = this.registry.get(lostTargetId);
    if (!tracked) {
      return {
        recovered: false,
        reason: "Tab not in registry (was never tracked)",
      };
    }

    log.info(
      `[${this.profileName}] Attempting recovery for tab ${lostTargetId} (${tracked.url})`
    );

    // Try to find by exact URL
    const exactMatch = currentTabs.find((tab) => tab.url === tracked.url);
    if (exactMatch && exactMatch.targetId !== lostTargetId) {
      // Found a tab with same URL but different ID
      log.info(
        `[${this.profileName}] Recovered tab by exact URL: ${lostTargetId} → ${exactMatch.targetId}`
      );

      // Update registry with new target ID
      this.untrack(lostTargetId);
      this.track(exactMatch);

      return {
        recovered: true,
        newTargetId: exactMatch.targetId,
        reason: "Found by exact URL match",
      };
    }

    // Try to find by URL (ignoring hash/query)
    const trackedUrl = this.normalizeUrl(tracked.url);
    const fuzzyMatch = currentTabs.find(
      (tab) => this.normalizeUrl(tab.url) === trackedUrl
    );

    if (fuzzyMatch && fuzzyMatch.targetId !== lostTargetId) {
      log.info(
        `[${this.profileName}] Recovered tab by normalized URL: ${lostTargetId} → ${fuzzyMatch.targetId}`
      );

      this.untrack(lostTargetId);
      this.track(fuzzyMatch);

      return {
        recovered: true,
        newTargetId: fuzzyMatch.targetId,
        reason: "Found by normalized URL match",
      };
    }

    log.warn(
      `[${this.profileName}] Could not recover tab ${lostTargetId} - no matching tab found`
    );

    return {
      recovered: false,
      reason: "No matching tab found in current tabs",
    };
  }

  /**
   * Normalize URL for fuzzy matching (remove hash, query params)
   */
  private normalizeUrl(url: string): string {
    try {
      const parsed = new URL(url);
      // Keep protocol + host + pathname only
      return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
    } catch {
      // If parsing fails, return as-is
      return url;
    }
  }

  /**
   * Prune the oldest tab from registry
   */
  private pruneOldest(): void {
    let oldest: string | null = null;
    let oldestTime = Infinity;

    for (const [targetId, tab] of this.registry.entries()) {
      if (tab.lastSeen < oldestTime) {
        oldestTime = tab.lastSeen;
        oldest = targetId;
      }
    }

    if (oldest) {
      this.registry.delete(oldest);
      log.debug(
        `[${this.profileName}] Pruned oldest tab ${oldest} from registry`
      );
    }
  }

  /**
   * Prune stale tabs (older than TTL)
   */
  pruneStale(): number {
    const now = Date.now();
    const threshold = now - this.config.ttlMs;
    let pruned = 0;

    for (const [targetId, tab] of this.registry.entries()) {
      if (tab.lastSeen < threshold) {
        this.registry.delete(targetId);
        pruned++;
      }
    }

    if (pruned > 0) {
      log.info(
        `[${this.profileName}] Pruned ${pruned} stale tabs from registry`
      );
    }

    return pruned;
  }

  /**
   * Clear all tracked tabs
   */
  clear(): void {
    const size = this.registry.size;
    this.registry.clear();
    log.debug(`[${this.profileName}] Cleared registry (${size} tabs)`);
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<TabRecoveryConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get current configuration
   */
  getConfig(): Readonly<TabRecoveryConfig> {
    return { ...this.config };
  }
}

/**
 * Create a tab manager instance
 */
export function createTabManager(
  profileName: string,
  config?: Partial<TabRecoveryConfig>
): TabManager {
  return new TabManager(profileName, config);
}

/**
 * Format recovery result for logging
 */
export function formatRecoveryResult(
  lostTargetId: string,
  result: RecoveryResult
): string {
  if (result.recovered && result.newTargetId) {
    return `Tab recovery: ${lostTargetId} → ${result.newTargetId} (${result.reason})`;
  }

  return `Tab recovery failed: ${lostTargetId} (${result.reason})`;
}
