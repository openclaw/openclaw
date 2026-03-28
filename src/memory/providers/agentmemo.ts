/**
 * agentMemo provider for OpenClaw memorySearch
 *
 * Delegates search/read operations to an external agentMemo HTTP service
 * (default: http://localhost:8790).
 *
 * Config path: agents.defaults.memorySearch.provider = "agentmemo"
 * Provider options: agents.defaults.memorySearch.agentmemo.{url,apiKey,namespace}
 *
 * agentMemo project: https://github.com/yxjsxy/agentMemo
 */

import { buildRemoteBaseUrlPolicy, withRemoteHttpResponse } from "../remote-http.js";
import type {
  MemoryEmbeddingProbeResult,
  MemoryProviderStatus,
  MemorySearchManager,
  MemorySearchResult,
} from "../types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AgentMemoProviderConfig = {
  /** Base URL of the agentMemo service (default: http://localhost:8790). */
  url?: string;
  /** Optional bearer token / API key. */
  apiKey?: string;
  /** Namespace to scope memories (default: "openclaw"). */
  namespace?: string;
};

type AgentMemoSearchResponse = {
  results?: AgentMemoSearchResult[];
  data?: AgentMemoSearchResult[];
};

type AgentMemoSearchResult = {
  id: string;
  content?: string;
  text?: string;
  score?: number;
  similarity?: number;
  metadata?: {
    source?: string;
    path?: string;
    start_line?: number;
    end_line?: number;
    [key: string]: unknown;
  };
};

type AgentMemoMemoryResponse = {
  id: string;
  content?: string;
  text?: string;
  metadata?: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL = "http://localhost:8790";
const DEFAULT_NAMESPACE = "openclaw";

// ---------------------------------------------------------------------------
// AgentMemoSearchManager
// ---------------------------------------------------------------------------

export class AgentMemoSearchManager implements MemorySearchManager {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly namespace: string;
  private readonly ssrfPolicy;

  constructor(cfg: AgentMemoProviderConfig) {
    this.baseUrl = cfg.url?.trim().replace(/\/$/, "") || DEFAULT_BASE_URL;
    this.apiKey = cfg.apiKey?.trim() || undefined;
    this.namespace = cfg.namespace?.trim() || DEFAULT_NAMESPACE;
    this.ssrfPolicy = buildRemoteBaseUrlPolicy(this.baseUrl);
  }

  // -------------------------------------------------------------------------
  // MemorySearchManager interface
  // -------------------------------------------------------------------------

  async search(
    query: string,
    opts?: { maxResults?: number; minScore?: number; sessionKey?: string },
  ): Promise<MemorySearchResult[]> {
    const url = `${this.baseUrl}/search`;
    const body = JSON.stringify({
      query,
      namespace: this.namespace,
      limit: opts?.maxResults ?? 6,
      min_score: opts?.minScore ?? 0.35,
    });

    return await withRemoteHttpResponse<MemorySearchResult[]>({
      url,
      init: {
        method: "POST",
        headers: this.buildHeaders(true),
        body,
      },
      ssrfPolicy: this.ssrfPolicy,
      auditContext: "agentmemo-search",
      onResponse: async (response) => {
        if (!response.ok) {
          throw new Error(
            `agentMemo search failed: HTTP ${response.status} ${response.statusText}`,
          );
        }
        const data: AgentMemoSearchResponse = await response.json();
        const items = data.results ?? data.data ?? [];
        return items.map(
          (item): MemorySearchResult => ({
            path: item.id ?? item.metadata?.path ?? "",
            startLine: typeof item.metadata?.start_line === "number" ? item.metadata.start_line : 1,
            endLine:
              typeof item.metadata?.end_line === "number"
                ? Math.max(item.metadata.end_line, item.metadata?.start_line ?? 1)
                : typeof item.metadata?.start_line === "number"
                  ? item.metadata.start_line
                  : 1,
            score: item.score ?? item.similarity ?? 0,
            snippet: item.content ?? item.text ?? "",
            source: "memory",
            citation: item.metadata?.source ? String(item.metadata.source) : undefined,
          }),
        );
      },
    });
  }

  async readFile(params: {
    relPath: string;
    from?: number;
    lines?: number;
  }): Promise<{ text: string; path: string }> {
    const encodedId = encodeURIComponent(params.relPath);
    const url = `${this.baseUrl}/memories/${encodedId}`;

    return await withRemoteHttpResponse<{ text: string; path: string }>({
      url,
      init: {
        method: "GET",
        headers: this.buildHeaders(),
      },
      ssrfPolicy: this.ssrfPolicy,
      auditContext: "agentmemo-readfile",
      onResponse: async (response) => {
        if (response.status === 404) {
          return { text: "", path: params.relPath };
        }
        if (!response.ok) {
          throw new Error(
            `agentMemo readFile failed: HTTP ${response.status} ${response.statusText}`,
          );
        }
        const data: AgentMemoMemoryResponse = await response.json();
        const fullText = data.content ?? data.text ?? "";
        const lines = fullText.split("\n");
        // memory_get uses 1-based line numbers (consistent with other managers)
        const from = Math.max((params.from ?? 1) - 1, 0);
        const count = params.lines != null ? Math.max(params.lines, 1) : undefined;
        const sliced = count != null ? lines.slice(from, from + count) : lines.slice(from);
        return { text: sliced.join("\n"), path: params.relPath };
      },
    });
  }

  status(): MemoryProviderStatus {
    return {
      backend: "agentmemo",
      provider: "agentmemo",
      model: "external",
      custom: {
        url: this.baseUrl,
        namespace: this.namespace,
      },
    };
  }

  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    try {
      const url = `${this.baseUrl}/health`;
      const result = await withRemoteHttpResponse<boolean>({
        url,
        init: { method: "GET", headers: this.buildHeaders() },
        ssrfPolicy: this.ssrfPolicy,
        auditContext: "agentmemo-probe",
        onResponse: async (response) => response.ok,
      });
      return { ok: result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `agentMemo health check failed: ${message}` };
    }
  }

  async probeVectorAvailability(): Promise<boolean> {
    const probe = await this.probeEmbeddingAvailability();
    return probe.ok;
  }

  async close(): Promise<void> {
    // No persistent connections to release.
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private buildHeaders(withBody = false): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (withBody) {
      headers["Content-Type"] = "application/json";
    }
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createAgentMemoSearchManager(cfg: AgentMemoProviderConfig): AgentMemoSearchManager {
  return new AgentMemoSearchManager(cfg);
}
