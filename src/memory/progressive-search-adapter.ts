import type { ProgressiveMemoryStore, EmbedFn } from "./progressive-store.js";
import type {
  MemorySearchManager,
  MemorySearchResult,
  MemoryProviderStatus,
  MemoryEmbeddingProbeResult,
} from "./types.js";

export class ProgressiveSearchAdapter implements MemorySearchManager {
  constructor(
    private store: ProgressiveMemoryStore,
    private embedFn?: EmbedFn,
  ) {}

  async search(
    query: string,
    opts?: { maxResults?: number; minScore?: number; sessionKey?: string },
  ): Promise<MemorySearchResult[]> {
    const embedding = this.embedFn ? await this.embedFn(query).catch(() => undefined) : undefined;
    const results = await this.store.searchHybrid(query, embedding, {
      limit: opts?.maxResults ?? 6,
    });
    return results.map((r) => ({
      path: `progressive://${r.id}`,
      startLine: 0,
      endLine: 0,
      score: r.score,
      snippet: r.content.slice(0, 700),
      source: "memory" as const,
    }));
  }

  async readFile(_params: {
    relPath: string;
    from?: number;
    lines?: number;
  }): Promise<{ text: string; path: string }> {
    return { text: "", path: "" };
  }

  status(): MemoryProviderStatus {
    const storeStatus = this.store.status();
    return {
      backend: "builtin",
      provider: "progressive",
      custom: {
        type: "progressive",
        totalEntries: storeStatus.totalEntries,
        vectorEnabled: storeStatus.vectorEnabled,
        ftsEnabled: storeStatus.ftsEnabled,
      },
    };
  }

  async sync(): Promise<void> {
    // no-op — progressive store manages its own data
  }

  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    return { ok: Boolean(this.embedFn) };
  }

  async probeVectorAvailability(): Promise<boolean> {
    return this.store.isVecAvailable;
  }

  async close(): Promise<void> {
    this.store.close();
  }
}
