/**
 * Cortex Memory backend implementation for OpenClaw.
 *
 * This module provides integration with Cortex Memory, a high-performance,
 * persistent, and intelligent long-term memory system for AI agents.
 *
 * @see https://github.com/sopaco/cortex-mem
 */

import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { ResolvedCortexConfig, ResolvedMemoryBackendConfig } from "./backend-config.js";
import type {
  MemoryEmbeddingProbeResult,
  MemoryProviderStatus,
  MemorySearchManager,
  MemorySearchResult,
  MemorySource,
} from "./types.js";

const log = createSubsystemLogger("memory:cortex");

// Types for Cortex Memory API responses
type CortexSearchRequest = {
  query: string;
  thread?: string;
  scope: "session" | "user" | "agent";
  limit: number;
  min_score: number;
};

type CortexSearchResult = {
  uri: string;
  score: number;
  snippet: string;
  content?: string;
  metadata?: Record<string, unknown>;
};

type CortexSearchResponse = {
  results: CortexSearchResult[];
  total: number;
};

type CortexSessionCreateRequest = {
  thread_id: string;
  title?: string;
};

type CortexSessionMessageRequest = {
  role: "user" | "assistant" | "system";
  content: string;
};

type CortexHealthResponse = {
  status: "ok" | "error";
  message?: string;
};

type CortexTenantsResponse = {
  tenants: string[];
};

/**
 * Cortex Memory Manager - implements MemorySearchManager interface.
 *
 * Communicates with cortex-mem-service via REST API to provide:
 * - Semantic vector search with L0/L1/L2 weighted scoring
 * - Session management with automatic memory extraction
 * - Multi-tenant memory isolation
 * - Virtual filesystem memory storage (cortex:// URI scheme)
 */
export class CortexMemoryManager implements MemorySearchManager {
  private readonly config: ResolvedCortexConfig;
  private readonly agentId: string;
  private healthy = false;
  private lastHealthCheck = 0;
  private readonly healthCheckIntervalMs = 60_000; // 1 minute

  private constructor(params: {
    cfg: OpenClawConfig;
    agentId: string;
    resolved: ResolvedCortexConfig;
  }) {
    this.config = params.resolved;
    this.agentId = params.agentId;
  }

  /**
   * Create a new CortexMemoryManager instance.
   * Performs an initial health check to verify connectivity.
   */
  static async create(params: {
    cfg: OpenClawConfig;
    agentId: string;
    resolved: ResolvedMemoryBackendConfig;
  }): Promise<CortexMemoryManager | null> {
    const resolved = params.resolved.cortex;
    if (!resolved) {
      return null;
    }

    const manager = new CortexMemoryManager({
      cfg: params.cfg,
      agentId: params.agentId,
      resolved,
    });

    // Initial health check
    await manager.checkHealth();

    return manager;
  }

