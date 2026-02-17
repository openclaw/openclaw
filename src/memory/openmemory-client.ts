/**
 * OpenMemory Client
 *
 * HTTP client for OpenMemory server integration.
 * Provides memory search and write via external OpenMemory instance.
 */

import type {
  MemorySearchManager,
  MemorySearchResult,
  MemoryEmbeddingProbeResult,
  MemorySyncProgressUpdate,
  MemoryProviderStatus,
  MemorySource,
} from "./types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("openmemory");

export interface OpenMemoryConfig {
  url: string;
  userId?: string;
  timeout?: number;
}

/** Sector types supported by OpenMemory */
export type MemorySector = "episodic" | "semantic" | "procedural" | "emotional" | "reflective";

/** Options for adding a memory */
export interface AddMemoryOptions {
  content: string;
  tags?: string[];
  metadata?: {
    source?: string;
    date?: string;
    section?: string;
    sessionKey?: string;
    [key: string]: unknown;
  };
  userId?: string;
}

/** Result from adding a memory */
export interface AddMemoryResult {
  id: string;
  content: string;
  primary_sector: MemorySector;
  sectors: MemorySector[];
  salience: number;
  created_at: number;
}

/** Temporal filter options for search */
export interface TemporalFilter {
  startTime?: number; // Unix timestamp
  endTime?: number; // Unix timestamp
  sector?: MemorySector;
}

interface OpenMemoryMatch {
  id: string;
  content: string;
  score: number;
  primary_sector: string;
  sectors: string[];
  salience: number;
  last_seen_at: number;
  metadata?: {
    source?: string;
    date?: string;
    section?: string;
  };
  tags?: string[];
  path?: string[];
}

interface OpenMemoryQueryResponse {
  query: string;
  matches: OpenMemoryMatch[];
}

interface OpenMemoryHealthResponse {
  ok: boolean;
  version: string;
  embedding: {
    provider: string;
    dimensions: number;
  };
}

interface OpenMemoryStatus {
  isHealthy: boolean;
  version?: string;
  embeddingProvider?: string;
  embeddingDimensions?: number;
  sectorStats?: Array<{ sector: string; count: number; avg_salience: number }>;
}

/**
 * Convert OpenMemory match to OpenClaw MemorySearchResult format
 */
function toMemorySearchResult(match: OpenMemoryMatch): MemorySearchResult {
  // Extract path from metadata or use default
  const path = match.metadata?.source || `openmemory/${match.primary_sector}`;

  return {
    path,
    startLine: 0,
    endLine: 0,
    score: match.score,
    snippet: match.content,
    source: "memory" as MemorySource, // OpenMemory memories map to "memory" source
    citation: `openmemory:${match.id}`,
    importanceScore: match.salience,
  };
}

export class OpenMemoryClient implements MemorySearchManager {
  private readonly url: string;
  private readonly userId: string;
  private readonly timeout: number;
  private cachedStatus: OpenMemoryStatus | null = null;
  private lastStatusCheck = 0;
  private readonly STATUS_CACHE_MS = 30000; // 30 seconds

  constructor(config: OpenMemoryConfig) {
    this.url = config.url.replace(/\/$/, ""); // Remove trailing slash
    this.userId = config.userId || "default";
    this.timeout = config.timeout || 10000;
    log.info(`OpenMemory client initialized: ${this.url}`);
  }

  /**
   * Create an OpenMemory client if configuration is valid
   */
  static async create(config: OpenMemoryConfig): Promise<OpenMemoryClient | null> {
    const client = new OpenMemoryClient(config);

    // Verify server is reachable
    try {
      const health = await client.checkHealth();
      if (!health.ok) {
        log.warn(`OpenMemory server not healthy: ${config.url}`);
        return null;
      }
      log.info(`OpenMemory connected: ${health.version}, ${health.embedding.provider} embeddings`);
      return client;
    } catch {
      log.warn(`OpenMemory server unreachable: ${config.url}`);
      return null;
    }
  }

