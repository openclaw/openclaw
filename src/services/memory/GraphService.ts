import crypto from "crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Global MCP Session Cache (shared across all GraphService instances)
const MCP_SESSION_CACHE_FILE = path.join(os.tmpdir(), "mindbot-graphiti-mcp-session.txt");

// Queue entry definition
type GraphitiTask = {
  execute: () => Promise<void>;
  name: string;
};

export interface MemoryResult {
  content: string;
  timestamp: string;
  _sourceQuery?: string;
  _boosted?: boolean;
  uuid?: string;
  fact?: string;
  message?: {
    uuid?: string;
    content?: string;
    created_at?: string;
    createdAt?: string;
  };
  text?: string;
}

interface McpToolResult {
  result?: {
    content?: Array<{ text: string }>;
  };
  content?: Array<{ text: string }>;
}

interface GraphNode {
  name?: string;
  summary?: string;
  created_at?: string;
}

interface GraphFact {
  source_name?: string;
  fact?: string;
  target_name?: string;
  created_at?: string;
}

interface GraphEpisode {
  created_at: string;
  body?: string;
}

/**
 * GraphService handles the interaction with the knowledge graph.
 * Connects to the Graphiti MCP Server via HTTP transport.
 */
export class GraphService {
  private mcpBaseURL: string;
  private mcpSessionId: string | null = null;
  private debug: boolean;

  // Static queue for background processing to prevent race conditions
  private static taskQueue: GraphitiTask[] = [];
  private static isProcessing = false;

  constructor(mcpURL: string = "http://localhost:8001", debug: boolean = false) {
    this.mcpBaseURL = mcpURL.trim().replace(/\/+$/, "");
    this.debug = debug;

    // Try to load cached session ID on construction
    try {
      if (fs.existsSync(MCP_SESSION_CACHE_FILE)) {
        const cached = fs.readFileSync(MCP_SESSION_CACHE_FILE, "utf-8").trim();
        if (cached) {
          this.mcpSessionId = cached;
          this.log(`🔑 [GRAPH] Reusing cached MCP Session: ${this.mcpSessionId}`);
        }
      }
    } catch {
      // Ignore cache read errors
    }
  }

  private log(message: string) {
    if (this.debug) {
      process.stderr.write(`${message}\n`);
    }
  }

  /**
   * Enqueues a task for serial background processing.
   * Returns immediately, allowing the main thread to continue.
   *
   * Safety: The `isProcessing` guard works because Node.js is single-threaded.
   * Between the `push()` and the `void processQueue()`, no I/O tick can
   * interleave. `processQueue` drains all items before setting the flag
   * back to false, so new items enqueued during processing are picked up
   * by the existing drain loop's `while` condition.
   */
  private static enqueue(name: string, task: () => Promise<void>) {
    GraphService.taskQueue.push({ name, execute: task });
    if (!GraphService.isProcessing) {
      void GraphService.processQueue();
    }
  }

  private static async processQueue() {
    if (GraphService.isProcessing) {
      return;
    }
    GraphService.isProcessing = true;

    while (GraphService.taskQueue.length > 0) {
      const task = GraphService.taskQueue.shift();
      if (!task) {
        break;
      }

      try {
        await task.execute();
      } catch (e: unknown) {
        process.stderr.write(
          `❌ [GRAPH] Background task '${task.name}' failed: ${e instanceof Error ? e.message : String(e)}\n`,
        );
      }
    }

    GraphService.isProcessing = false;
  }

