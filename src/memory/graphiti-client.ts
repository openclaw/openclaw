/**
 * HTTP client for Graphiti API
 * @see https://github.com/getzep/graphiti
 */

export const DEFAULT_GRAPHITI_ENDPOINT = "http://localhost:8000";
export const DEFAULT_GRAPHITI_TIMEOUT_MS = 30_000;

export type GraphitiSearchParams = {
  query: string;
  entityTypes?: string[];
  timeRange?: {
    start?: string;
    end?: string;
  };
  limit?: number;
};

export type GraphitiEntity = {
  id: string;
  name: string;
  type?: string;
  summary?: string;
  createdAt?: string;
  updatedAt?: string;
  metadata?: Record<string, unknown>;
};

export type GraphitiRelationship = {
  id: string;
  source: string;
  target: string;
  type?: string;
  summary?: string;
  createdAt?: string;
  metadata?: Record<string, unknown>;
};

export type GraphitiSearchResponse = {
  entities: GraphitiEntity[];
  relationships?: GraphitiRelationship[];
  total?: number;
};

export type GraphitiGraphParams = {
  timestamp?: string;
  entityIds?: string[];
  depth?: number;
};

export type GraphitiGraphResponse = {
  nodes: GraphitiEntity[];
  edges: GraphitiRelationship[];
};

export type GraphitiEntityDetailsResponse = {
  entity: GraphitiEntity;
  neighbors?: GraphitiEntity[];
  relationships?: GraphitiRelationship[];
};

export type GraphitiTimelineResponse = {
  totalEntities?: number;
  totalRelationships?: number;
  earliestTimestamp?: string;
  latestTimestamp?: string;
  stats?: Record<string, unknown>;
};

export type GraphitiClientOptions = {
  endpoint?: string;
  timeout?: number;
};

export class GraphitiClient {
  private readonly endpoint: string;
  private readonly timeout: number;

  constructor(options: GraphitiClientOptions = {}) {
    this.endpoint = options.endpoint?.replace(/\/$/, "") || DEFAULT_GRAPHITI_ENDPOINT;
    this.timeout = options.timeout ?? DEFAULT_GRAPHITI_TIMEOUT_MS;
  }

  /**
   * Health check for Graphiti service
   */
  async health(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);

      const url = `${this.endpoint}/health`;
      const res = await fetch(url, {
        method: "GET",
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      return res.ok;
    } catch (err) {
      return false;
    }
  }

  /**
   * Search for entities in the temporal knowledge graph
   */
  async search(params: GraphitiSearchParams): Promise<GraphitiSearchResponse> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const url = new URL(`${this.endpoint}/entities/search`);
      url.searchParams.set("query", params.query);
      if (params.entityTypes && params.entityTypes.length > 0) {
        url.searchParams.set("entity_types", params.entityTypes.join(","));
      }
      if (params.timeRange?.start) {
        url.searchParams.set("start", params.timeRange.start);
      }
      if (params.timeRange?.end) {
        url.searchParams.set("end", params.timeRange.end);
      }
      if (params.limit !== undefined) {
        url.searchParams.set("limit", params.limit.toString());
      }

      const res = await fetch(url.toString(), {
        method: "GET",
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`graphiti search failed: ${res.status} ${text}`);
      }

      const data = (await res.json()) as {
        entities?: Array<{
          id?: string;
          name?: string;
          type?: string;
          summary?: string;
          created_at?: string;
          updated_at?: string;
          metadata?: Record<string, unknown>;
        }>;
        relationships?: Array<{
          id?: string;
          source?: string;
          target?: string;
          type?: string;
          summary?: string;
          created_at?: string;
          metadata?: Record<string, unknown>;
        }>;
        total?: number;
      };

