import type {
  MemorySearchManager,
  MemorySearchResult,
  MemoryProviderStatus,
  MemoryEmbeddingProbeResult,
} from "../types.js";
import type { GraphitiClient } from "./client.js";
import { memLog } from "../memory-log.js";

export class GraphitiSearchAdapter implements MemorySearchManager {
  constructor(private client: GraphitiClient) {}

  async search(
    query: string,
    opts?: { maxResults?: number; minScore?: number; sessionKey?: string },
  ): Promise<MemorySearchResult[]> {
    try {
      const response = await this.client.queryHybrid({
        query,
        limit: opts?.maxResults ?? 6,
      });
      if (response.error) {
        memLog.warn("graphiti search error", { error: response.error });
        return [];
      }
      const results: MemorySearchResult[] = [];
      // Map episodes to search results
      if (response.episodes) {
        for (const ep of response.episodes) {
          results.push({
            path: `graphiti://${ep.id}`,
            startLine: 0,
            endLine: 0,
            score: 1.0,
            snippet: (ep.text ?? "").slice(0, 700),
            source: "memory",
            citation: `[graphiti:${ep.id}]`,
          });
        }
      }
      // Map nodes to search results
      for (const node of response.nodes) {
        const props = node.properties ?? {};
        const text = typeof props.text === "string" ? props.text : node.label;
        results.push({
          path: `graphiti://node/${node.id}`,
          startLine: 0,
          endLine: 0,
          score: 0.8,
          snippet: text.slice(0, 700),
          source: "memory",
          citation: `[graphiti:${node.id}]`,
        });
      }
      return results.slice(0, opts?.maxResults ?? 6);
    } catch (err) {
      memLog.warn("graphiti search failed", { error: String(err) });
      return [];
    }
  }

  async readFile(_params: {
    relPath: string;
    from?: number;
    lines?: number;
  }): Promise<{ text: string; path: string }> {
    return { text: "", path: "" };
  }

  status(): MemoryProviderStatus {
    return {
      backend: "builtin",
      provider: "graphiti",
      custom: { type: "graphiti" },
    };
  }

  async sync(): Promise<void> {
    // no-op — graphiti manages its own sync
  }

  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    return { ok: true };
  }

  async probeVectorAvailability(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {
    await this.client.close?.();
  }
}