  /**
   * Ensures we have a valid MCP session.
   * If the session is invalid (400/403), clears cache and retries.
   */
  private async ensureSession(forceRefresh = false): Promise<string> {
    if (this.mcpSessionId && !forceRefresh) {
      return this.mcpSessionId;
    }

    if (forceRefresh) {
      this.log(`🔄 [GRAPH] Forcing new MCP Session...`);
      this.mcpSessionId = null;
      try {
        fs.unlinkSync(MCP_SESSION_CACHE_FILE);
      } catch {
        // Ignore unlink errors
      }
    }

    const url = `${this.mcpBaseURL}/mcp`;
    const payload = {
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "mindbot-core", version: "1.0.0" },
      },
    };

    try {
      // Add timeout to session init
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      }).finally(() => clearTimeout(timeoutId));

      const sessionId = res.headers.get("mcp-session-id");
      if (!sessionId) {
        throw new Error("Server did not provide an mcp-session-id");
      }

      this.mcpSessionId = sessionId;

      // Persist to global cache so other GraphService instances can reuse it
      try {
        const tmpCachePath = `${MCP_SESSION_CACHE_FILE}.${process.pid}.tmp`;
        fs.writeFileSync(tmpCachePath, sessionId, "utf-8");
        fs.renameSync(tmpCachePath, MCP_SESSION_CACHE_FILE);
      } catch {
        // Non-fatal: just log
        this.log(`⚠️ [GRAPH] Failed to cache MCP Session ID`);
      }

      this.log(`🔑 [GRAPH] MCP Session Authenticated: ${this.mcpSessionId}`);
      return this.mcpSessionId;
    } catch (e: unknown) {
      if (e instanceof Error && e.name === "AbortError") {
        throw new Error(`MCP Initialization timed out (5s)`, { cause: e });
      }
      throw new Error(`MCP Initialization failed: ${e instanceof Error ? e.message : String(e)}`, {
        cause: e,
      });
    }
  }

  public getSessionId(): string | null {
    return this.mcpSessionId;
  }

  /**
   * Centralized method to call MCP tools with automatic session recovery.
   */
  private async callMcpTool(
    name: string,
    args: Record<string, unknown>,
    timeoutMs: number = 5000,
    retryCount: number = 0,
  ): Promise<McpToolResult | null> {
    const url = `${this.mcpBaseURL}/mcp`;

    try {
      // Ensure we have a session (force refresh if we are retrying)
      const mcpId = await this.ensureSession(retryCount > 0);

      const payload = {
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method: "tools/call",
        params: {
          name,
          arguments: args,
        },
      };

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "mcp-session-id": mcpId,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      }).finally(() => clearTimeout(timeoutId));

      const text = await res.text();

      // Check for session errors specifically
      if (!res.ok) {
        if (
          (res.status === 400 || res.status === 500) &&
          (text.includes("No valid session ID") || text.includes("session ID provided"))
        ) {
          if (retryCount === 0) {
            this.log(`⚠️ [GRAPH] Stale Session ID detected. Retrying with fresh session...`);
            return this.callMcpTool(name, args, timeoutMs, retryCount + 1);
          }
        }
        throw new Error(`MCP Error (${res.status}): ${text}`);
      }

      return this.parseSSEResult(text);
    } catch (e: unknown) {
      // Bubble up abort errors or max retries
      if (e instanceof Error && e.name === "AbortError") {
        throw e;
      }
      throw e;
    }
  }

  /**
   * Parses a single SSE response text into a JSON object.
   */
  private parseSSEResult(text: string): McpToolResult | null {
    const lines = text.split("\n");
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        try {
          const json = JSON.parse(line.substring(6));
          // Filter out error-like messages or empty results that shouldn't be treated as memories
          const content = json.result?.content || json.content;
          if (content?.[0]?.text?.includes("No relevant nodes found")) {
            return null;
          }
          return json;
        } catch {
          continue;
        }
      }
    }
    return null;
  }

  // REMOVED: addTriplet() - Graphiti automatically extracts entities and relationships from episodes.
  // No need for manual triplet ingestion.

  /**
   * Adds an Episode (raw conversation chunk) to the graph.
   * This is now explicitly NON-BLOCKING (fire-and-forget with queue).
   */
  async addEpisode(
    sessionId: string,
    text: string,
    timestamp?: string,
    options?: { source?: string },
  ): Promise<void> {
    // Capture state needed for execution
    const source = options?.source || "message";

    // Enqueue the actual work
    GraphService.enqueue("addEpisode", async () => {
      try {
        await this.callMcpTool(
          "add_memory",
          {
            name: "Conversation Episode",
            episode_body: text,
            source: source,
            group_id: sessionId,
            created_at: timestamp,
          },
          10000, // 10s timeout
        );
        this.log(`📼 [GRAPH] Episode stored in Graphiti (${text.length} chars)`);
      } catch (e: unknown) {
        process.stderr.write(
          `⚠️ [GRAPH] Episode storage failed: ${e instanceof Error ? e.message : String(e)}\n`,
        );
      }
    });
  }

  /**
   * Adds an Episode and returns a Promise that resolves when the MCP call completes.
   * Unlike addEpisode(), failures are propagated to the caller.
   */
  async addEpisodeAsync(
    sessionId: string,
    text: string,
    timestamp?: string,
    options?: { source?: string },
  ): Promise<void> {
    const source = options?.source || "message";
    await this.callMcpTool(
      "add_memory",
      {
        name: "Conversation Episode",
        episode_body: text,
        source: source,
        group_id: sessionId,
        created_at: timestamp,
      },
      10000,
    );
    this.log(`📼 [GRAPH] Episode stored in Graphiti (${text.length} chars)`);
  }

  /**
   * Sanitizes queries to prevent RediSearch syntax errors on punctuation.
   */
  private sanitizeQuery(query: string): string {
    return query
      .replace(/[^\p{L}\p{N}\s\-_]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  /**
   * Breadth-First Search (BFS) using search_nodes tool.
   * This retrieves node-level summaries and context.
   */
  async searchNodes(sessionId: string | string[], query: string): Promise<MemoryResult[]> {
    const groupIds = Array.isArray(sessionId) ? sessionId : [sessionId];
    const safeQuery = this.sanitizeQuery(query);

    try {
      const data = await this.callMcpTool("search_nodes", {
        query: safeQuery,
        group_ids: groupIds,
        max_nodes: 50,
      });

      if (!data) {
        return [];
      }

      const content = data.result?.content || data.content || [];
      const results = content as Array<Record<string, unknown>>;

      // Filter out internal Graphiti "no results" objects
      const filteredResults = results.filter((c: Record<string, unknown>) => {
        const str = JSON.stringify(c);
        return !str.includes("No relevant nodes found") && !str.includes("no_relevant_nodes");
      });

      const allMatches: Array<{
        content: string;
        timestamp: string;
        _sourceQuery: string;
        _boosted: boolean;
      }> = [];
      for (const c of filteredResults) {
        try {
          const cText = c.text as string | undefined;
          if (cText) {
            const parsed = JSON.parse(cText) as { nodes?: GraphNode[] };
            if (parsed.nodes && Array.isArray(parsed.nodes)) {
              for (const n of parsed.nodes) {
                allMatches.push({
                  content: n.summary || n.name || "Unknown memory",
                  timestamp: (n.created_at || c.created_at) as string,
                  _sourceQuery: `Graph Nodes (${query.substring(0, 30)}...)`,
                  _boosted: true,
                });
              }
              continue;
            }
          }
          allMatches.push({
            content:
              (c.summary as string) ||
              (c.name as string) ||
              (typeof c === "string" ? c : JSON.stringify(c)),
            timestamp: c.created_at as string,
            _sourceQuery: `Graph Nodes (${query.substring(0, 30)}...)`,
            _boosted: true,
          });
        } catch {
          allMatches.push({
            content: typeof c === "string" ? c : JSON.stringify(c),
            timestamp: c.created_at as string,
            _sourceQuery: `Graph Nodes (${query.substring(0, 30)}...)`,
            _boosted: true,
          });
        }
      }

      return allMatches;
    } catch (e: unknown) {
      if (e instanceof Error && e.name === "AbortError") {
        process.stderr.write(`⚠️ [GRAPH] Node Search timed out (5s)\n`);
        return [];
      }
      process.stderr.write(
        `❌ [GRAPH] Node Search error: ${e instanceof Error ? e.message : String(e)}\n`,
      );
      return [];
    }
  }

  /**
   * Search specifically for facts (edges) in the graph.
   * This is useful for finding specific relational data.
   */
  async searchFacts(sessionId: string | string[], query: string): Promise<MemoryResult[]> {
    const groupIds = Array.isArray(sessionId) ? sessionId : [sessionId];
    const safeQuery = this.sanitizeQuery(query);

    try {
      const data = await this.callMcpTool("search_memory_facts", {
        query: safeQuery,
        group_ids: groupIds,
      });

      if (!data) {
        return [];
      }

      const content = data.result?.content || data.content || [];
      const results = content as Array<Record<string, unknown>>;

      // Filter out internal Graphiti "no results" objects
      const filteredResults = results.filter((c: Record<string, unknown>) => {
        const str = JSON.stringify(c);
        return !str.includes("No relevant facts found") && !str.includes("no_relevant_facts");
      });

      const allMatches: Array<{
        content: string;
        timestamp: string;
        _sourceQuery: string;
        _boosted: boolean;
      }> = [];
      for (const c of filteredResults) {
        try {
          const cText = c.text as string | undefined;
          if (cText) {
            const parsed = JSON.parse(cText) as { facts?: GraphFact[] };
            if (parsed.facts && Array.isArray(parsed.facts)) {
              for (const f of parsed.facts) {
                allMatches.push({
                  content:
                    `${f.source_name || ""} ${f.fact || ""} ${f.target_name || ""}`.trim() ||
                    "Unknown fact",
                  timestamp: String(f.created_at || c.created_at),
                  _sourceQuery: `Graph Facts (${query.substring(0, 30)}...)`,
                  _boosted: true,
                });
              }
              continue;
            }
          }
          allMatches.push({
            content:
              (c.content as string) ||
              (c.fact as string) ||
              (typeof c === "string" ? c : JSON.stringify(c)),
            timestamp: String(c.created_at),
            _sourceQuery: `Graph Facts (${query.substring(0, 30)}...)`,
            _boosted: true,
          });
        } catch {
          allMatches.push({
            content: typeof c === "string" ? c : JSON.stringify(c),
            timestamp: String(c.created_at),
            _sourceQuery: `Graph Facts (${query.substring(0, 30)}...)`,
            _boosted: true,
          });
        }
      }

      return allMatches;
    } catch (e: unknown) {
      if (e instanceof Error && e.name === "AbortError") {
        process.stderr.write(`⚠️ [GRAPH] Fact Search timed out (5s)\n`);
        return [];
      }
      process.stderr.write(
        `❌ [GRAPH] Fact Search error: ${e instanceof Error ? e.message : String(e)}\n`,
      );
      return [];
    }
  }

  /**
   * Universal search: combines nodes and facts for a "semantic memory" experience.
   */
  async searchGraph(
    sessionId: string | string[],
    seeds: string[],
    _depth: number = 1,
  ): Promise<MemoryResult[]> {
    if (seeds.length === 0) {
      return [];
    }

    // For now, call nodes search as the primary "resonance" mechanism
    const query = seeds.join(", ");
    this.log(`  🔎 [GRAPH] Exploring graph for: "${query.substring(0, 50)}..."`);

    const nodeResults = await this.searchNodes(sessionId, query);
    const factResults = await this.searchFacts(sessionId, query);

    return [...nodeResults, ...factResults];
  }

  /**
   * Clears the entire graph.
   */
  async clearGraph(sessionId: string) {
    try {
      await this.callMcpTool("clear_graph", { group_ids: [sessionId] });
      this.log(`🧹 [GRAPH] Graph for ${sessionId} cleared via MCP.`);
    } catch (e: unknown) {
      process.stderr.write(
        `❌ [GRAPH] Clear error: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
  }

  /**
   * Retrieves raw episodes created after a specific date.
   * Useful for finding "pending" messages that haven't been narrativized yet.
   */
  async getEpisodesSince(
    sessionId: string,
    since: Date,
    limit: number = 100,
  ): Promise<GraphEpisode[]> {
    try {
      // We fetch all episodes (Graphiti doesn't support date filtering yet) and filter client-side.
      // Optimization: In a real prod scenario, we'd want pagination or a limit.
      const data = await this.callMcpTool(
        "get_episodes",
        {
          group_ids: [sessionId],
          max_episodes: limit,
        },
        10000, // 10s heavy read
      );

      if (!data) {
        return [];
      }

      const rawContent = data.result?.content?.[0]?.text || data.content?.[0]?.text;

      if (!rawContent) {
        this.log(`  📊 [DEBUG] No rawContent in getEpisodesSince. Data: ${JSON.stringify(data)}`);
        return [];
      }

      const episodes = (JSON.parse(rawContent) as { episodes?: GraphEpisode[] }).episodes || [];
      const threshold = since.getTime();

      this.log(
        `  📊 [DEBUG] Found ${episodes.length} total episodes in Graphiti for ${sessionId}.`,
      );

      const filtered = episodes.filter((ep: { created_at: string; body?: string }) => {
        // Exclude the story itself and ensure it's newer

        const epTime = new Date(ep.created_at).getTime();
        return epTime > threshold;
      });

      this.log(
        `  📊 [DEBUG] ${filtered.length} episodes passed threshold (> ${since.toISOString()}).`,
      );
      return filtered;
    } catch (e: unknown) {
      if (e instanceof Error && e.name === "AbortError") {
        process.stderr.write(`⚠️ [GRAPH] Get Episodes timed out (10s)\n`);
        return [];
      }
      process.stderr.write(
        `❌ [GRAPH] Get Pending Episodes error: ${e instanceof Error ? e.message : String(e)}\n`,
      );
      return [];
    }
  }

  /**
   * Retrieves the current Narrative Story node if it exists in the graph.
   */
  async getStory(sessionId: string): Promise<{ content: string; created_at: string } | null> {
    // Search for the special "Narrative Story" node
    const results = await this.searchNodes(sessionId, "Narrative Story Autobiography");
    // We expect a node that explicitly mentions being the story
    const storyNode = results.find(
      (r) =>
        r.content.includes("Narrative Story") ||
        r.content.includes("Autobiography") ||
        r.content.startsWith("<!-- LAST_PROCESSED"),
    );

    if (storyNode) {
      return {
        content: storyNode.content,
        created_at: storyNode.timestamp,
      };
    }
    return null;
  }
}