  /**
   * Search memories via OpenMemory
   */
  async search(
    query: string,
    opts?: {
      maxResults?: number;
      minScore?: number;
      sessionKey?: string;
      temporal?: TemporalFilter;
    },
  ): Promise<MemorySearchResult[]> {
    const limit = opts?.maxResults ?? 10;
    const minScore = opts?.minScore ?? 0.0;

    try {
      const filters: Record<string, unknown> = {
        user_id: this.userId,
        min_score: minScore,
      };

      // Add temporal filters if provided
      if (opts?.temporal?.startTime) {
        filters.startTime = opts.temporal.startTime;
      }
      if (opts?.temporal?.endTime) {
        filters.endTime = opts.temporal.endTime;
      }
      if (opts?.temporal?.sector) {
        filters.sector = opts.temporal.sector;
      }

      const response = await this.fetch("/memory/query", {
        method: "POST",
        body: JSON.stringify({
          query,
          k: limit * 2, // Fetch extra for filtering
          user_id: this.userId,
          filters,
        }),
      });

      if (!response.ok) {
        throw new Error(`OpenMemory query failed: ${response.status}`);
      }

      const data = (await response.json()) as OpenMemoryQueryResponse;

      // Filter by minScore and map to OpenClaw format
      const results = data.matches
        .filter((match) => match.score >= minScore)
        .slice(0, limit)
        .map((match) => toMemorySearchResult(match));

      log.debug(`OpenMemory search: "${query}" returned ${results.length} results`);
      return results;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`OpenMemory search error: ${message}`);
      throw err;
    }
  }

  /**
   * Add a new memory to OpenMemory
   */
  async add(options: AddMemoryOptions): Promise<AddMemoryResult> {
    const { content, tags, metadata, userId } = options;

    try {
      const response = await this.fetch("/memory/add", {
        method: "POST",
        body: JSON.stringify({
          content,
          tags: tags ?? [],
          metadata: {
            ...metadata,
            source: metadata?.source ?? "openclaw",
            date: metadata?.date ?? new Date().toISOString().split("T")[0],
          },
          user_id: userId ?? this.userId,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenMemory add failed: ${response.status} - ${errorText}`);
      }

      const result = (await response.json()) as AddMemoryResult;
      log.info(`OpenMemory: added memory ${result.id} (sector: ${result.primary_sector})`);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`OpenMemory add error: ${message}`);
      throw err;
    }
  }

  /**
   * Reinforce (boost salience of) an existing memory
   */
  async reinforce(memoryId: string, boost?: number): Promise<boolean> {
    try {
      const response = await this.fetch("/memory/reinforce", {
        method: "POST",
        body: JSON.stringify({
          id: memoryId,
          boost: boost ?? 1.0,
        }),
      });

      if (!response.ok) {
        log.warn(`OpenMemory reinforce failed for ${memoryId}: ${response.status}`);
        return false;
      }

      log.debug(`OpenMemory: reinforced memory ${memoryId}`);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`OpenMemory reinforce error: ${message}`);
      return false;
    }
  }

  /**
   * Get related memories via waypoint graph
   */
  async related(
    memoryId: string,
    maxResults: number = 10,
  ): Promise<
    Array<{
      id: string;
      content: string;
      weight: number;
      primary_sector: string;
      salience: number;
    }>
  > {
    try {
      const response = await this.fetch(
        `/memory/related/${memoryId}?max=${maxResults}&user_id=${this.userId}`,
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenMemory related failed: ${response.status} - ${errorText}`);
      }

      const data = (await response.json()) as {
        related: Array<{
          id: string;
          content: string;
          weight: number;
          primary_sector: string;
          salience: number;
        }>;
      };

      log.debug(`OpenMemory: found ${data.related?.length ?? 0} related memories`);
      return data.related ?? [];
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`OpenMemory related error: ${message}`);
      throw err;
    }
  }

  /**
   * Get the URL for this OpenMemory instance
   */
  getUrl(): string {
    return this.url;
  }

  /**
   * Get the userId for this client
   */
  getUserId(): string {
    return this.userId;
  }

  /**
   * Read file - not supported for OpenMemory, returns empty
   */
  async readFile(params: { relPath: string; from?: number; lines?: number }): Promise<{
    text: string;
    path: string;
  }> {
    // OpenMemory doesn't support file reading directly
    // Return empty result with the requested path
    return {
      text: "",
      path: params.relPath,
    };
  }

  /**
   * Get status information
   */
  status(): MemoryProviderStatus {
    const cached = this.cachedStatus;
    const totalChunks = cached?.sectorStats?.reduce((sum, s) => sum + s.count, 0) ?? 0;

    return {
      backend: "openmemory",
      provider: "openmemory",
      model: cached?.embeddingProvider,
      chunks: totalChunks,
      vector: {
        enabled: true,
        available: cached?.isHealthy ?? false,
        dims: cached?.embeddingDimensions,
      },
      custom: {
        openMemoryBackend: true,
        url: this.url,
        version: cached?.version,
        sectors: cached?.sectorStats,
      },
    };
  }

  /**
   * Sync - triggers re-check of OpenMemory status
   */
  async sync(params?: {
    reason?: string;
    force?: boolean;
    progress?: (update: MemorySyncProgressUpdate) => void;
  }): Promise<void> {
    params?.progress?.({ completed: 0, total: 1, label: "Checking OpenMemory status..." });

    try {
      await this.refreshStatus();
      params?.progress?.({ completed: 1, total: 1, label: "OpenMemory status refreshed" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      params?.progress?.({ completed: 0, total: 1, label: `OpenMemory sync failed: ${message}` });
    }
  }

  /**
   * Probe embedding availability
   */
  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    try {
      const health = await this.checkHealth();
      if (health.ok && health.embedding?.provider) {
        return { ok: true };
      }
      return { ok: false, error: "OpenMemory embeddings not configured" };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  }

  /**
   * Probe vector availability
   */
  async probeVectorAvailability(): Promise<boolean> {
    try {
      const health = await this.checkHealth();
      return health.ok && health.embedding?.dimensions > 0;
    } catch {
      return false;
    }
  }

  /**
   * Close client
   */
  async close(): Promise<void> {
    // No persistent connections to close
    log.info("OpenMemory client closed");
  }

  /**
   * Check OpenMemory server health
   */
  private async checkHealth(): Promise<OpenMemoryHealthResponse> {
    const response = await this.fetch("/health");
    if (!response.ok) {
      throw new Error(`Health check failed: ${response.status}`);
    }
    return (await response.json()) as OpenMemoryHealthResponse;
  }

  /**
   * Refresh cached status from OpenMemory
   */
  private async refreshStatus(): Promise<void> {
    const now = Date.now();
    if (this.cachedStatus && now - this.lastStatusCheck < this.STATUS_CACHE_MS) {
      return;
    }

    try {
      const [health, sectors] = await Promise.all([this.checkHealth(), this.fetchSectors()]);

      this.cachedStatus = {
        isHealthy: health.ok,
        version: health.version,
        embeddingProvider: health.embedding?.provider,
        embeddingDimensions: health.embedding?.dimensions,
        sectorStats: sectors,
      };
      this.lastStatusCheck = now;
    } catch {
      this.cachedStatus = { isHealthy: false };
      this.lastStatusCheck = now;
    }
  }

  /**
   * Fetch sector statistics
   */
  private async fetchSectors(): Promise<
    Array<{ sector: string; count: number; avg_salience: number }>
  > {
    try {
      const response = await this.fetch("/sectors");
      if (!response.ok) {
        return [];
      }
      const data = (await response.json()) as {
        stats: Array<{ sector: string; count: number; avg_salience: number }>;
      };
      return data.stats || [];
    } catch {
      return [];
    }
  }

  /**
   * Fetch wrapper with timeout
   */
  private async fetch(path: string, options?: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(`${this.url}${path}`, {
        ...options,
        headers: {
          "Content-Type": "application/json",
          ...(options?.headers as Record<string, string>),
        },
        signal: controller.signal,
      });
      return response;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