      return {
        entities: (data.entities ?? []).map((e) => ({
          id: e.id ?? "",
          name: e.name ?? "",
          type: e.type,
          summary: e.summary,
          createdAt: e.created_at,
          updatedAt: e.updated_at,
          metadata: e.metadata,
        })),
        relationships: data.relationships?.map((r) => ({
          id: r.id ?? "",
          source: r.source ?? "",
          target: r.target ?? "",
          type: r.type,
          summary: r.summary,
          createdAt: r.created_at,
          metadata: r.metadata,
        })),
        total: data.total,
      };
    } catch (err) {
      clearTimeout(timeoutId);
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`graphiti search timeout after ${this.timeout}ms`);
      }
      throw err;
    }
  }

  /**
   * Get graph at a specific point in time
   */
  async getGraph(params: GraphitiGraphParams = {}): Promise<GraphitiGraphResponse> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const url = new URL(`${this.endpoint}/graph`);
      if (params.timestamp) {
        url.searchParams.set("timestamp", params.timestamp);
      }
      if (params.entityIds && params.entityIds.length > 0) {
        url.searchParams.set("entity_ids", params.entityIds.join(","));
      }
      if (params.depth !== undefined) {
        url.searchParams.set("depth", params.depth.toString());
      }

      const res = await fetch(url.toString(), {
        method: "GET",
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`graphiti get graph failed: ${res.status} ${text}`);
      }

      const data = (await res.json()) as {
        nodes?: Array<{
          id?: string;
          name?: string;
          type?: string;
          summary?: string;
          created_at?: string;
          updated_at?: string;
          metadata?: Record<string, unknown>;
        }>;
        edges?: Array<{
          id?: string;
          source?: string;
          target?: string;
          type?: string;
          summary?: string;
          created_at?: string;
          metadata?: Record<string, unknown>;
        }>;
      };

      return {
        nodes: (data.nodes ?? []).map((n) => ({
          id: n.id ?? "",
          name: n.name ?? "",
          type: n.type,
          summary: n.summary,
          createdAt: n.created_at,
          updatedAt: n.updated_at,
          metadata: n.metadata,
        })),
        edges: (data.edges ?? []).map((e) => ({
          id: e.id ?? "",
          source: e.source ?? "",
          target: e.target ?? "",
          type: e.type,
          summary: e.summary,
          createdAt: e.created_at,
          metadata: e.metadata,
        })),
      };
    } catch (err) {
      clearTimeout(timeoutId);
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`graphiti get graph timeout after ${this.timeout}ms`);
      }
      throw err;
    }
  }

  /**
   * Get entity details with neighbors and relationships
   */
  async getEntity(entityId: string): Promise<GraphitiEntityDetailsResponse> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const url = `${this.endpoint}/entities/${encodeURIComponent(entityId)}`;
      const res = await fetch(url, {
        method: "GET",
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`graphiti get entity failed: ${res.status} ${text}`);
      }

      const data = (await res.json()) as {
        entity?: {
          id?: string;
          name?: string;
          type?: string;
          summary?: string;
          created_at?: string;
          updated_at?: string;
          metadata?: Record<string, unknown>;
        };
        neighbors?: Array<{
          id?: string;
          name?: string;
          type?: string;
          summary?: string;
          created_at?: string;
          updated_at?: string;
          metadata?: Record<string, unknown>;
        }>;
        relationships?: Array<{
          id?: string;
          source?: string;
          target?: string;
          type?: string;
          summary?: string;
          created_at?: string;
          metadata?: Record<string, unknown>;
        }>;
      };

      const entity = data.entity ?? { id: "", name: "" };

      return {
        entity: {
          id: entity.id ?? "",
          name: entity.name ?? "",
          type: entity.type,
          summary: entity.summary,
          createdAt: entity.created_at,
          updatedAt: entity.updated_at,
          metadata: entity.metadata,
        },
        neighbors: data.neighbors?.map((n) => ({
          id: n.id ?? "",
          name: n.name ?? "",
          type: n.type,
          summary: n.summary,
          createdAt: n.created_at,
          updatedAt: n.updated_at,
          metadata: n.metadata,
        })),
        relationships: data.relationships?.map((r) => ({
          id: r.id ?? "",
          source: r.source ?? "",
          target: r.target ?? "",
          type: r.type,
          summary: r.summary,
          createdAt: r.created_at,
          metadata: r.metadata,
        })),
      };
    } catch (err) {
      clearTimeout(timeoutId);
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`graphiti get entity timeout after ${this.timeout}ms`);
      }
      throw err;
    }
  }

  /**
   * Get timeline statistics and temporal bounds
   */
  async getTimeline(): Promise<GraphitiTimelineResponse> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const url = `${this.endpoint}/timeline`;
      const res = await fetch(url, {
        method: "GET",
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`graphiti get timeline failed: ${res.status} ${text}`);
      }

      const data = (await res.json()) as {
        total_entities?: number;
        total_relationships?: number;
        earliest_timestamp?: string;
        latest_timestamp?: string;
        stats?: Record<string, unknown>;
      };

      return {
        totalEntities: data.total_entities,
        totalRelationships: data.total_relationships,
        earliestTimestamp: data.earliest_timestamp,
        latestTimestamp: data.latest_timestamp,
        stats: data.stats,
      };
    } catch (err) {
      clearTimeout(timeoutId);
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`graphiti get timeline timeout after ${this.timeout}ms`);
      }
      throw err;
    }
  }
}

/**
 * Create a Graphiti client with the given options
 */
export function createGraphitiClient(options: GraphitiClientOptions = {}): GraphitiClient {
  return new GraphitiClient(options);
}
