import { createSubsystemLogger } from "../logging/subsystem.js";
import type { ResolvedEngramConfig } from "./backend-config.js";
import type {
  MemoryEmbeddingProbeResult,
  MemoryProviderStatus,
  MemorySearchManager,
  MemorySearchResult,
} from "./types.js";

const log = createSubsystemLogger("memory");

/** Shape returned by GET /search on the Engram HTTP API. */
type EngramObservation = {
  id: number;
  session_id: string;
  type: string;
  title: string;
  content: string;
  project: string;
  scope: string;
  revision_count: number;
  duplicate_count: number;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
  rank: number;
};

/** Shape returned by GET /context on the Engram HTTP API. */
type EngramContextResponse = {
  context: string;
};

export class EngramProvider implements MemorySearchManager {
  private readonly config: ResolvedEngramConfig;

  constructor(config: ResolvedEngramConfig) {
    this.config = config;
  }

  async search(
    query: string,
    opts?: { maxResults?: number; minScore?: number; sessionKey?: string },
  ): Promise<MemorySearchResult[]> {
    const limit = opts?.maxResults ?? this.config.maxResults;
    const url = new URL("/search", this.config.url);
    url.searchParams.set("q", query);
    url.searchParams.set("limit", String(limit));
    if (this.config.project) {
      url.searchParams.set("project", this.config.project);
    }

    let observations: EngramObservation[];
    try {
      observations = await this._fetchJson<EngramObservation[]>(url.toString());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`engram search failed (graceful degradation): ${message}`);
      return [];
    }

    if (!Array.isArray(observations)) {
      return [];
    }

    return observations.map((obs): MemorySearchResult => {
      // Normalize rank (engram returns negative FTS rank; higher = better)
      // We invert and normalize to [0, 1] as a best-effort score.
      const rawRank = typeof obs.rank === "number" ? obs.rank : 0;
      const score = rawRank <= 0 ? Math.min(1, Math.abs(rawRank) * 1_000_000) : 0;

      const snippet = `**${obs.title}**: ${obs.content}`;
      return {
        path: `engram://${obs.project}/${obs.id}`,
        startLine: 1,
        endLine: 1,
        score,
        snippet,
        source: "memory",
        citation: obs.title,
      };
    });
  }

  async readFile(params: {
    relPath: string;
    from?: number;
    lines?: number;
  }): Promise<{ text: string; path: string }> {
    // Engram doesn't have file paths — return context instead.
    const url = new URL("/context", this.config.url);
    if (this.config.project) {
      url.searchParams.set("project", this.config.project);
    }

    try {
      const response = await this._fetchJson<EngramContextResponse>(url.toString());
      const text = response?.context ?? "";
      return { text, path: params.relPath };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`engram readFile failed (graceful degradation): ${message}`);
      return { text: "", path: params.relPath };
    }
  }

  status(): MemoryProviderStatus {
    return {
      backend: "engram",
      provider: "engram",
      custom: {
        url: this.config.url,
        project: this.config.project,
        maxResults: this.config.maxResults,
        timeoutMs: this.config.timeoutMs,
      },
    };
  }

  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    // Engram uses FTS internally; no external embedding provider needed.
    return { ok: true };
  }

  async probeVectorAvailability(): Promise<boolean> {
    return false;
  }

  private async _fetchJson<T>(url: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} from Engram: ${url}`);
      }
      return (await response.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }
}
