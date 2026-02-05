import type { MemoryContentObject } from "../types.js";
import type { GraphitiIngestResponse, GraphitiQueryResponse } from "./adapter.js";
import { memLog } from "../memory-log.js";

export type GraphitiEpisode = {
  id: string;
  text: string;
  source?: string;
  tags?: string[];
  observed_at?: string;
  ingested_at?: string;
  metadata?: Record<string, unknown>;
  provenance?: Record<string, unknown>;
};

export type GraphitiIngestEpisodesRequest = {
  episodes: MemoryContentObject[];
  traceId?: string;
};

export type GraphitiQueryHybridRequest = {
  query: string;
  limit?: number;
  filters?: Record<string, unknown>;
  traceId?: string;
};

export type GraphitiQueryHybridResponse = GraphitiQueryResponse & {
  episodes?: GraphitiEpisode[];
};

export type GraphitiClientOptions = {
  baseUrl: string;
  apiKey?: string;
  fetchFn?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
};

export type GraphitiEpisodeWarning = {
  code: string;
  message: string;
  details?: Record<string, unknown>;
};

function isIsoDate(value?: string): boolean {
  if (!value) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed);
}

export function buildGraphitiEpisode(
  content: MemoryContentObject,
  now: Date,
): { episode: GraphitiEpisode; warnings: GraphitiEpisodeWarning[] } {
  const warnings: GraphitiEpisodeWarning[] = [];
  const temporal = content.temporal ?? content.provenance?.temporal;

  let observedAt = temporal?.observedAt ?? temporal?.createdAt;
  if (observedAt && !isIsoDate(observedAt)) {
    warnings.push({
      code: "graphiti.invalid_observed_at",
      message: "Observed timestamp was invalid; falling back to ingested_at.",
      details: { id: content.id, observedAt },
    });
    observedAt = undefined;
  }

  const ingestedAt = isIsoDate(temporal?.updatedAt) ? temporal?.updatedAt : now.toISOString();

  if (!observedAt && !ingestedAt) {
    warnings.push({
      code: "graphiti.missing_temporal",
      message: "Episode missing observed_at and ingested_at timestamps; defaulting to now.",
      details: { id: content.id },
    });
  }

  const episode: GraphitiEpisode = {
    id: content.id,
    text: content.text ?? "",
    source: content.provenance?.source,
    tags: content.tags,
    observed_at: observedAt,
    ingested_at: ingestedAt,
    metadata: content.metadata,
    provenance: content.provenance ? { ...content.provenance } : undefined,
  };

  return { episode, warnings };
}

export class GraphitiClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => Date;
  private readonly timeoutMs: number;

  constructor(options: GraphitiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.fetchFn = options.fetchFn ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  /** GET /health — lightweight liveness check. */
  async health(): Promise<{ ok: boolean; message?: string }> {
    memLog.debug("graphiti health check", { baseUrl: this.baseUrl });
    try {
      const response = await this.fetchFn(`${this.baseUrl}/health`, {
        method: "GET",
        headers: {
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) {
        const msg = `Graphiti health check failed (${response.status}).`;
        memLog.debug("graphiti health failed", { status: response.status });
        return { ok: false, message: msg };
      }
      const body = (await response.json()) as { ok?: boolean; message?: string };
      memLog.debug("graphiti health ok", { body });
      return { ok: body.ok !== false, message: body.message };
    } catch (err) {
      const msg = `Graphiti health check error: ${String(err)}`;
      memLog.debug("graphiti health error", { error: String(err) });
      return { ok: false, message: msg };
    }
  }

  async ingestEpisodes(request: GraphitiIngestEpisodesRequest): Promise<GraphitiIngestResponse> {
    const now = this.now();
    const warnings: GraphitiEpisodeWarning[] = [];
    const episodes = request.episodes.map((content) => {
      const result = buildGraphitiEpisode(content, now);
      warnings.push(...result.warnings);
      return result.episode;
    });

    memLog.debug("graphiti ingestEpisodes", { count: episodes.length, traceId: request.traceId });

    const response = await this.fetchFn(`${this.baseUrl}/ingestEpisodes`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({ episodes, traceId: request.traceId, warnings }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      memLog.debug("graphiti ingestEpisodes failed", { status: response.status });
      return {
        ok: false,
        nodeCount: 0,
        edgeCount: 0,
        error: `Graphiti ingest failed (${response.status}).`,
      };
    }

    const result = (await response.json()) as GraphitiIngestResponse;
    memLog.debug("graphiti ingestEpisodes ok", {
      nodeCount: result.nodeCount,
      edgeCount: result.edgeCount,
    });
    return result;
  }

  async queryHybrid(request: GraphitiQueryHybridRequest): Promise<GraphitiQueryHybridResponse> {
    memLog.debug("graphiti queryHybrid", { query: request.query, limit: request.limit });

    const response = await this.fetchFn(`${this.baseUrl}/queryHybrid`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      memLog.debug("graphiti queryHybrid failed", { status: response.status });
      return {
        nodes: [],
        edges: [],
        error: `Graphiti query failed (${response.status}).`,
      };
    }

    const result = (await response.json()) as GraphitiQueryHybridResponse;
    memLog.debug("graphiti queryHybrid ok", {
      nodes: result.nodes.length,
      episodes: result.episodes?.length ?? 0,
    });
    return result;
  }

  /** No-op for now; satisfies MemorySearchManager.close(). */
  async close(): Promise<void> {
    // no-op
  }
}
