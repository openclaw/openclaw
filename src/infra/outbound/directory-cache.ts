import type { ChannelDirectoryEntryKind, ChannelId } from "../../channels/plugins/types.js";
import type { ClawdbotConfig } from "../../config/config.js";

type CacheEntry<T> = {
  value: T;
  fetchedAt: number;
};

export type DirectoryCacheKey = {
  channel: ChannelId;
  accountId?: string | null;
  kind: ChannelDirectoryEntryKind;
  source: "cache" | "live";
};

export function buildDirectoryCacheKey(key: DirectoryCacheKey): string {
  return `${key.channel}:${key.accountId ?? "default"}:${key.kind}:${key.source}`;
}

export class DirectoryCache<T> {
  private readonly cache = new Map<string, CacheEntry<T>>();
  private lastConfigRef: ClawdbotConfig | null = null;

  constructor(private readonly ttlMs: number) {}

  get(key: string, cfg: ClawdbotConfig): T | undefined {
    this.resetIfConfigChanged(cfg);
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.fetchedAt > this.ttlMs) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T, cfg: ClawdbotConfig): void {
    this.resetIfConfigChanged(cfg);
    this.cache.set(key, { value, fetchedAt: Date.now() });
  }

  clear(cfg?: ClawdbotConfig): void {
    this.cache.clear();
    if (cfg) this.lastConfigRef = cfg;
  }

  private resetIfConfigChanged(cfg: ClawdbotConfig): void {
    if (this.lastConfigRef && this.lastConfigRef !== cfg) {
      this.cache.clear();
    }
    this.lastConfigRef = cfg;
  }
}