  /**
   * Search memories using Cortex Memory's semantic vector search.
   *
   * Uses weighted L0/L1/L2 scoring for optimal relevance:
   * - L0 (Abstract): ~100 tokens, fast positioning (20% weight)
   * - L1 (Overview): ~500-2000 tokens, structured summary (30% weight)
   * - L2 (Detail): Full content, precise matching (50% weight)
   */
  async search(
    query: string,
    opts?: { maxResults?: number; minScore?: number; sessionKey?: string },
  ): Promise<MemorySearchResult[]> {
    const maxResults = opts?.maxResults ?? this.config.maxResults;
    const minScore = opts?.minScore ?? this.config.minScore;
    const thread = opts?.sessionKey;

    const requestBody: CortexSearchRequest = {
      query,
      scope: this.config.scope,
      limit: maxResults,
      min_score: minScore,
      ...(thread && { thread }),
    };

    try {
      const response = await this.fetchApi<CortexSearchResponse>("/api/v2/search", {
        method: "POST",
        body: JSON.stringify(requestBody),
      });

      return response.results.map((result) => this.mapSearchResult(result));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`Cortex search failed: ${message}`);
      throw err;
    }
  }

  /**
   * Read a memory file by its URI.
   * Cortex Memory uses cortex:// URI scheme for virtual filesystem access.
   */
  async readFile(params: {
    relPath: string;
    from?: number;
    lines?: number;
  }): Promise<{ text: string; path: string }> {
    // Convert relPath to cortex:// URI
    const uri = params.relPath.startsWith("cortex://")
      ? params.relPath
      : `cortex://session/${params.relPath}`;

    try {
      const response = await this.fetchApi<{ content: string; uri: string }>(
        `/api/v2/filesystem/read/${encodeURIComponent(uri)}`,
        { method: "GET" },
      );

      let content = response.content;

      // Handle line range if specified
      if (params.from !== undefined || params.lines !== undefined) {
        const lines = content.split("\n");
        const start = params.from ?? 0;
        const end = params.lines !== undefined ? start + params.lines : lines.length;
        content = lines.slice(start, end).join("\n");
      }

      return {
        text: content,
        path: response.uri,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`Cortex readFile failed for ${uri}: ${message}`);
      throw err;
    }
  }

  /**
   * Get status information about the Cortex Memory backend.
   */
  status(): MemoryProviderStatus {
    return {
      backend: "cortex",
      provider: "cortex-mem-service",
      workspaceDir: this.config.serviceUrl,
      sources: this.getSourcesForScope(),
      custom: {
        tenant: this.config.tenant,
        scope: this.config.scope,
        healthy: this.healthy,
        serviceUrl: this.config.serviceUrl,
        autoCreateSession: this.config.autoCreateSession,
        autoExtract: this.config.autoExtract,
      },
      vector: {
        enabled: true,
        available: this.healthy,
      },
    };
  }

  /**
   * Probe embedding availability.
   * Cortex Memory handles embeddings internally via its configured embedding provider.
   */
  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    // Ensure health check is recent
    if (Date.now() - this.lastHealthCheck > this.healthCheckIntervalMs) {
      await this.checkHealth();
    }

    if (!this.healthy) {
      return {
        ok: false,
        error: "Cortex Memory service is not available",
      };
    }

    return { ok: true };
  }

  /**
   * Probe vector availability.
   */
  async probeVectorAvailability(): Promise<boolean> {
    if (Date.now() - this.lastHealthCheck > this.healthCheckIntervalMs) {
      await this.checkHealth();
    }
    return this.healthy;
  }

  /**
   * Close the manager and release resources.
   */
  async close(): Promise<void> {
    // No persistent connections to close for HTTP-based client
    log.debug("Cortex Memory manager closed");
  }

  /**
   * Add a message to a session.
   * Creates the session automatically if autoCreateSession is enabled.
   */
  async addMessage(
    threadId: string,
    role: "user" | "assistant" | "system",
    content: string,
  ): Promise<string> {
    // Create session if needed
    if (this.config.autoCreateSession) {
      try {
        await this.createSession(threadId);
      } catch (err) {
        // Session may already exist, ignore error
        log.debug(`Session ${threadId} may already exist: ${err}`);
      }
    }

    const requestBody: CortexSessionMessageRequest = { role, content };

    const response = await this.fetchApi<{ uri: string }>(`/api/v2/sessions/${threadId}/messages`, {
      method: "POST",
      body: JSON.stringify(requestBody),
    });

    return response.uri;
  }

  /**
   * Create a new session.
   */
  async createSession(threadId: string, title?: string): Promise<void> {
    const requestBody: CortexSessionCreateRequest = {
      thread_id: threadId,
      ...(title && { title }),
    };

    await this.fetchApi("/api/v2/sessions", {
      method: "POST",
      body: JSON.stringify(requestBody),
    });
  }

  /**
   * Close a session and trigger memory extraction.
   */
  async closeSession(threadId: string): Promise<void> {
    await this.fetchApi(`/api/v2/sessions/${threadId}/close`, {
      method: "POST",
      body: JSON.stringify({ auto_save: this.config.autoExtract }),
    });
  }

  /**
   * Trigger memory extraction for a session.
   */
  async extractMemories(threadId: string): Promise<void> {
    await this.fetchApi(`/api/v2/automation/extract/${threadId}`, {
      method: "POST",
      body: JSON.stringify({ auto_save: true }),
    });
  }

  /**
   * Trigger vector indexing for a session.
   */
  async indexSession(threadId: string): Promise<void> {
    await this.fetchApi(`/api/v2/automation/index/${threadId}`, {
      method: "POST",
    });
  }

  /**
   * List all sessions.
   */
  async listSessions(): Promise<Array<{ threadId: string; status: string; createdAt: string }>> {
    const response = await this.fetchApi<{
      sessions: Array<{
        thread_id: string;
        status: string;
        created_at: string;
      }>;
    }>("/api/v2/sessions", { method: "GET" });

    return response.sessions.map((s) => ({
      threadId: s.thread_id,
      status: s.status,
      createdAt: s.created_at,
    }));
  }

  /**
   * List available tenants.
   */
  async listTenants(): Promise<string[]> {
    const response = await this.fetchApi<CortexTenantsResponse>("/api/v2/tenants/tenants", {
      method: "GET",
    });
    return response.tenants;
  }

  // Private methods

  private async checkHealth(): Promise<void> {
    try {
      const response = await this.fetchApi<CortexHealthResponse>("/health", {
        method: "GET",
        timeoutMs: 5000, // Short timeout for health check
      });
      this.healthy = response.status === "ok";
      this.lastHealthCheck = Date.now();
    } catch (err) {
      this.healthy = false;
      this.lastHealthCheck = Date.now();
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`Cortex health check failed: ${message}`);
    }
  }

  private async fetchApi<T>(
    path: string,
    options: {
      method: string;
      body?: string;
      timeoutMs?: number;
    },
  ): Promise<T> {
    const url = `${this.config.serviceUrl}${path}`;
    const timeoutMs = options.timeoutMs ?? this.config.timeoutMs;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Tenant-ID": this.config.tenant,
    };

    if (this.config.apiKey) {
      headers["Authorization"] = `Bearer ${this.config.apiKey}`;
    }

    try {
      const response = await fetch(url, {
        method: options.method,
        headers,
        body: options.body,
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Cortex API error: ${response.status} ${response.statusText} - ${errorText}`,
        );
      }

      return (await response.json()) as T;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private mapSearchResult(result: CortexSearchResult): MemorySearchResult {
    // Parse URI to extract path and line info
    const { path, startLine, endLine } = this.parseCortexUri(result.uri);

    return {
      path,
      startLine,
      endLine,
      score: result.score,
      snippet: result.snippet || "",
      source: this.inferSource(result.uri),
      citation: result.uri,
    };
  }

  private parseCortexUri(uri: string): {
    path: string;
    startLine: number;
    endLine: number;
  } {
    // URI format: cortex://{dimension}/{scope}/timeline/{date}/{time}.md
    // or: cortex://{dimension}/{scope}/{category}/{id}.md
    const parts = uri.replace("cortex://", "").split("/");
    const path = parts.join("/");

    // Default line numbers (Cortex Memory doesn't provide line-level granularity)
    return {
      path,
      startLine: 1,
      endLine: 1,
    };
  }

  private inferSource(uri: string): MemorySource {
    if (uri.includes("/session/") || uri.includes("/sessions/")) {
      return "sessions";
    }
    return "memory";
  }

  private getSourcesForScope(): MemorySource[] {
    switch (this.config.scope) {
      case "session":
        return ["sessions"];
      case "user":
      case "agent":
        return ["memory"];
      default:
        return ["memory", "sessions"];
    }
  }
}
