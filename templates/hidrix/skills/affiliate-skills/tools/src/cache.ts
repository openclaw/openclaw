/**
 * In-memory program cache with TTL
 * Shared across requests via the persistent daemon
 */

import type { Program } from "./api";

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CacheEntry {
  data: Program[];
  timestamp: number;
  key: string;
}

class ProgramCache {
  private entries: Map<string, CacheEntry> = new Map();
  private maxEntries = 200;

  get(key: string): Program[] | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
      this.entries.delete(key);
      return null;
    }
    return entry.data;
  }

  set(key: string, data: Program[]): void {
    // Evict oldest if at capacity
    if (this.entries.size >= this.maxEntries) {
      const oldest = Array.from(this.entries.entries()).sort(
        (a, b) => a[1].timestamp - b[1].timestamp,
      )[0];
      if (oldest) this.entries.delete(oldest[0]);
    }
    this.entries.set(key, { data, timestamp: Date.now(), key });
  }

  stats(): { entries: number; maxEntries: number; oldestAge: string } {
    let oldestTs = Date.now();
    for (const entry of this.entries.values()) {
      if (entry.timestamp < oldestTs) oldestTs = entry.timestamp;
    }
    const ageMs = this.entries.size > 0 ? Date.now() - oldestTs : 0;
    const ageSec = Math.round(ageMs / 1000);
    const ageStr = ageSec < 60 ? `${ageSec}s` : `${Math.round(ageSec / 60)}m`;
    return {
      entries: this.entries.size,
      maxEntries: this.maxEntries,
      oldestAge: ageStr,
    };
  }

  clear(): void {
    this.entries.clear();
  }
}

export const cache = new ProgramCache();
