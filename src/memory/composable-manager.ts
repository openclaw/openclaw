import type { QueryIntent } from "./query/index.js";
import type {
  MemorySearchManager,
  MemorySearchResult,
  MemoryProviderStatus,
  MemoryEmbeddingProbeResult,
  MemorySyncProgressUpdate,
} from "./types.js";
import { memLog } from "./memory-log.js";

export type ComposableBackendEntry = {
  id: string;
  manager: MemorySearchManager;
  weight: number;
  condition?: (intent: QueryIntent) => boolean;
};

export type ComposableManagerConfig = {
  backends: ComposableBackendEntry[];
  intentParser?: (query: string) => QueryIntent;
  primary?: string; // id of primary backend for readFile/sync
};

export class ComposableMemoryManager implements MemorySearchManager {
  private readonly backends: ComposableBackendEntry[];
  private readonly intentParser?: (query: string) => QueryIntent;
  private readonly primaryId?: string;

  constructor(config: ComposableManagerConfig) {
    this.backends = config.backends;
    this.intentParser = config.intentParser;
    this.primaryId = config.primary;
  }

  async search(
    query: string,
    opts?: { maxResults?: number; minScore?: number; sessionKey?: string },
  ): Promise<MemorySearchResult[]> {
    const intent = this.intentParser?.(query);

    // Filter backends by routing condition
    const active = this.backends.filter((b) => !b.condition || (intent && b.condition(intent)));

    if (active.length === 0) {
      return [];
    }

    memLog.debug("composable search: fan-out", {
      query: query.slice(0, 80),
      backends: active.map((b) => b.id),
    });

    // Fan-out in parallel
    const settled = await Promise.allSettled(active.map((b) => b.manager.search(query, opts)));

    // Collect results with backend weights
    type WeightedResult = MemorySearchResult & { _backendWeight: number };
    const allResults: WeightedResult[] = [];

    for (let i = 0; i < settled.length; i++) {
      const result = settled[i];
      if (result.status === "fulfilled") {
        for (const r of result.value) {
          allResults.push({ ...r, _backendWeight: active[i].weight });
        }
      } else {
        memLog.warn("composable search: backend failed", {
          backend: active[i].id,
          error: String(result.reason),
        });
      }
    }

    // Deduplicate by path+startLine+endLine, keep highest weighted score
    const deduped = deduplicateResults(allResults);

    // Sort by weighted score, apply maxResults
    const maxResults = opts?.maxResults ?? 6;
    return deduped.toSorted((a, b) => b.score - a.score).slice(0, maxResults);
  }

  async readFile(params: {
    relPath: string;
    from?: number;
    lines?: number;
  }): Promise<{ text: string; path: string }> {
    const primary = this.getPrimary();
    if (primary) {
      return primary.readFile(params);
    }
    // Try each backend until one succeeds
    for (const b of this.backends) {
      try {
        const result = await b.manager.readFile(params);
        if (result.text) {
          return result;
        }
      } catch {
        // try next
      }
    }
    return { text: "", path: params.relPath };
  }

  status(): MemoryProviderStatus {
    const primary = this.getPrimary();
    const primaryStatus = primary?.status();
    const backendIds = this.backends.map((b) => b.id);
    return {
      backend: primaryStatus?.backend ?? "builtin",
      provider: "composable",
      custom: {
        composable: true,
        backends: backendIds,
        primary: this.primaryId ?? backendIds[0],
        ...primaryStatus?.custom,
      },
    };
  }

  async sync(params?: {
    reason?: string;
    force?: boolean;
    progress?: (update: MemorySyncProgressUpdate) => void;
  }): Promise<void> {
    await Promise.allSettled(this.backends.map((b) => b.manager.sync?.(params)));
  }

  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    const results = await Promise.allSettled(
      this.backends.map((b) => b.manager.probeEmbeddingAvailability()),
    );
    for (const r of results) {
      if (r.status === "fulfilled" && r.value.ok) {
        return { ok: true };
      }
    }
    return { ok: false, error: "no backends have embeddings available" };
  }

  async probeVectorAvailability(): Promise<boolean> {
    const results = await Promise.allSettled(
      this.backends.map((b) => b.manager.probeVectorAvailability()),
    );
    return results.some((r) => r.status === "fulfilled" && r.value);
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.backends.map((b) => b.manager.close?.()));
  }

  private getPrimary(): MemorySearchManager | undefined {
    if (this.primaryId) {
      const found = this.backends.find((b) => b.id === this.primaryId);
      if (found) {
        return found.manager;
      }
    }
    return this.backends[0]?.manager;
  }
}

function deduplicateResults(
  results: Array<MemorySearchResult & { _backendWeight: number }>,
): MemorySearchResult[] {
  const byKey = new Map<string, MemorySearchResult>();

  for (const r of results) {
    const key = `${r.path}:${r.startLine}:${r.endLine}`;
    const weightedScore = r.score * r._backendWeight;
    const existing = byKey.get(key);

    if (!existing || weightedScore > existing.score) {
      const { _backendWeight: _, ...rest } = r;
      byKey.set(key, { ...rest, score: weightedScore });
    }
  }

  return Array.from(byKey.values());
}
